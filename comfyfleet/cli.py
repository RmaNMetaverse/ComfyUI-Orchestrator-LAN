"""Command line front end: cf status | discover | check | run | cancel | free."""

from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

from . import __version__
from .client import ComfyClient, ComfyError
from .config import ConfigError, FleetCfg, load_fleet, load_job
from .discover import DEFAULT_PORTS, scan
from .preflight import check_machine, format_report, summarize
from .runner import Runner, asset_names, safe_name, write_manifest
from .workflow import Workflow, WorkflowError

DEFAULT_FLEET = "config/nodes.yaml"


def log(msg: str = "") -> None:
    print(msg, flush=True)


def build_clients(fleet: FleetCfg, only: list[str] | None) -> list[ComfyClient]:
    return [
        ComfyClient(m.name, m.host, m.port, m.scheme, timeout=fleet.request_timeout)
        for m in fleet.enabled_machines(only)
    ]


def split_list(value: str | None) -> list[str] | None:
    if not value:
        return None
    return [v.strip() for v in value.split(",") if v.strip()]


# --------------------------------------------------------------------- status


def cmd_status(args: argparse.Namespace) -> int:
    fleet = load_fleet(args.fleet)
    clients = build_clients(fleet, split_list(args.only))
    log(f"Fleet '{fleet.name}' - {len(clients)} machine(s)\n")

    def probe(client: ComfyClient):
        try:
            return client, client.ping(), None
        except ComfyError as exc:
            return client, None, exc

    rows = []
    with ThreadPoolExecutor(max_workers=16) as pool:
        for client, info, error in pool.map(probe, clients):
            rows.append((client, info, error))

    header = f"{'MACHINE':<14} {'ADDRESS':<24} {'STATUS':<9} {'QUEUE':>5}  {'GPU':<28} {'VRAM FREE':>10}  VERSION"
    log(header)
    log("-" * len(header))
    online = 0
    for client, info, error in sorted(rows, key=lambda r: r[0].name):
        if error:
            log(f"{client.name:<14} {client.base_url:<24} {'OFFLINE':<9} {'-':>5}  {'-':<28} {'-':>10}  -")
            if args.verbose:
                log(f"    {error}")
            continue
        online += 1
        log(
            f"{client.name:<14} {client.base_url:<24} {'online':<9} {info['queue']:>5}  "
            f"{info['gpu'][:28]:<28} {str(info['vram_free_gb']) + ' GB':>10}  {info['comfyui_version']}"
        )
    log(f"\n{online}/{len(clients)} online")
    return 0 if online else 1


# ------------------------------------------------------------------ discover


def cmd_discover(args: argparse.Namespace) -> int:
    ports = tuple(int(p) for p in args.ports.split(",")) if args.ports else DEFAULT_PORTS
    log(f"Scanning {args.range} on port(s) {', '.join(map(str, ports))} ...")
    found = scan(args.range, ports=ports, timeout=args.timeout)
    if not found:
        log("No ComfyUI instances answered.")
        log("Remember each machine must listen on 0.0.0.0 (not 127.0.0.1) and allow the port "
            "through Windows Firewall - see tools/Enable-ComfyRemote.ps1")
        return 1
    log(f"\nFound {len(found)}:\n")
    for info in found:
        log(f"  {info['host']}:{info['port']}  {info['gpu']}  "
            f"{info['vram_total_gb']} GB  ComfyUI {info['comfyui_version']}")
    log("\nYAML for config/nodes.yaml:\n")
    log("machines:")
    for i, info in enumerate(found, 1):
        log(f"  - name: GPU-{i:02d}")
        log(f"    host: {info['host']}")
        if info["port"] != 8000:
            log(f"    port: {info['port']}")
        log(f"    note: \"{info['gpu']}\"")
    return 0


# --------------------------------------------------------------------- check


def cmd_check(args: argparse.Namespace) -> int:
    fleet = load_fleet(args.fleet)
    job = load_job(args.job)
    workflow = Workflow.load(job.workflow)
    workflow.apply_overrides(job.overrides)
    clients = build_clients(fleet, split_list(args.only))

    log(f"Job '{job.name}'  workflow={job.workflow.name}  "
        f"nodes={len(workflow.data)}  classes={len(workflow.class_types())}")
    seeds = workflow.seed_nodes()
    log(f"Seed widgets found: {len(seeds)}" + (f" ({', '.join(n for n, _ in seeds)})" if seeds else ""))
    refs = workflow.asset_refs()
    if refs:
        log("Input files referenced: " + ", ".join(sorted({v for _, _, v in refs})))
    log(f"\nChecking {len(clients)} machine(s) - this reads /object_info from each ...\n")

    uploads = asset_names(job)
    with ThreadPoolExecutor(max_workers=12) as pool:
        reports = list(pool.map(lambda c: check_machine(c, workflow, uploads), clients))

    log(format_report(reports))
    ready, blocked = summarize(reports)
    log(f"\n{len(ready)} ready, {len(blocked)} not ready")
    if blocked:
        log("\nFix blocked machines by installing the listed custom nodes (ComfyUI Manager) and "
            "copying the listed model files into the same relative path under ComfyUI/models.")
    return 0 if not blocked else 2


# ----------------------------------------------------------------------- run


def cmd_run(args: argparse.Namespace) -> int:
    fleet = load_fleet(args.fleet)
    job = load_job(args.job)
    if args.count:
        job.count = args.count
    if args.mode:
        job.mode = args.mode
    if args.seed is not None:
        job.seed = args.seed
    if args.dest:
        job.collect_destination = args.dest

    workflow = Workflow.load(job.workflow)
    applied = workflow.apply_overrides(job.overrides)

    clients = build_clients(fleet, split_list(args.only))
    run_id = args.run_id or f"{datetime.now():%Y%m%d-%H%M%S}-{safe_name(job.name)}"

    log(f"ComfyFleet {__version__}")
    log(f"Run     : {run_id}")
    log(f"Workflow: {job.workflow}")
    log(f"Mode    : {job.mode}  count={job.count}  seed={job.seed}")
    if applied:
        for line in applied:
            log(f"Override: {line}")

    if not args.skip_check:
        log("\nPreflight:")
        uploads = asset_names(job)
        with ThreadPoolExecutor(max_workers=12) as pool:
            reports = list(pool.map(lambda c: check_machine(c, workflow, uploads), clients))
        log(format_report(reports))
        ready, blocked = summarize(reports)
        if blocked:
            if args.strict:
                log("\nAborting (--strict) because some machines are not ready.")
                return 2
            log(f"\nSkipping {len(blocked)} machine(s) that are not ready: {', '.join(blocked)}")
        clients = [c for c in clients if c.name in set(ready)]
        if not clients:
            log("\nNo usable machines. Nothing to run.")
            return 1

    dest_root = Path(job.collect_destination or fleet.collect.destination)
    collect = fleet.collect.enabled and not args.no_collect

    if args.dry_run:
        log("\nDry run - would dispatch:")
        per = job.count if job.mode == "mirror" else job.count / max(1, len(clients))
        log(f"  {job.count} task(s) in {job.mode} mode over {len(clients)} machine(s) "
            f"(~{per:.1f} each)")
        log(f"  collect -> {dest_root / run_id}" if collect else "  collection disabled")
        return 0

    runner = Runner(fleet, job, workflow, clients, run_id, log=log, collect=collect, dest_root=dest_root)
    log("")
    runner.upload_assets()
    runner.build_tasks()
    manifest = runner.run()

    log("")
    log(f"Done in {manifest['elapsed_seconds']}s  -  "
        f"{manifest['tasks_succeeded']}/{manifest['tasks_total']} tasks ok, "
        f"{manifest['tasks_failed']} failed, {manifest['files_collected']} file(s) collected")
    for machine, stats in sorted(manifest["machines"].items()):
        avg = stats["seconds"] / max(1, stats["success"] + stats["failed"])
        log(f"  {machine:<14} {stats['success']} ok  {stats['failed']} failed  avg {avg:.0f}s/task")
    for failure in manifest["failures"]:
        log(f"  ! task {failure['task']} on {failure['machine']}: {failure['detail']}")
    for err in manifest["collect_errors"]:
        log(f"  ! download failed: {err}")

    if collect:
        path = write_manifest(manifest, dest_root, run_id)
        log(f"\nOutputs: {dest_root / run_id}")
        if path:
            log(f"Manifest: {path}")
        else:
            log("! could not write run.json (check that the share is writable)")

    if args.json:
        Path(args.json).write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    return 0 if manifest["tasks_failed"] == 0 else 3


# -------------------------------------------------------------------- cancel


def cmd_cancel(args: argparse.Namespace) -> int:
    fleet = load_fleet(args.fleet)
    clients = build_clients(fleet, split_list(args.only))

    def stop(client: ComfyClient) -> str:
        try:
            client.clear_queue()
            client.interrupt()
            return f"  {client.name}: queue cleared, running job interrupted"
        except ComfyError as exc:
            return f"  {client.name}: {exc}"

    with ThreadPoolExecutor(max_workers=16) as pool:
        for line in pool.map(stop, clients):
            log(line)
    return 0


def cmd_gui(_args: argparse.Namespace) -> int:
    from .gui import main as gui_main

    return gui_main()


def cmd_free(args: argparse.Namespace) -> int:
    fleet = load_fleet(args.fleet)
    clients = build_clients(fleet, split_list(args.only))

    def free(client: ComfyClient) -> str:
        try:
            client.free_memory()
            return f"  {client.name}: models unloaded, VRAM freed"
        except ComfyError as exc:
            return f"  {client.name}: {exc}"

    with ThreadPoolExecutor(max_workers=16) as pool:
        for line in pool.map(free, clients):
            log(line)
    return 0


# --------------------------------------------------------------------- parse


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="cf",
        description="Run one ComfyUI workflow across every GPU machine on the LAN.",
    )
    parser.add_argument("--fleet", default=DEFAULT_FLEET, help=f"fleet config (default {DEFAULT_FLEET})")
    parser.add_argument("--version", action="version", version=f"ComfyFleet {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("status", help="ping every machine and show GPU / queue state")
    p.add_argument("--only", help="comma separated machine names")
    p.add_argument("-v", "--verbose", action="store_true")
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("discover", help="scan an IP range for ComfyUI servers")
    p.add_argument("range", help="e.g. 192.168.1.0/24 or 192.168.1.10-60")
    p.add_argument("--ports", help="comma separated (default 8000,8188,8189)")
    p.add_argument("--timeout", type=float, default=1.5)
    p.set_defaults(func=cmd_discover)

    p = sub.add_parser("check", help="verify nodes + models exist on every machine")
    p.add_argument("job", help="path to a job yaml")
    p.add_argument("--only", help="comma separated machine names")
    p.set_defaults(func=cmd_check)

    p = sub.add_parser("run", help="dispatch a job across the fleet and collect outputs")
    p.add_argument("job", help="path to a job yaml")
    p.add_argument("--only", help="comma separated machine names")
    p.add_argument("--count", type=int, help="override the job's count")
    p.add_argument("--mode", choices=["shard", "mirror"], help="override the job's mode")
    p.add_argument("--seed", help="override the job's seed (int, 'random' or 'keep')")
    p.add_argument("--dest", help="override the collection destination")
    p.add_argument("--run-id", help="name this run (default timestamp-job)")
    p.add_argument("--no-collect", action="store_true", help="leave outputs on the machines")
    p.add_argument("--skip-check", action="store_true", help="skip the preflight node/model check")
    p.add_argument("--strict", action="store_true", help="abort if any machine fails preflight")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--json", help="write the run manifest to this path as well")
    p.set_defaults(func=cmd_run)

    p = sub.add_parser("cancel", help="clear queues and interrupt running jobs everywhere")
    p.add_argument("--only", help="comma separated machine names")
    p.set_defaults(func=cmd_cancel)

    p = sub.add_parser("free", help="unload models / free VRAM everywhere")
    p.add_argument("--only", help="comma separated machine names")
    p.set_defaults(func=cmd_free)

    p = sub.add_parser("gui", help="open the desktop window")
    p.set_defaults(func=cmd_gui)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (ConfigError, WorkflowError) as exc:
        log(f"error: {exc}")
        return 2
    except ComfyError as exc:
        log(f"error: {exc}")
        return 2
    except KeyboardInterrupt:
        log("\ninterrupted")
        return 130


if __name__ == "__main__":
    sys.exit(main())
