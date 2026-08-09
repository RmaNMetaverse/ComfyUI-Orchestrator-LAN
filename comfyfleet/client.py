"""Thin wrapper over the ComfyUI HTTP API.

Endpoints used (identical on ComfyUI Desktop, portable and manual installs):
    GET  /system_stats            machine + GPU + version info
    GET  /object_info             every installed node class and its widget enums
    GET  /queue                   running + pending items
    POST /prompt                  queue an API-format workflow
    GET  /history/{prompt_id}     result + produced files for one submission
    GET  /view                    download a produced file
    POST /upload/image            push an input asset into the machine's input/ dir
    POST /interrupt               stop the running job
    POST /free                    unload models / free VRAM
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import requests


class ComfyError(Exception):
    """Any failure talking to a ComfyUI instance."""


class WorkflowRejected(ComfyError):
    """ComfyUI refused the workflow itself - the machine is fine, the graph is not.

    Retrying elsewhere is pointless: every machine will reject it the same way.
    """


@dataclass
class OutputFile:
    filename: str
    subfolder: str
    type: str
    node_id: str
    kind: str  # "images", "gifs", "audio", ...

    @property
    def rel_path(self) -> str:
        return f"{self.subfolder}/{self.filename}" if self.subfolder else self.filename


def format_rejection(data: dict[str, Any], resp: Any = None) -> str:
    """Turn ComfyUI's /prompt error payload into one readable line per bad node."""
    lines: list[str] = []
    for node_id, info in (data.get("node_errors") or {}).items():
        class_type = info.get("class_type", "?")
        for error in info.get("errors") or []:
            detail = error.get("details") or error.get("message") or "invalid"
            lines.append(f"node {node_id} ({class_type}): {detail}")
        if not (info.get("errors") or []):
            lines.append(f"node {node_id} ({class_type}): invalid")
    if lines:
        return "; ".join(lines)
    error = data.get("error") or {}
    if isinstance(error, dict) and error.get("message"):
        detail = error.get("details")
        return f"{error['message']}{f' - {detail}' if detail else ''}"
    if resp is not None:
        return f"HTTP {resp.status_code}: {resp.text[:300]}"
    return json.dumps(data)[:300]


class ComfyClient:
    def __init__(
        self,
        name: str,
        host: str,
        port: int = 8000,
        scheme: str = "http",
        timeout: float = 20.0,
        client_id: str | None = None,
    ) -> None:
        self.name = name
        self.host = host
        self.port = port
        self.scheme = scheme
        self.timeout = timeout
        self.client_id = client_id or str(uuid.uuid4())
        self.base_url = f"{scheme}://{host}:{port}"
        self.session = requests.Session()

    def __repr__(self) -> str:  # pragma: no cover - debug aid
        return f"<ComfyClient {self.name} {self.base_url}>"

    # ------------------------------------------------------------------ http

    def _url(self, path: str) -> str:
        return f"{self.base_url}{path}"

    def _fail(self, verb: str, path: str, exc: Exception) -> ComfyError:
        if isinstance(exc, requests.exceptions.ConnectTimeout):
            reason = "no answer (host up but nothing listening, or blocked by the firewall)"
        elif isinstance(exc, requests.exceptions.ReadTimeout):
            reason = "timed out waiting for a reply"
        elif isinstance(exc, requests.exceptions.ConnectionError):
            reason = "cannot connect (ComfyUI not running, or still bound to 127.0.0.1)"
        else:
            reason = str(exc)
        return ComfyError(f"{self.base_url} {verb} {path}: {reason}")

    def _get(self, path: str, *, params: dict | None = None, timeout: float | None = None,
             stream: bool = False) -> requests.Response:
        try:
            resp = self.session.get(
                self._url(path), params=params, timeout=timeout or self.timeout, stream=stream
            )
        except requests.RequestException as exc:
            raise self._fail("GET", path, exc) from exc
        if resp.status_code >= 400:
            raise ComfyError(f"{self.name}: GET {path} -> HTTP {resp.status_code}: {resp.text[:300]}")
        return resp

    def _post(self, path: str, *, json_body: Any = None, files: Any = None, data: Any = None,
              timeout: float | None = None, check: bool = True) -> requests.Response:
        try:
            resp = self.session.post(
                self._url(path), json=json_body, files=files, data=data,
                timeout=timeout or self.timeout,
            )
        except requests.RequestException as exc:
            raise self._fail("POST", path, exc) from exc
        if check and resp.status_code >= 400:
            raise ComfyError(f"{self.name}: POST {path} -> HTTP {resp.status_code}: {resp.text[:600]}")
        return resp

    # ----------------------------------------------------------------- infoo

    def ping(self) -> dict[str, Any]:
        """Return a small summary dict, or raise ComfyError if unreachable."""
        stats = self._get("/system_stats", timeout=min(self.timeout, 8.0)).json()
        system = stats.get("system", {}) or {}
        devices = stats.get("devices", []) or []
        gpu = devices[0] if devices else {}
        return {
            "name": self.name,
            "url": self.base_url,
            "comfyui_version": system.get("comfyui_version", "?"),
            "python": system.get("python_version", "?").split()[0],
            "os": system.get("os", "?"),
            "gpu": gpu.get("name", "?"),
            "vram_total_gb": round(gpu.get("vram_total", 0) / 1024**3, 1) if gpu.get("vram_total") else 0.0,
            "vram_free_gb": round(gpu.get("vram_free", 0) / 1024**3, 1) if gpu.get("vram_free") else 0.0,
            "queue": self.queue_remaining(),
        }

    def object_info(self) -> dict[str, Any]:
        return self._get("/object_info", timeout=max(self.timeout, 60.0)).json()

    def queue(self) -> dict[str, Any]:
        return self._get("/queue").json()

    def queue_remaining(self) -> int:
        data = self._get("/prompt", timeout=min(self.timeout, 8.0)).json()
        return int((data.get("exec_info") or {}).get("queue_remaining", 0))

    # ------------------------------------------------------------ submission

    def submit(self, prompt: dict[str, Any], extra_data: dict[str, Any] | None = None) -> str:
        body: dict[str, Any] = {"prompt": prompt, "client_id": self.client_id}
        if extra_data:
            body["extra_data"] = extra_data
        resp = self._post("/prompt", json_body=body, timeout=max(self.timeout, 60.0), check=False)
        try:
            data = resp.json()
        except ValueError:
            data = {}
        if resp.status_code >= 400 or data.get("node_errors"):
            raise WorkflowRejected(f"{self.name} rejected the workflow: {format_rejection(data, resp)}")
        prompt_id = data.get("prompt_id")
        if not prompt_id:
            raise ComfyError(f"{self.name}: no prompt_id in response: {data}")
        return str(prompt_id)

    def history(self, prompt_id: str) -> dict[str, Any] | None:
        """None while still queued/running, else the history record."""
        data = self._get(f"/history/{prompt_id}", timeout=min(self.timeout, 15.0)).json()
        return data.get(prompt_id)

    @staticmethod
    def record_status(record: dict[str, Any]) -> tuple[str, str]:
        """(state, detail) where state is 'success' | 'error' | 'running'."""
        status = record.get("status") or {}
        status_str = status.get("status_str")
        if status_str == "success" or (status.get("completed") and status_str != "error"):
            return "success", ""
        if status_str == "error":
            detail = ""
            for message in status.get("messages") or []:
                if isinstance(message, list) and len(message) == 2 and message[0] in (
                    "execution_error", "execution_interrupted",
                ):
                    info = message[1] or {}
                    detail = (
                        f"{info.get('node_type', '?')} #{info.get('node_id', '?')}: "
                        f"{info.get('exception_message', info.get('exception_type', 'unknown error'))}"
                    )
                    break
            return "error", detail or "execution error"
        return "running", ""

    @staticmethod
    def outputs_from_record(record: dict[str, Any]) -> list[OutputFile]:
        found: list[OutputFile] = []
        for node_id, node_out in (record.get("outputs") or {}).items():
            if not isinstance(node_out, dict):
                continue
            for kind, entries in node_out.items():
                if not isinstance(entries, list):
                    continue
                for entry in entries:
                    if isinstance(entry, dict) and entry.get("filename"):
                        found.append(
                            OutputFile(
                                filename=str(entry["filename"]),
                                subfolder=str(entry.get("subfolder", "")),
                                type=str(entry.get("type", "output")),
                                node_id=str(node_id),
                                kind=str(kind),
                            )
                        )
        return found

    # ----------------------------------------------------------------- files

    def download(self, out: OutputFile, dest: Path, overwrite: bool = False) -> Path:
        dest = Path(dest)
        if dest.exists() and not overwrite:
            stem, suffix = dest.stem, dest.suffix
            n = 1
            while dest.exists():
                dest = dest.with_name(f"{stem}_{n}{suffix}")
                n += 1
        dest.parent.mkdir(parents=True, exist_ok=True)
        params = {"filename": out.filename, "subfolder": out.subfolder, "type": out.type}
        resp = self._get("/view", params=params, timeout=max(self.timeout, 300.0), stream=True)
        tmp = dest.with_suffix(dest.suffix + ".part")
        with tmp.open("wb") as fh:
            for chunk in resp.iter_content(chunk_size=1 << 20):
                if chunk:
                    fh.write(chunk)
        tmp.replace(dest)
        return dest

    def upload_asset(self, path: Path, subfolder: str = "", overwrite: bool = True) -> str:
        """Push a file into this machine's input/ folder. Returns the name to use in the workflow."""
        path = Path(path)
        with path.open("rb") as fh:
            files = {"image": (path.name, fh, "application/octet-stream")}
            data = {"type": "input", "overwrite": "true" if overwrite else "false"}
            if subfolder:
                data["subfolder"] = subfolder
            resp = self._post("/upload/image", files=files, data=data, timeout=max(self.timeout, 600.0))
        try:
            info = resp.json()
        except ValueError:
            return path.name
        name = info.get("name", path.name)
        sub = info.get("subfolder", "")
        return f"{sub}/{name}" if sub else name

    # ---------------------------------------------------------------- control

    def interrupt(self) -> None:
        self._post("/interrupt", timeout=min(self.timeout, 10.0))

    def clear_queue(self) -> None:
        self._post("/queue", json_body={"clear": True}, timeout=min(self.timeout, 10.0))

    def cancel_pending(self, prompt_ids: Iterable[str]) -> None:
        ids = list(prompt_ids)
        if ids:
            self._post("/queue", json_body={"delete": ids}, timeout=min(self.timeout, 10.0))

    def free_memory(self, unload_models: bool = True) -> None:
        self._post(
            "/free",
            json_body={"unload_models": unload_models, "free_memory": True},
            timeout=min(self.timeout, 30.0),
        )
