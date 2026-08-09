"""Pre-run verification: does every machine have the nodes and models this workflow needs?"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .client import ComfyClient, ComfyError
from .workflow import Workflow


@dataclass
class MissingValue:
    node_id: str
    class_type: str
    field_name: str
    value: str
    options: list[str] = field(default_factory=list)   # what the machine does have

    def describe(self) -> str:
        text = f"{self.value!r} is not on this machine (node {self.node_id} " \
               f"{self.class_type}.{self.field_name})"
        if self.options:
            sample = ", ".join(self.options[:4])
            if len(self.options) > 4:
                sample += f", +{len(self.options) - 4} more"
            text += f" - it has: {sample}"
        else:
            text += " - it has nothing for that field"
        return text


@dataclass
class MachineReport:
    machine: str
    reachable: bool
    error: str = ""
    comfyui_version: str = "?"
    gpu: str = "?"
    missing_classes: list[str] = field(default_factory=list)
    missing_values: list[MissingValue] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.reachable and not self.missing_classes and not self.missing_values


def _enum_options(spec: Any) -> list[str] | None:
    """Extract the allowed values of a combo widget from an /object_info input spec.

    ComfyUI has shipped three shapes for this over time and they all still appear:
        [["a.safetensors", "b.safetensors"], {...}]      classic
        [{"options": [...]}, {...}]                      dict head
        ["COMBO", {"options": [...], "image_upload": 1}] options in the settings dict
    Missing the third one is how a workflow can pass preflight and then be rejected
    by /prompt for a file the machine does not have.
    """
    if not isinstance(spec, (list, tuple)) or not spec:
        return None
    head = spec[0]
    if isinstance(head, list):
        return [str(v) for v in head if isinstance(v, (str, int, float))]
    if isinstance(head, dict) and isinstance(head.get("options"), list):
        return [str(v) for v in head["options"] if isinstance(v, (str, int, float))]
    if len(spec) > 1 and isinstance(spec[1], dict) and isinstance(spec[1].get("options"), list):
        return [str(v) for v in spec[1]["options"] if isinstance(v, (str, int, float))]
    return None


def check_machine(
    client: ComfyClient,
    workflow: Workflow,
    pending_assets: set[str] | None = None,
) -> MachineReport:
    """pending_assets: input filenames the run will upload, so they are not reported missing."""
    pending_assets = pending_assets or set()
    report = MachineReport(machine=client.name, reachable=False)
    try:
        info = client.ping()
        report.reachable = True
        report.comfyui_version = info["comfyui_version"]
        report.gpu = info["gpu"]
    except ComfyError as exc:
        report.error = str(exc)
        return report

    try:
        object_info = client.object_info()
    except ComfyError as exc:
        report.error = f"could not read /object_info: {exc}"
        return report

    available = set(object_info)
    report.missing_classes = sorted(workflow.class_types() - available)

    for node_id, class_type, field_name, value in workflow.widget_values():
        node_spec = object_info.get(class_type)
        if not node_spec:
            continue  # already reported as a missing class
        inputs = node_spec.get("input") or {}
        spec = (inputs.get("required") or {}).get(field_name) or (inputs.get("optional") or {}).get(field_name)
        options = _enum_options(spec)
        if options is None:
            continue  # free-form widget (text, filename prefix, ...)
        if value not in options and Path(value).name not in pending_assets:
            report.missing_values.append(
                MissingValue(node_id, class_type, field_name, value, options))

    return report


def format_report(reports: list[MachineReport], verbose: bool = False) -> str:
    lines: list[str] = []
    for r in sorted(reports, key=lambda x: x.machine):
        if not r.reachable:
            lines.append(f"  [OFFLINE] {r.machine}: {r.error}")
            continue
        if r.ok:
            lines.append(f"  [  OK   ] {r.machine}  ComfyUI {r.comfyui_version}  {r.gpu}")
            continue
        lines.append(f"  [MISSING] {r.machine}  ComfyUI {r.comfyui_version}  {r.gpu}")
        if r.error:
            lines.append(f"             error: {r.error}")
        for cls in r.missing_classes:
            lines.append(f"             custom node not installed: {cls}")
        for missing in r.missing_values:
            lines.append(f"             {missing.describe()}")
    return "\n".join(lines)


def summarize(reports: list[MachineReport]) -> tuple[list[str], list[str]]:
    """(ready_machine_names, blocked_machine_names)"""
    ready = [r.machine for r in reports if r.ok]
    blocked = [r.machine for r in reports if not r.ok]
    return ready, blocked
