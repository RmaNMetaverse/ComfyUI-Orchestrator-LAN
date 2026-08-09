"""Dispatch one job across the fleet, watch it, and pull the outputs back."""

from __future__ import annotations

import json
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from .client import ComfyClient, ComfyError, OutputFile, WorkflowRejected
from .config import CollectCfg, FleetCfg, JobCfg
from .workflow import Workflow, random_seed

Logger = Callable[[str], None]


_UNSAFE_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]+')


def safe_name(text: str, fallback: str = "job") -> str:
    """Make a string usable as a folder name on Windows and on a LAN share."""
    cleaned = _UNSAFE_NAME.sub("_", text)
    cleaned = re.sub(r"\s+", "_", cleaned).strip("_. ")
    return cleaned[:60] or fallback


def asset_files(job: JobCfg) -> list[Path]:
    """Every concrete file the job wants uploaded to the machines' input/ folders."""
    files: list[Path] = []
    for entry in job.assets:
        if entry.is_dir():
            files.extend(sorted(p for p in entry.rglob("*") if p.is_file()))
        elif entry.is_file():
            files.append(entry)
    return files


def asset_names(job: JobCfg) -> set[str]:
    return {p.name for p in asset_files(job)}


@dataclass
class Task:
    index: int
    seed: int
    pinned: str | None = None       # machine name, for mirror mode
    attempts: int = 0


@dataclass
class InFlight:
    task: Task
    prompt_id: str
    machine: str
    started: float


@dataclass
class TaskResult:
    index: int
    seed: int
    machine: str
    prompt_id: str
    state: str                       # success | error | lost
    detail: str = ""
    seconds: float = 0.0
    files: list[dict[str, Any]] = field(default_factory=list)


class Runner:
    def __init__(
        self,
        fleet: FleetCfg,
        job: JobCfg,
        workflow: Workflow,
        clients: list[ComfyClient],
        run_id: str,
        log: Logger = print,
        collect: bool = True,
        dest_root: Path | None = None,
    ) -> None:
        self.fleet = fleet
        self.job = job
        self.workflow = workflow
        self.clients = {c.name: c for c in clients}
        self.run_id = run_id
        self.log = log
        self.collect_cfg: CollectCfg = fleet.collect
        self.do_collect = collect and self.collect_cfg.enabled
        self.dest_root = Path(
            dest_root or job.collect_destination or self.collect_cfg.destination
        )

        self.base_workflows: dict[str, Workflow] = {}
        self.pending: list[Task] = []
        self.inflight: dict[str, list[InFlight]] = {name: [] for name in self.clients}
        self.offline: set[str] = set()
        self.rejected: dict[str, str] = {}
        self.results: list[TaskResult] = []
        self.collected: list[dict[str, Any]] = []
        self.collect_errors: list[str] = []
        self._lock = threading.Lock()
        self._abort = False
        self._downloads = ThreadPoolExecutor(max_workers=6, thread_name_prefix="collect")
        self._pollers = ThreadPoolExecutor(max_workers=12, thread_name_prefix="poll")

    # --------------------------------------------------------------- assets

    def upload_assets(self) -> None:
        """Push every referenced input file to every machine's input/ folder."""
        for entry in self.job.assets:
            if not entry.exists():
                self.log(f"  ! asset path not found, skipping: {entry}")
        files = asset_files(self.job)

        referenced = {Path(name).name for _, _, name in self.workflow.asset_refs()}
        if referenced:
            known = {p.name for p in files}
            for missing in sorted(referenced - known):
                self.log(
                    f"  ! workflow references input file '{missing}' which is not in the job's "
                    "assets - it must already exist in each machine's ComfyUI/input folder"
                )

        if not files:
            for name in self.clients:
                self.base_workflows[name] = self.workflow
            return

        total_mb = sum(p.stat().st_size for p in files) / 1024**2
        self.log(f"  uploading {len(files)} asset file(s), {total_mb:.1f} MB, to {len(self.clients)} machine(s)")

        def push(client: ComfyClient) -> tuple[str, dict[str, str] | str]:
            mapping: dict[str, str] = {}
            try:
                for path in files:
                    remote = client.upload_asset(path)
                    mapping[path.name] = remote
                return client.name, mapping
            except ComfyError as exc:
                return client.name, str(exc)

        with ThreadPoolExecutor(max_workers=8) as pool:
            for name, result in pool.map(push, self.clients.values()):
                if isinstance(result, str):
                    self.log(f"  ! {name}: asset upload failed: {result}")
                    self.offline.add(name)
                    continue
                wf = self.workflow.clone()
                wf.rewrite_asset_names(result)
                self.base_workflows[name] = wf

    # ---------------------------------------------------------------- tasks

    def build_tasks(self) -> None:
        base = self.job.seed
        if isinstance(base, str) and base.lower() == "keep":
            seeds_fixed = None
        elif isinstance(base, str) and base.lower() == "random":
            seeds_fixed = "random"
        else:
            seeds_fixed = int(base)

        def seed_for(i: int) -> int:
            if seeds_fixed is None:
                return -1                       # leave workflow seeds untouched
            if seeds_fixed == "random":
                return random_seed()
            return int(seeds_fixed) + i

        if self.job.mode == "mirror":
            live = [n for n in self.clients if n not in self.offline]
            seeds = [seed_for(i) for i in range(self.job.count)]
            index = 0
            for i, seed in enumerate(seeds):
                for name in live:
                    self.pending.append(Task(index=index, seed=seed, pinned=name))
                    index += 1
        else:
            for i in range(self.job.count):
                self.pending.append(Task(index=i, seed=seed_for(i)))

    # ------------------------------------------------------------- dispatch

    def _prompt_for(self, machine: str, task: Task) -> dict[str, Any]:
        wf = self.base_workflows.get(machine, self.workflow).clone()
        if task.seed >= 0:
            wf.set_seed(task.seed)
        return wf.data

    def _free_slots(self, machine: str) -> int:
        cfg = next(m for m in self.fleet.machines if m.name == machine)
        return cfg.slots - len(self.inflight[machine])

    def _next_task_for(self, machine: str) -> Task | None:
        for i, task in enumerate(self.pending):
            if task.pinned is None or task.pinned == machine:
                return self.pending.pop(i)
        return None

    def _dispatch(self) -> None:
        for name, client in self.clients.items():
            if name in self.offline or self._abort:
                continue
            while self._free_slots(name) > 0:
                task = self._next_task_for(name)
                if task is None:
                    break
                try:
                    prompt_id = client.submit(
                        self._prompt_for(name, task),
                        extra_data={"comfyfleet": {"run_id": self.run_id, "task": task.index}},
                    )
                except WorkflowRejected as exc:
                    # The graph is wrong, not the machine. Put the task back for a machine that
                    # might accept it; if none do, the run stops with the reason spelled out.
                    self.pending.insert(0, task)
                    self.rejected[name] = str(exc)
                    self.log(f"  x {exc}")
                    self._retire(name, "refused this workflow")
                    break
                except ComfyError as exc:
                    task.attempts += 1
                    self.log(f"  ! {name}: submit failed ({exc})")
                    if task.attempts >= 2 or task.pinned:
                        self.results.append(
                            TaskResult(task.index, task.seed, name, "", "error", f"submit failed: {exc}")
                        )
                    else:
                        self.pending.insert(0, task)
                    self._retire(name, "dropped out - requeueing its work to the rest of the fleet")
                    break
                self.inflight[name].append(InFlight(task, prompt_id, name, time.time()))

    def _retire(self, machine: str, reason: str) -> None:
        """Take a machine out of the rotation and hand its unfinished work back."""
        if machine in self.offline:
            return
        self.offline.add(machine)
        self.log(f"  ! {machine} {reason}")
        for item in self.inflight[machine]:
            if item.task.pinned:
                self.results.append(
                    TaskResult(item.task.index, item.task.seed, machine, item.prompt_id, "lost",
                               "machine unreachable")
                )
            else:
                item.task.pinned = None
                self.pending.insert(0, item.task)
        self.inflight[machine] = []

    # -------------------------------------------------------------- polling

    def _poll_once(self) -> None:
        jobs: list[tuple[str, InFlight]] = [
            (name, item) for name, items in self.inflight.items() for item in items
        ]
        if not jobs:
            return

        def check(pair: tuple[str, InFlight]):
            name, item = pair
            try:
                record = self.clients[name].history(item.prompt_id)
                return name, item, record, None
            except ComfyError as exc:
                return name, item, None, exc

        for name, item, record, error in self._pollers.map(check, jobs):
            if error is not None:
                self._retire(name, "stopped answering - requeueing its work to the rest of the fleet")
                continue
            if record is None:
                if time.time() - item.started > self.fleet.stall_timeout:
                    self.log(f"  ! {name}: task {item.task.index} exceeded stall timeout")
                    self._finish(name, item, "error", "stalled / no history entry", None)
                continue
            state, detail = self.clients[name].record_status(record)
            if state == "running":
                continue
            self._finish(name, item, state, detail, record)

    def _finish(self, machine: str, item: InFlight, state: str, detail: str,
                record: dict[str, Any] | None) -> None:
        if item in self.inflight[machine]:
            self.inflight[machine].remove(item)
        elapsed = time.time() - item.started
        result = TaskResult(item.task.index, item.task.seed, machine, item.prompt_id, state, detail, elapsed)
        self.results.append(result)

        if state == "success":
            files = ComfyClient.outputs_from_record(record or {})
            names = ", ".join(f.filename for f in files[:3]) or "no files"
            if len(files) > 3:
                names += f" (+{len(files) - 3})"
            self.log(f"  + {machine} finished task {item.task.index} in {elapsed:.0f}s -> {names}")
            if self.do_collect and files:
                self._downloads.submit(self._collect_files, machine, item, files)
        else:
            self.log(f"  x {machine} task {item.task.index} failed: {detail}")

    # ------------------------------------------------------------ collecting

    def _dest_for(self, machine: str, item: InFlight, out: OutputFile) -> Path:
        stem = Path(out.filename).stem
        tokens = {
            "run_id": self.run_id,
            "machine": machine,
            "filename": out.filename,
            "stem": stem,
            "ext": Path(out.filename).suffix.lstrip("."),
            "task": f"{item.task.index:04d}",
            "seed": str(item.task.seed),
            "node": out.node_id,
            "kind": out.kind,
            "job": self.job.name,
            "date": datetime.now().strftime("%Y-%m-%d"),
            "subfolder": out.subfolder,
        }
        rel = self.collect_cfg.layout.format(**tokens).replace("\\", "/")
        return self.dest_root.joinpath(*[p for p in rel.split("/") if p])

    def _collect_files(self, machine: str, item: InFlight, files: list[OutputFile]) -> None:
        client = self.clients[machine]
        for out in files:
            if out.type != "output":
                continue  # skip temp previews
            dest = self._dest_for(machine, item, out)
            try:
                written = client.download(out, dest, overwrite=self.collect_cfg.overwrite)
            except (ComfyError, OSError) as exc:
                with self._lock:
                    self.collect_errors.append(f"{machine} {out.filename}: {exc}")
                continue
            with self._lock:
                self.collected.append(
                    {
                        "machine": machine,
                        "task": item.task.index,
                        "seed": item.task.seed,
                        "prompt_id": item.prompt_id,
                        "node": out.node_id,
                        "kind": out.kind,
                        "remote": out.rel_path,
                        "local": str(written),
                        "bytes": written.stat().st_size if written.exists() else 0,
                    }
                )

    # ------------------------------------------------------------------ run

    def run(self) -> dict[str, Any]:
        started = time.time()
        total = len(self.pending)
        self.log(f"  dispatching {total} task(s) across {len(self.clients) - len(self.offline)} machine(s)")
        last_status = 0.0

        try:
            while not self._abort:
                self._dispatch()
                busy = sum(len(v) for v in self.inflight.values())
                if not self.pending and not busy:
                    break
                if len(self.offline) == len(self.clients):
                    if len(self.rejected) == len(self.clients):
                        self.log("  ! every machine refused this workflow, so the problem is the "
                                 "workflow itself, not the machines - nothing was queued")
                    else:
                        self.log("  ! no machines left to run on - stopping")
                    break
                time.sleep(self.fleet.poll_interval)
                self._poll_once()
                if time.time() - last_status >= 15:
                    last_status = time.time()
                    self._print_status(total)
        except KeyboardInterrupt:
            self.log("\n  interrupted - cancelling remote queues ...")
            self.abort()

        # Anything still queued here never ran - report it rather than quietly losing it.
        for task in self.pending:
            self.results.append(
                TaskResult(task.index, task.seed, task.pinned or "-", "", "not run",
                           "no machine was able to accept it")
            )
        self.pending = []

        if self.collected or any(r.state == "success" for r in self.results):
            self.log("  waiting for downloads to finish ...")
        self._downloads.shutdown(wait=True)
        self._pollers.shutdown(wait=True)

        return self._manifest(started, total)

    def _print_status(self, total: int) -> None:
        done = sum(1 for r in self.results if r.state == "success")
        failed = sum(1 for r in self.results if r.state != "success")
        parts = []
        for name in sorted(self.clients):
            if name in self.offline:
                parts.append(f"{name}:offline")
            else:
                parts.append(f"{name}:{len(self.inflight[name])}")
        self.log(f"  [{done}/{total} done, {failed} failed, {len(self.collected)} files] " + "  ".join(parts))

    def abort(self) -> None:
        self._abort = True
        for name, client in self.clients.items():
            if name in self.offline:
                continue
            try:
                client.cancel_pending([i.prompt_id for i in self.inflight[name]])
                client.interrupt()
            except ComfyError:
                pass

    def _manifest(self, started: float, total: int) -> dict[str, Any]:
        elapsed = time.time() - started
        succeeded = [r for r in self.results if r.state == "success"]
        failed = [r for r in self.results if r.state != "success"]
        per_machine: dict[str, dict[str, Any]] = {}
        for r in self.results:
            if r.machine == "-":
                continue  # never reached a machine
            slot = per_machine.setdefault(r.machine, {"success": 0, "failed": 0, "seconds": 0.0})
            slot["success" if r.state == "success" else "failed"] += 1
            slot["seconds"] += r.seconds

        return {
            "run_id": self.run_id,
            "job": self.job.name,
            "workflow": str(self.job.workflow),
            "mode": self.job.mode,
            "started": datetime.fromtimestamp(started).isoformat(timespec="seconds"),
            "elapsed_seconds": round(elapsed, 1),
            "tasks_total": total,
            "tasks_succeeded": len(succeeded),
            "tasks_failed": len(failed),
            "machines": per_machine,
            "offline": sorted(self.offline),
            "rejected": dict(self.rejected),
            "files_collected": len(self.collected),
            "collect_root": str(self.dest_root),
            "collect_errors": self.collect_errors,
            "files": self.collected,
            "failures": [
                {"task": r.index, "machine": r.machine, "state": r.state, "detail": r.detail}
                for r in failed
            ],
        }


def write_manifest(manifest: dict[str, Any], dest_root: Path, run_id: str) -> Path | None:
    try:
        path = Path(dest_root) / run_id / "run.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        return path
    except OSError:
        return None
