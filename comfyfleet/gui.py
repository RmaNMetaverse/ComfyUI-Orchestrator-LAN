"""Desktop front end for ComfyFleet.

    python -m comfyfleet.gui     (or double-click ComfyFleet.cmd)

Everything the CLI does, with a window: register machines, pick a workflow JSON,
choose where the outputs land, then Check / Run / Cancel with a live log.
"""

from __future__ import annotations

import json
import os
import queue
import sys
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Any

import tkinter as tk
from tkinter import filedialog, messagebox, ttk

import yaml

from . import __version__
from .client import ComfyClient, ComfyError
from .config import CollectCfg, FleetCfg, JobCfg, MachineCfg, Override
from .discover import DEFAULT_PORTS, scan
from .preflight import check_machine, summarize
from .runner import Runner, asset_names, safe_name, write_manifest
from .workflow import Workflow, WorkflowError

APP_ROOT = Path(__file__).resolve().parent.parent
FLEET_PATH = APP_ROOT / "config" / "nodes.yaml"
STATE_PATH = APP_ROOT / "config" / "gui_state.json"

CHECK_ON = "✔"
CHECK_OFF = ""


# --------------------------------------------------------------------- dialogs


class ModalDialog(tk.Toplevel):
    """Small blocking dialog; subclasses fill body() and read fields in apply()."""

    def __init__(self, parent: tk.Misc, title: str) -> None:
        super().__init__(parent)
        self.transient(parent)
        self.title(title)
        self.result: Any = None
        frame = ttk.Frame(self, padding=12)
        frame.pack(fill="both", expand=True)
        self.body(frame)
        bar = ttk.Frame(self, padding=(12, 0, 12, 12))
        bar.pack(fill="x")
        ttk.Button(bar, text="Cancel", command=self.destroy).pack(side="right")
        ttk.Button(bar, text="OK", command=self._ok).pack(side="right", padx=(0, 6))
        self.bind("<Return>", lambda _e: self._ok())
        self.bind("<Escape>", lambda _e: self.destroy())
        self.update_idletasks()
        x = parent.winfo_rootx() + (parent.winfo_width() - self.winfo_width()) // 2
        y = parent.winfo_rooty() + 120
        self.geometry(f"+{max(0, x)}+{max(0, y)}")
        self.grab_set()
        self.wait_window(self)

    def body(self, frame: ttk.Frame) -> None:  # pragma: no cover - UI
        raise NotImplementedError

    def apply(self) -> Any:  # pragma: no cover - UI
        raise NotImplementedError

    def _ok(self) -> None:
        try:
            self.result = self.apply()
        except ValueError as exc:
            messagebox.showerror("Invalid input", str(exc), parent=self)
            return
        self.destroy()


class MachineDialog(ModalDialog):
    def __init__(self, parent: tk.Misc, machine: MachineCfg | None = None) -> None:
        self._machine = machine
        super().__init__(parent, "Edit machine" if machine else "Add machine")

    def body(self, frame: ttk.Frame) -> None:
        m = self._machine
        self.name = tk.StringVar(value=m.name if m else "")
        self.host = tk.StringVar(value=m.host if m else "")
        self.port = tk.StringVar(value=str(m.port) if m else "8000")
        self.slots = tk.StringVar(value=str(m.slots) if m else "2")
        self.note = tk.StringVar(value=m.note if m else "")
        self.enabled = tk.BooleanVar(value=m.enabled if m else True)

        rows = [
            ("Name", self.name, "Any label, e.g. GPU-01"),
            ("IP address or hostname", self.host, "e.g. 192.168.1.51"),
            ("Port", self.port, "ComfyUI Desktop = 8000, portable = 8188"),
            ("Parallel slots", self.slots, "Prompts kept queued on this machine"),
            ("Note", self.note, "Optional, e.g. RTX 4090"),
        ]
        for row, (label, var, hint) in enumerate(rows):
            ttk.Label(frame, text=label + ":").grid(row=row, column=0, sticky="e", pady=3, padx=(0, 8))
            entry = ttk.Entry(frame, textvariable=var, width=32)
            entry.grid(row=row, column=1, sticky="we", pady=3)
            ttk.Label(frame, text=hint, foreground="#666").grid(row=row, column=2, sticky="w", padx=(8, 0))
        ttk.Checkbutton(frame, text="Include this machine in runs", variable=self.enabled).grid(
            row=len(rows), column=1, sticky="w", pady=(8, 0)
        )
        frame.columnconfigure(1, weight=1)

    def apply(self) -> MachineCfg:
        host = self.host.get().strip()
        if not host:
            raise ValueError("An IP address or hostname is required.")
        try:
            port = int(self.port.get())
            slots = max(1, int(self.slots.get()))
        except ValueError:
            raise ValueError("Port and slots must be whole numbers.")
        return MachineCfg(
            name=self.name.get().strip() or host,
            host=host,
            port=port,
            slots=slots,
            note=self.note.get().strip(),
            enabled=self.enabled.get(),
        )


class OverrideDialog(ModalDialog):
    def __init__(self, parent: tk.Misc, override: Override | None = None,
                 prefill: tuple[str, str, Any] | None = None) -> None:
        self._override = override
        self._prefill = prefill  # (node_id, field, value)
        super().__init__(parent, "Edit override" if override else "Add override")

    def body(self, frame: ttk.Frame) -> None:
        o = self._override
        if o:
            by = "node" if o.node_id else ("title" if o.title else "class")
            target = o.node_id or o.title or o.class_type or ""
            field_name, value = o.field_name, o.value
        elif self._prefill:
            by, target, (field_name, value) = "node", self._prefill[0], (self._prefill[1], self._prefill[2])
        else:
            by, target, field_name, value = "node", "", "", ""

        self.by = tk.StringVar(value=by)
        self.target = tk.StringVar(value=str(target))
        self.field = tk.StringVar(value=str(field_name))

        ttk.Label(frame, text="Select node by:").grid(row=0, column=0, sticky="e", padx=(0, 8), pady=3)
        picker = ttk.Frame(frame)
        picker.grid(row=0, column=1, sticky="w")
        for text, val in (("node id", "node"), ("title", "title"), ("class", "class")):
            ttk.Radiobutton(picker, text=text, value=val, variable=self.by).pack(side="left", padx=(0, 10))

        ttk.Label(frame, text="Target:").grid(row=1, column=0, sticky="e", padx=(0, 8), pady=3)
        ttk.Entry(frame, textvariable=self.target, width=40).grid(row=1, column=1, sticky="we", pady=3)

        ttk.Label(frame, text="Field:").grid(row=2, column=0, sticky="e", padx=(0, 8), pady=3)
        ttk.Entry(frame, textvariable=self.field, width=40).grid(row=2, column=1, sticky="we", pady=3)

        ttk.Label(frame, text="Value:").grid(row=3, column=0, sticky="ne", padx=(0, 8), pady=3)
        self.value = tk.Text(frame, width=48, height=5, wrap="word")
        self.value.grid(row=3, column=1, sticky="we", pady=3)
        self.value.insert("1.0", "" if value is None else str(value))

        ttk.Label(
            frame,
            text="Numbers are sent as numbers, true/false as booleans, anything else as text.",
            foreground="#666",
        ).grid(row=4, column=1, sticky="w", pady=(6, 0))
        frame.columnconfigure(1, weight=1)

    def apply(self) -> Override:
        target = self.target.get().strip()
        field_name = self.field.get().strip()
        if not target or not field_name:
            raise ValueError("Target and field are both required.")
        raw = self.value.get("1.0", "end").rstrip("\n")
        value = _coerce(raw)
        by = self.by.get()
        return Override(
            field_name=field_name,
            value=value,
            node_id=target if by == "node" else None,
            title=target if by == "title" else None,
            class_type=target if by == "class" else None,
        )


class DiscoverDialog(ModalDialog):
    """Scan a subnet, then let the user tick which instances to add."""

    def __init__(self, parent: tk.Misc) -> None:
        super().__init__(parent, "Find ComfyUI machines")

    def body(self, frame: ttk.Frame) -> None:
        self.range = tk.StringVar(value=_guess_subnet())
        self.ports = tk.StringVar(value=",".join(str(p) for p in DEFAULT_PORTS))
        self.status = tk.StringVar(value="")
        self._found: list[dict[str, Any]] = []

        ttk.Label(frame, text="Address range:").grid(row=0, column=0, sticky="e", padx=(0, 8))
        ttk.Entry(frame, textvariable=self.range, width=26).grid(row=0, column=1, sticky="w")
        ttk.Label(frame, text="Ports:").grid(row=0, column=2, sticky="e", padx=(12, 8))
        ttk.Entry(frame, textvariable=self.ports, width=16).grid(row=0, column=3, sticky="w")
        self.scan_btn = ttk.Button(frame, text="Scan", command=self._scan)
        self.scan_btn.grid(row=0, column=4, padx=(12, 0))

        ttk.Label(frame, text="e.g. 192.168.1.0/24  or  192.168.1.10-60",
                  foreground="#666").grid(row=1, column=1, columnspan=3, sticky="w", pady=(2, 8))

        columns = ("host", "port", "gpu", "vram", "version")
        self.tree = ttk.Treeview(frame, columns=columns, show="headings", height=9, selectmode="extended")
        for col, text, width in (
            ("host", "Address", 130), ("port", "Port", 60), ("gpu", "GPU", 220),
            ("vram", "VRAM", 70), ("version", "ComfyUI", 110),
        ):
            self.tree.heading(col, text=text)
            self.tree.column(col, width=width, anchor="w")
        self.tree.grid(row=2, column=0, columnspan=5, sticky="nsew")
        ttk.Label(frame, textvariable=self.status, foreground="#666").grid(
            row=3, column=0, columnspan=5, sticky="w", pady=(6, 0))
        ttk.Label(frame, text="Select the ones to add (Ctrl or Shift for several), then OK.",
                  foreground="#666").grid(row=4, column=0, columnspan=5, sticky="w")
        frame.columnconfigure(3, weight=1)
        frame.rowconfigure(2, weight=1)

    def _scan(self) -> None:
        spec = self.range.get().strip()
        if not spec:
            return
        try:
            ports = tuple(int(p) for p in self.ports.get().split(",") if p.strip())
        except ValueError:
            messagebox.showerror("Ports", "Ports must be numbers separated by commas.", parent=self)
            return
        self.scan_btn.state(["disabled"])
        self.status.set("scanning ...")
        self.tree.delete(*self.tree.get_children())

        def work() -> None:
            try:
                found = scan(spec, ports=ports)
                error = None
            except Exception as exc:  # noqa: BLE001 - surfaced in the dialog
                found, error = [], str(exc)
            self.after(0, lambda: self._done(found, error))

        threading.Thread(target=work, daemon=True).start()

    def _done(self, found: list[dict[str, Any]], error: str | None) -> None:
        self.scan_btn.state(["!disabled"])
        if error:
            self.status.set(f"scan failed: {error}")
            return
        self._found = found
        for i, info in enumerate(found):
            self.tree.insert("", "end", iid=str(i), values=(
                info["host"], info["port"], info["gpu"],
                f"{info['vram_total_gb']} GB", info["comfyui_version"],
            ))
        self.status.set(f"{len(found)} instance(s) answered" if found else
                        "nothing answered - check that ComfyUI listens on 0.0.0.0 and the firewall allows the port")

    def apply(self) -> list[dict[str, Any]]:
        return [self._found[int(iid)] for iid in self.tree.selection()]


def _coerce(raw: str) -> Any:
    text = raw.strip()
    if text.lower() in ("true", "false"):
        return text.lower() == "true"
    try:
        return int(text)
    except ValueError:
        pass
    try:
        return float(text)
    except ValueError:
        pass
    return raw


def _guess_subnet() -> str:
    import socket

    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("10.255.255.255", 1))
        ip = sock.getsockname()[0]
        sock.close()
        return ".".join(ip.split(".")[:3]) + ".0/24"
    except OSError:
        return "192.168.1.0/24"


# ------------------------------------------------------------------- main app


class ComfyFleetApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title(f"ComfyFleet {__version__}")
        self.geometry("1180x820")
        self.minsize(940, 640)

        style = ttk.Style(self)
        if "vista" in style.theme_names():
            style.theme_use("vista")
        style.configure("Treeview", rowheight=22)

        self.machines: list[MachineCfg] = []
        self.overrides: list[Override] = []
        self.workflow: Workflow | None = None
        self.runner: Runner | None = None
        self.run_thread: threading.Thread | None = None
        self.ui_queue: queue.Queue[tuple[str, Any]] = queue.Queue()
        self.total_tasks = 0
        self.busy = False

        self.workflow_path = tk.StringVar()
        self.assets_path = tk.StringVar()
        self.mode = tk.StringVar(value="shard")
        self.count = tk.StringVar(value="10")
        self.seed_mode = tk.StringVar(value="random")
        self.seed_value = tk.StringVar(value="0")
        self.dest = tk.StringVar(value=str(APP_ROOT / "outputs"))
        self.layout = tk.StringVar(value="{run_id}/{machine}/{filename}")
        self.collect_enabled = tk.BooleanVar(value=True)
        self.overwrite = tk.BooleanVar(value=False)
        self.preflight = tk.BooleanVar(value=True)
        self.progress_text = tk.StringVar(value="idle")

        self._build_ui()
        self._load_fleet()
        self._load_state()
        self.after(120, self._drain_queue)
        self.protocol("WM_DELETE_WINDOW", self._on_close)

    # ------------------------------------------------------------------ build

    def _build_ui(self) -> None:
        outer = ttk.Panedwindow(self, orient="vertical")
        outer.pack(fill="both", expand=True, padx=8, pady=8)

        notebook = self.notebook = ttk.Notebook(outer)
        self.machines_tab = ttk.Frame(notebook, padding=10)
        self.job_tab = ttk.Frame(notebook, padding=10)
        self.output_tab = ttk.Frame(notebook, padding=10)
        notebook.add(self.machines_tab, text="  1. Machines  ")
        notebook.add(self.job_tab, text="  2. Workflow  ")
        notebook.add(self.output_tab, text="  3. Output  ")
        outer.add(notebook, weight=3)

        bottom = ttk.Frame(outer)
        outer.add(bottom, weight=2)

        self._build_machines_tab()
        self._build_job_tab()
        self._build_output_tab()
        self._build_run_area(bottom)

    # -- machines ----------------------------------------------------------

    def _build_machines_tab(self) -> None:
        frame = self.machines_tab
        ttk.Label(frame, text="ComfyUI machines on the network",
                  font=("Segoe UI", 11, "bold")).pack(anchor="w")
        ttk.Label(
            frame,
            text="Each machine must have ComfyUI running with Listen set to 0.0.0.0 and its port "
                 "open in the firewall. Click the first column to include or exclude a machine.",
            foreground="#666", wraplength=1000, justify="left",
        ).pack(anchor="w", pady=(2, 8))

        table = ttk.Frame(frame)
        table.pack(fill="both", expand=True)

        columns = ("use", "name", "address", "status", "gpu", "vram", "queue", "note")
        self.machine_tree = ttk.Treeview(table, columns=columns, show="headings", selectmode="browse")
        for col, text, width, anchor in (
            ("use", "Use", 40, "center"), ("name", "Name", 120, "w"),
            ("address", "Address", 170, "w"), ("status", "Status", 110, "w"),
            ("gpu", "GPU", 220, "w"), ("vram", "Free VRAM", 80, "e"),
            ("queue", "Queue", 55, "e"), ("note", "Note", 160, "w"),
        ):
            self.machine_tree.heading(col, text=text)
            self.machine_tree.column(col, width=width, anchor=anchor, stretch=(col in ("gpu", "note")))
        scroll = ttk.Scrollbar(table, orient="vertical", command=self.machine_tree.yview)
        self.machine_tree.configure(yscrollcommand=scroll.set)
        self.machine_tree.pack(side="left", fill="both", expand=True)
        scroll.pack(side="right", fill="y")
        self.machine_tree.bind("<Button-1>", self._on_machine_click)
        self.machine_tree.bind("<Double-1>", lambda _e: self._edit_machine())

        buttons = ttk.Frame(frame)
        buttons.pack(fill="x", pady=(8, 0))
        for text, command in (
            ("Add machine", self._add_machine),
            ("Edit", self._edit_machine),
            ("Remove", self._remove_machine),
            ("Find on network...", self._discover),
            ("Refresh status", self._refresh_status),
        ):
            ttk.Button(buttons, text=text, command=command).pack(side="left", padx=(0, 6))
        ttk.Button(buttons, text="Save machine list", command=self._save_fleet).pack(side="right")

    # -- workflow ----------------------------------------------------------

    def _build_job_tab(self) -> None:
        frame = self.job_tab
        panes = ttk.Panedwindow(frame, orient="horizontal")
        panes.pack(fill="both", expand=True)

        left = ttk.Frame(panes, padding=(0, 0, 10, 0))
        right = ttk.Frame(panes, padding=(10, 0, 0, 0))
        panes.add(left, weight=3)
        panes.add(right, weight=4)

        ttk.Label(left, text="Workflow", font=("Segoe UI", 11, "bold")).pack(anchor="w")
        ttk.Label(left, text="Exported from ComfyUI with  Workflow -> Export (API)",
                  foreground="#666").pack(anchor="w", pady=(2, 6))
        row = ttk.Frame(left)
        row.pack(fill="x")
        ttk.Entry(row, textvariable=self.workflow_path).pack(side="left", fill="x", expand=True)
        ttk.Button(row, text="Browse...", command=self._pick_workflow).pack(side="left", padx=(6, 0))
        self.workflow_info = ttk.Label(left, text="no workflow loaded", foreground="#666")
        self.workflow_info.pack(anchor="w", pady=(4, 12))

        ttk.Label(left, text="Input files to send with the workflow (optional)",
                  font=("Segoe UI", 10, "bold")).pack(anchor="w")
        ttk.Label(left, text="Videos, reference images, masks and audio the workflow loads. They are "
                             "uploaded to every machine's ComfyUI\\input folder before the run. "
                             "Models do not go here.",
                  foreground="#666", wraplength=420, justify="left").pack(anchor="w", pady=(2, 6))
        ttk.Entry(left, textvariable=self.assets_path).pack(fill="x")
        row = ttk.Frame(left)
        row.pack(fill="x", pady=(4, 0))
        ttk.Button(row, text="Add files...", command=self._pick_asset_files).pack(side="left")
        ttk.Button(row, text="Add folder...", command=self._pick_assets).pack(side="left", padx=6)
        ttk.Button(row, text="Clear", command=lambda: self.assets_path.set("")).pack(side="left")

        ttk.Separator(left).pack(fill="x", pady=12)

        ttk.Label(left, text="How to spread the work", font=("Segoe UI", 10, "bold")).pack(anchor="w")
        ttk.Radiobutton(
            left, variable=self.mode, value="shard",
            text="Split the batch across machines - each run gets its own seed (faster)",
        ).pack(anchor="w", pady=(4, 0))
        ttk.Radiobutton(
            left, variable=self.mode, value="mirror",
            text="Every machine runs the same thing with the same seeds (identical outputs)",
        ).pack(anchor="w")

        row = ttk.Frame(left)
        row.pack(fill="x", pady=(10, 0))
        self.count_label = ttk.Label(row, text="Total generations:")
        self.count_label.pack(side="left")
        ttk.Spinbox(row, from_=1, to=100000, textvariable=self.count, width=8).pack(side="left", padx=(8, 0))
        self.mode.trace_add("write", lambda *_a: self.count_label.configure(
            text="Runs per machine:" if self.mode.get() == "mirror" else "Total generations:"))

        row = ttk.Frame(left)
        row.pack(fill="x", pady=(8, 0))
        ttk.Label(row, text="Seeds:").pack(side="left")
        ttk.Combobox(row, textvariable=self.seed_mode, width=12, state="readonly",
                     values=("random", "fixed", "keep")).pack(side="left", padx=(8, 0))
        self.seed_entry = ttk.Entry(row, textvariable=self.seed_value, width=18)
        self.seed_entry.pack(side="left", padx=(8, 0))
        ttk.Label(row, text="(start value, +1 per run)", foreground="#666").pack(side="left", padx=(6, 0))
        self.seed_mode.trace_add("write", lambda *_a: self._sync_seed_entry())
        self._sync_seed_entry()

        ttk.Separator(left).pack(fill="x", pady=12)

        ttk.Label(left, text="Overrides - change prompts or any widget without editing the JSON",
                  font=("Segoe UI", 10, "bold"), wraplength=430, justify="left").pack(anchor="w")
        self.override_tree = ttk.Treeview(
            left, columns=("by", "target", "field", "value"), show="headings", height=6)
        for col, text, width in (("by", "By", 60), ("target", "Target", 120),
                                 ("field", "Field", 90), ("value", "Value", 200)):
            self.override_tree.heading(col, text=text)
            self.override_tree.column(col, width=width, anchor="w")
        # pack the buttons first so they keep their space when the window is short
        row = ttk.Frame(left)
        row.pack(side="bottom", fill="x")
        ttk.Button(row, text="Add", command=self._add_override).pack(side="left")
        ttk.Button(row, text="Edit", command=self._edit_override).pack(side="left", padx=6)
        ttk.Button(row, text="Remove", command=self._remove_override).pack(side="left")
        self.override_tree.pack(side="bottom", fill="both", expand=True, pady=(6, 6))
        self.override_tree.bind("<Double-1>", lambda _e: self._edit_override())

        # --- right: node inspector
        ttk.Label(right, text="Nodes in this workflow", font=("Segoe UI", 11, "bold")).pack(anchor="w")
        ttk.Label(right, text="Double-click any setting below to override it for this run.",
                  foreground="#666").pack(anchor="w", pady=(2, 6))
        holder = ttk.Frame(right)
        holder.pack(fill="both", expand=True)
        self.node_tree = ttk.Treeview(holder, columns=("value",), show="tree headings")
        self.node_tree.heading("#0", text="Node / setting")
        self.node_tree.heading("value", text="Value")
        self.node_tree.column("#0", width=280, stretch=True)
        self.node_tree.column("value", width=240, stretch=True)
        node_scroll = ttk.Scrollbar(holder, orient="vertical", command=self.node_tree.yview)
        self.node_tree.configure(yscrollcommand=node_scroll.set)
        self.node_tree.pack(side="left", fill="both", expand=True)
        node_scroll.pack(side="right", fill="y")
        self.node_tree.bind("<Double-1>", self._on_node_double_click)

    def _sync_seed_entry(self) -> None:
        state = "normal" if self.seed_mode.get() == "fixed" else "disabled"
        self.seed_entry.configure(state=state)

    # -- output ------------------------------------------------------------

    def _build_output_tab(self) -> None:
        frame = self.output_tab
        ttk.Label(frame, text="Where the finished files are gathered",
                  font=("Segoe UI", 11, "bold")).pack(anchor="w")
        ttk.Label(
            frame,
            text="A LAN share such as \\\\FILESERVER\\ComfyOutputs, or any folder on this computer. "
                 "Every image, video or audio file each machine produces is downloaded here as soon "
                 "as its job finishes.",
            foreground="#666", wraplength=1000, justify="left",
        ).pack(anchor="w", pady=(2, 10))

        ttk.Checkbutton(frame, text="Gather outputs to this location",
                        variable=self.collect_enabled).pack(anchor="w")

        row = ttk.Frame(frame)
        row.pack(fill="x", pady=(8, 0))
        ttk.Label(row, text="Destination:", width=12).pack(side="left")
        ttk.Entry(row, textvariable=self.dest).pack(side="left", fill="x", expand=True)
        ttk.Button(row, text="Browse...", command=self._pick_dest).pack(side="left", padx=(6, 0))
        ttk.Button(row, text="Open", command=self._open_dest).pack(side="left", padx=(6, 0))
        ttk.Label(frame, text="A UNC path can be typed in directly - it does not need a mapped drive.",
                  foreground="#666").pack(anchor="w", padx=(96, 0))

        row = ttk.Frame(frame)
        row.pack(fill="x", pady=(12, 0))
        ttk.Label(row, text="Sub-folders:", width=12).pack(side="left")
        ttk.Combobox(row, textvariable=self.layout, width=52, values=(
            "{run_id}/{machine}/{filename}",
            "{run_id}/{filename}",
            "{date}/{job}/{machine}/{filename}",
            "{run_id}/{machine}/{task}_{seed}_{filename}",
        )).pack(side="left")
        ttk.Label(frame, text="Tokens: {run_id} {machine} {filename} {stem} {ext} {task} {seed} "
                              "{node} {kind} {job} {date}",
                  foreground="#666").pack(anchor="w", padx=(96, 0), pady=(2, 0))

        ttk.Checkbutton(frame, text="Overwrite files with the same name (otherwise a suffix is added)",
                        variable=self.overwrite).pack(anchor="w", pady=(12, 0))
        ttk.Checkbutton(frame, text="Check every machine for the needed nodes and models before running",
                        variable=self.preflight).pack(anchor="w", pady=(4, 0))

        ttk.Separator(frame).pack(fill="x", pady=14)
        ttk.Label(frame, text="Reuse this setup elsewhere", font=("Segoe UI", 10, "bold")).pack(anchor="w")
        ttk.Label(frame, text="Save the current workflow, overrides and output settings as a job file "
                              "so it can be run from a script or a scheduled task with:  cf run <file>",
                  foreground="#666", wraplength=1000, justify="left").pack(anchor="w", pady=(2, 6))
        ttk.Button(frame, text="Export job file...", command=self._export_job).pack(anchor="w")

    # -- run area ----------------------------------------------------------

    def _build_run_area(self, parent: ttk.Frame) -> None:
        bar = ttk.Frame(parent)
        bar.pack(fill="x", pady=(8, 6))

        self.check_btn = ttk.Button(bar, text="Check machines", command=self._start_check)
        self.check_btn.pack(side="left")
        self.run_btn = ttk.Button(bar, text="Run on fleet", command=self._start_run)
        self.run_btn.pack(side="left", padx=6)
        self.cancel_btn = ttk.Button(bar, text="Stop everything", command=self._cancel, state="disabled")
        self.cancel_btn.pack(side="left")

        self.progress = ttk.Progressbar(bar, mode="determinate", length=260)
        self.progress.pack(side="left", padx=(16, 8))
        ttk.Label(bar, textvariable=self.progress_text).pack(side="left")

        ttk.Button(bar, text="Clear log", command=lambda: self._set_log("")).pack(side="right")
        ttk.Button(bar, text="Save log...", command=self._save_log).pack(side="right", padx=6)

        holder = ttk.Frame(parent)
        holder.pack(fill="both", expand=True)
        self.log_text = tk.Text(holder, wrap="none", height=12, font=("Consolas", 9),
                                background="#1e1e1e", foreground="#d4d4d4", insertbackground="#d4d4d4")
        log_scroll = ttk.Scrollbar(holder, orient="vertical", command=self.log_text.yview)
        self.log_text.configure(yscrollcommand=log_scroll.set, state="disabled")
        self.log_text.pack(side="left", fill="both", expand=True)
        log_scroll.pack(side="right", fill="y")
        for tag, colour in (("ok", "#6a9955"), ("err", "#f48771"), ("info", "#569cd6")):
            self.log_text.tag_configure(tag, foreground=colour)

    # ------------------------------------------------------------------- log

    def log(self, message: str = "") -> None:
        """Thread-safe: callable from worker threads."""
        self.ui_queue.put(("log", message))

    def _write_log(self, message: str) -> None:
        tag = ""
        stripped = message.strip()
        if stripped.startswith(("!", "x", "error")) or "[OFFLINE]" in message or "[MISSING]" in message:
            tag = "err"
        elif stripped.startswith("+") or "[  OK   ]" in message or stripped.startswith("Done"):
            tag = "ok"
        elif stripped.startswith("["):
            tag = "info"
        self.log_text.configure(state="normal")
        self.log_text.insert("end", message + "\n", tag)
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def _set_log(self, text: str) -> None:
        self.log_text.configure(state="normal")
        self.log_text.delete("1.0", "end")
        if text:
            self.log_text.insert("1.0", text)
        self.log_text.configure(state="disabled")

    def _save_log(self) -> None:
        path = filedialog.asksaveasfilename(defaultextension=".txt",
                                            filetypes=[("Text", "*.txt"), ("All files", "*.*")])
        if path:
            Path(path).write_text(self.log_text.get("1.0", "end"), encoding="utf-8")

    def _drain_queue(self) -> None:
        try:
            while True:
                kind, payload = self.ui_queue.get_nowait()
                if kind == "log":
                    self._write_log(payload)
                elif kind == "status":
                    self._apply_status(payload)
                elif kind == "machine_state":
                    self._set_machine_status(*payload)
                elif kind == "done":
                    self._update_progress()   # catch the last completions before dropping the runner
                    self._set_busy(False)
                    self.runner = None
        except queue.Empty:
            pass
        self._update_progress()
        self.after(120, self._drain_queue)

    def _update_progress(self) -> None:
        runner = self.runner
        if runner is None or not self.total_tasks:
            return
        done = sum(1 for r in runner.results if r.state == "success")
        failed = sum(1 for r in runner.results if r.state != "success")
        self.progress.configure(maximum=self.total_tasks, value=done + failed)
        self.progress_text.set(
            f"{done}/{self.total_tasks} done  {failed} failed  {len(runner.collected)} files")
        for machine in self.machines:
            if machine.name in runner.offline:
                state = "offline"
            else:
                busy = len(runner.inflight.get(machine.name, []))
                state = f"running ({busy})" if busy else "idle"
            self._set_machine_status(machine.name, state)

    # ------------------------------------------------------------- machines

    def _refresh_machine_table(self) -> None:
        selected = self.machine_tree.selection()
        self.machine_tree.delete(*self.machine_tree.get_children())
        for i, m in enumerate(self.machines):
            self.machine_tree.insert("", "end", iid=str(i), values=(
                CHECK_ON if m.enabled else CHECK_OFF, m.name, f"{m.host}:{m.port}",
                "unknown", "", "", "", m.note,
            ))
        for iid in selected:
            if self.machine_tree.exists(iid):
                self.machine_tree.selection_set(iid)

    def _set_machine_status(self, name: str, status: str, gpu: str | None = None,
                            vram: str | None = None, queue_depth: str | None = None) -> None:
        for iid in self.machine_tree.get_children():
            if self.machine_tree.set(iid, "name") == name:
                self.machine_tree.set(iid, "status", status)
                if gpu is not None:
                    self.machine_tree.set(iid, "gpu", gpu)
                if vram is not None:
                    self.machine_tree.set(iid, "vram", vram)
                if queue_depth is not None:
                    self.machine_tree.set(iid, "queue", queue_depth)
                return

    def _on_machine_click(self, event: tk.Event) -> None:
        if self.machine_tree.identify_region(event.x, event.y) != "cell":
            return
        if self.machine_tree.identify_column(event.x) != "#1":
            return
        iid = self.machine_tree.identify_row(event.y)
        if not iid:
            return
        machine = self.machines[int(iid)]
        machine.enabled = not machine.enabled
        self.machine_tree.set(iid, "use", CHECK_ON if machine.enabled else CHECK_OFF)

    def _selected_machine_index(self) -> int | None:
        selection = self.machine_tree.selection()
        return int(selection[0]) if selection else None

    def _add_machine(self) -> None:
        dialog = MachineDialog(self)
        if dialog.result:
            self.machines.append(dialog.result)
            self._refresh_machine_table()

    def _edit_machine(self) -> None:
        index = self._selected_machine_index()
        if index is None:
            return
        dialog = MachineDialog(self, self.machines[index])
        if dialog.result:
            self.machines[index] = dialog.result
            self._refresh_machine_table()

    def _remove_machine(self) -> None:
        index = self._selected_machine_index()
        if index is None:
            return
        if messagebox.askyesno("Remove machine", f"Remove {self.machines[index].name}?"):
            del self.machines[index]
            self._refresh_machine_table()

    def _discover(self) -> None:
        dialog = DiscoverDialog(self)
        added = 0
        for info in dialog.result or []:
            if any(m.host == info["host"] and m.port == info["port"] for m in self.machines):
                continue
            self.machines.append(MachineCfg(
                name=f"GPU-{len(self.machines) + 1:02d}",
                host=info["host"], port=info["port"], note=info["gpu"],
            ))
            added += 1
        if added:
            self._refresh_machine_table()
            self.log(f"added {added} machine(s) - remember to save the machine list")

    def _refresh_status(self) -> None:
        machines = list(self.machines)
        if not machines:
            return
        self.log(f"pinging {len(machines)} machine(s) ...")

        def work() -> None:
            def probe(m: MachineCfg):
                client = ComfyClient(m.name, m.host, m.port, m.scheme, timeout=8)
                try:
                    return m, client.ping(), None
                except ComfyError as exc:
                    return m, None, exc

            with ThreadPoolExecutor(max_workers=16) as pool:
                for m, info, error in pool.map(probe, machines):
                    if error:
                        self.ui_queue.put(("machine_state", (m.name, "offline", "-", "-", "-")))
                        self.log(f"  ! {m.name}: {error}")
                    else:
                        self.ui_queue.put(("machine_state", (
                            m.name, "online", info["gpu"],
                            f"{info['vram_free_gb']} GB", str(info["queue"]))))
            self.log("status refreshed")

        threading.Thread(target=work, daemon=True).start()

    # ------------------------------------------------------------- workflow

    def _pick_workflow(self) -> None:
        path = filedialog.askopenfilename(
            title="Select an API-format workflow",
            initialdir=str(APP_ROOT / "workflows"),
            filetypes=[("Workflow JSON", "*.json"), ("All files", "*.*")],
        )
        if path:
            self.workflow_path.set(path)
            self._load_workflow()

    def _load_workflow(self) -> bool:
        path = self.workflow_path.get().strip()
        self.node_tree.delete(*self.node_tree.get_children())
        if not path:
            self.workflow = None
            self.workflow_info.configure(text="no workflow loaded", foreground="#666")
            return False
        try:
            self.workflow = Workflow.load(path)
        except WorkflowError as exc:
            self.workflow = None
            self.workflow_info.configure(text="could not load this file", foreground="#c00")
            messagebox.showerror("Workflow", str(exc), parent=self)
            return False

        seeds = len(self.workflow.seed_nodes())
        refs = {v for _, _, v in self.workflow.asset_refs()}
        info = f"{len(self.workflow.data)} nodes, {len(self.workflow.class_types())} node types, {seeds} seed widget(s)"
        if refs:
            info += f" - input files: {', '.join(sorted(refs))}"
        self.workflow_info.configure(text=info, foreground="#276")

        for node_id, node in sorted(self.workflow.nodes(), key=lambda kv: _numeric(kv[0])):
            title = Workflow.title_of(node)
            label = f"[{node_id}] {title}"
            if title != node.get("class_type"):
                label += f"  ({node.get('class_type')})"
            parent = self.node_tree.insert("", "end", iid=f"n:{node_id}", text=label, open=False, values=("",))
            for field_name, value in (node.get("inputs") or {}).items():
                if isinstance(value, list):
                    continue  # wired to another node, not editable
                self.node_tree.insert(parent, "end", iid=f"w:{node_id}:{field_name}",
                                      text=f"    {field_name}", values=(str(value),))
        return True

    def _on_node_double_click(self, _event: tk.Event) -> None:
        selection = self.node_tree.selection()
        if not selection or not selection[0].startswith("w:"):
            return
        _, node_id, field_name = selection[0].split(":", 2)
        current = self.node_tree.set(selection[0], "value")
        dialog = OverrideDialog(self, prefill=(node_id, field_name, current))
        if dialog.result:
            self.overrides.append(dialog.result)
            self._refresh_override_table()

    def _append_asset(self, path: str) -> None:
        current = [p for p in self.assets_path.get().split(";") if p.strip()]
        if path not in current:
            current.append(path)
        self.assets_path.set(";".join(current))

    def _pick_assets(self) -> None:
        path = filedialog.askdirectory(title="Folder of input files to upload to every machine")
        if path:
            self._append_asset(path)

    def _pick_asset_files(self) -> None:
        paths = filedialog.askopenfilenames(
            title="Input files to upload to every machine",
            filetypes=[("Media", "*.png *.jpg *.jpeg *.webp *.mp4 *.mov *.mkv *.webm *.wav *.mp3"),
                       ("All files", "*.*")])
        for path in paths:
            self._append_asset(path)

    def _refresh_override_table(self) -> None:
        self.override_tree.delete(*self.override_tree.get_children())
        for i, o in enumerate(self.overrides):
            by = "node" if o.node_id else ("title" if o.title else "class")
            target = o.node_id or o.title or o.class_type or ""
            value = str(o.value)
            if len(value) > 60:
                value = value[:57] + "..."
            self.override_tree.insert("", "end", iid=str(i), values=(by, target, o.field_name, value))

    def _add_override(self) -> None:
        dialog = OverrideDialog(self)
        if dialog.result:
            self.overrides.append(dialog.result)
            self._refresh_override_table()

    def _edit_override(self) -> None:
        selection = self.override_tree.selection()
        if not selection:
            return
        index = int(selection[0])
        dialog = OverrideDialog(self, self.overrides[index])
        if dialog.result:
            self.overrides[index] = dialog.result
            self._refresh_override_table()

    def _remove_override(self) -> None:
        selection = self.override_tree.selection()
        if selection:
            del self.overrides[int(selection[0])]
            self._refresh_override_table()

    # --------------------------------------------------------------- output

    def _pick_dest(self) -> None:
        path = filedialog.askdirectory(title="Where should the outputs be gathered?")
        if path:
            self.dest.set(path)

    def _open_dest(self) -> None:
        target = self.dest.get().strip()
        if not target:
            return
        try:
            Path(target).mkdir(parents=True, exist_ok=True)
            os.startfile(target)  # noqa: S606 - Windows shell open
        except (OSError, AttributeError) as exc:
            messagebox.showerror("Open folder", f"Could not open {target}\n\n{exc}", parent=self)

    # ------------------------------------------------------------ run logic

    def _build_fleet(self) -> FleetCfg:
        return FleetCfg(
            name="gui",
            machines=list(self.machines),
            collect=CollectCfg(
                enabled=self.collect_enabled.get(),
                destination=self.dest.get().strip() or str(APP_ROOT / "outputs"),
                layout=self.layout.get().strip() or "{run_id}/{machine}/{filename}",
                overwrite=self.overwrite.get(),
            ),
        )

    def _build_job(self) -> JobCfg:
        seed_mode = self.seed_mode.get()
        if seed_mode == "random":
            seed: Any = "random"
        elif seed_mode == "keep":
            seed = "keep"
        else:
            try:
                seed = int(self.seed_value.get())
            except ValueError:
                raise ValueError("The fixed seed must be a whole number.")
        try:
            count = max(1, int(self.count.get()))
        except ValueError:
            raise ValueError("The number of generations must be a whole number.")

        assets = [Path(p.strip()) for p in self.assets_path.get().split(";") if p.strip()]

        return JobCfg(
            workflow=Path(self.workflow_path.get().strip()),
            assets=assets,
            mode=self.mode.get(),
            count=count,
            seed=seed,
            overrides=list(self.overrides),
            collect_destination=None,
            name=Path(self.workflow_path.get().strip() or "job").stem,
        )

    def _prepare(self) -> tuple[FleetCfg, JobCfg, Workflow, list[ComfyClient]] | None:
        if not self._load_workflow():
            self.notebook.select(self.job_tab)
            messagebox.showwarning("Workflow", "Choose an API-format workflow JSON first.", parent=self)
            return None
        enabled = [m for m in self.machines if m.enabled]
        if not enabled:
            self.notebook.select(self.machines_tab)
            messagebox.showwarning("Machines", "Add at least one machine and tick it in the Use column.",
                                   parent=self)
            return None
        try:
            job = self._build_job()
        except ValueError as exc:
            self.notebook.select(self.job_tab)
            messagebox.showerror("Job", str(exc), parent=self)
            return None

        fleet = self._build_fleet()
        workflow = self.workflow.clone()
        try:
            applied = workflow.apply_overrides(job.overrides)
        except WorkflowError as exc:
            messagebox.showerror("Override", str(exc), parent=self)
            return None
        for line in applied:
            self.log(f"override: {line}")

        clients = [ComfyClient(m.name, m.host, m.port, m.scheme, timeout=fleet.request_timeout)
                   for m in enabled]
        return fleet, job, workflow, clients

    def _set_busy(self, busy: bool) -> None:
        self.busy = busy
        state = "disabled" if busy else "normal"
        self.check_btn.configure(state=state)
        self.run_btn.configure(state=state)
        self.cancel_btn.configure(state="normal" if busy else "disabled")

    def _start_check(self) -> None:
        prepared = self._prepare()
        if not prepared:
            return
        fleet, job, workflow, clients = prepared
        self._set_busy(True)
        self.progress_text.set("checking ...")

        def work() -> None:
            try:
                uploads = asset_names(job)
                self.log(f"\nchecking {len(clients)} machine(s) for the required nodes and models ...")
                with ThreadPoolExecutor(max_workers=12) as pool:
                    reports = list(pool.map(lambda c: check_machine(c, workflow, uploads), clients))
                for report in sorted(reports, key=lambda r: r.machine):
                    if not report.reachable:
                        self.ui_queue.put(("machine_state", (report.machine, "offline", "-", "-", "-")))
                        self.log(f"  ! {report.machine}: {report.error}")
                        continue
                    self.ui_queue.put(("machine_state", (report.machine, "online", report.gpu, None, None)))
                    if report.ok:
                        self.log(f"  + {report.machine}: ready (ComfyUI {report.comfyui_version}, {report.gpu})")
                        continue
                    self.log(f"  ! {report.machine}: not ready")
                    for cls in report.missing_classes:
                        self.log(f"      missing custom node: {cls}")
                    for missing in report.missing_values:
                        self.log(f"      {missing.describe()}")
                ready, blocked = summarize(reports)
                self.log(f"{len(ready)} ready, {len(blocked)} not ready")
                self.ui_queue.put(("status", "ready" if not blocked else f"{len(blocked)} machine(s) not ready"))
            except Exception:  # noqa: BLE001 - shown in the log
                self.log("check failed:\n" + traceback.format_exc())
            finally:
                self.ui_queue.put(("done", None))

        threading.Thread(target=work, daemon=True).start()

    def _start_run(self) -> None:
        prepared = self._prepare()
        if not prepared:
            return
        fleet, job, workflow, clients = prepared
        if fleet.collect.enabled:
            dest = Path(fleet.collect.destination)
            try:
                dest.mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                self.notebook.select(self.output_tab)
                messagebox.showerror(
                    "Output location",
                    f"Cannot write to {dest}\n\n{exc}\n\nPick a different destination on the Output tab.",
                    parent=self)
                return

        run_id = f"{datetime.now():%Y%m%d-%H%M%S}-{safe_name(job.name)}"
        # Tk variables may only be read on the main thread - snapshot before the worker starts.
        do_preflight = self.preflight.get()
        self._set_busy(True)
        self.progress.configure(value=0)
        self.progress_text.set("starting ...")
        self.log(f"\n=== run {run_id} ===")
        self.log(f"mode {job.mode}, count {job.count}, seed {job.seed}, {len(clients)} machine(s)")

        def work() -> None:
            try:
                usable = clients
                if do_preflight:
                    uploads = asset_names(job)
                    self.log("preflight ...")
                    with ThreadPoolExecutor(max_workers=12) as pool:
                        reports = list(pool.map(lambda c: check_machine(c, workflow, uploads), clients))
                    ready, blocked = summarize(reports)
                    for report in reports:
                        if report.ok:
                            continue
                        self.log(f"  ! skipping {report.machine}:")
                        if report.error:
                            self.log(f"      {report.error}")
                        for cls in report.missing_classes:
                            self.log(f"      custom node not installed: {cls}")
                        for missing in report.missing_values:
                            self.log(f"      {missing.describe()}")
                    usable = [c for c in clients if c.name in set(ready)]
                    if not usable:
                        self.log("no usable machines - nothing to run")
                        if any(r.missing_values for r in reports):
                            self.log("hint: input files listed above must either be added to the "
                                     "assets on the Workflow tab, or already sit in that machine's "
                                     "ComfyUI\\input folder")
                        return

                runner = Runner(fleet, job, workflow, usable, run_id, log=self.log,
                                collect=fleet.collect.enabled, dest_root=Path(fleet.collect.destination))
                self.runner = runner
                runner.upload_assets()
                runner.build_tasks()
                self.total_tasks = len(runner.pending)
                manifest = runner.run()

                self.log("")
                self.log(f"Done in {manifest['elapsed_seconds']}s - "
                         f"{manifest['tasks_succeeded']}/{manifest['tasks_total']} ok, "
                         f"{manifest['tasks_failed']} failed, {manifest['files_collected']} file(s) collected")
                for machine, stats in sorted(manifest["machines"].items()):
                    attempts = max(1, stats["success"] + stats["failed"])
                    self.log(f"  {machine}: {stats['success']} ok, {stats['failed']} failed, "
                             f"avg {stats['seconds'] / attempts:.0f}s per task")
                for failure in manifest["failures"]:
                    self.log(f"  ! task {failure['task']} on {failure['machine']}: {failure['detail']}")
                for err in manifest["collect_errors"]:
                    self.log(f"  ! download failed: {err}")
                if fleet.collect.enabled:
                    path = write_manifest(manifest, Path(fleet.collect.destination), run_id)
                    self.log(f"outputs: {Path(fleet.collect.destination) / run_id}")
                    if not path:
                        self.log("  ! could not write run.json - is the destination writable?")
                self.ui_queue.put(("status", f"finished: {manifest['files_collected']} file(s)"))
            except Exception:  # noqa: BLE001 - shown in the log
                self.log("run failed:\n" + traceback.format_exc())
                self.ui_queue.put(("status", "failed"))
            finally:
                self.ui_queue.put(("done", None))

        self.run_thread = threading.Thread(target=work, daemon=True)
        self.run_thread.start()

    def _cancel(self) -> None:
        runner = self.runner
        if runner is None:
            return
        self.cancel_btn.configure(state="disabled")
        self.log("stopping - clearing queues on every machine ...")
        threading.Thread(target=runner.abort, daemon=True).start()

    def _apply_status(self, text: str) -> None:
        self.progress_text.set(text)

    # --------------------------------------------------------- persistence

    def _load_fleet(self) -> None:
        if not FLEET_PATH.exists():
            self._refresh_machine_table()
            return
        try:
            from .config import load_fleet

            fleet = load_fleet(FLEET_PATH)
        except Exception as exc:  # noqa: BLE001 - config may be hand-edited
            self.log(f"could not read {FLEET_PATH}: {exc}")
            self._refresh_machine_table()
            return
        self.machines = fleet.machines
        self.dest.set(fleet.collect.destination)
        self.layout.set(fleet.collect.layout)
        self.collect_enabled.set(fleet.collect.enabled)
        self.overwrite.set(fleet.collect.overwrite)
        self._refresh_machine_table()

    def _save_fleet(self) -> None:
        data = {
            "fleet": {"name": "studio"},
            "defaults": {"port": 8000, "scheme": "http", "enabled": True, "slots": 2},
            "collect": {
                "enabled": self.collect_enabled.get(),
                "destination": self.dest.get().strip(),
                "layout": self.layout.get().strip(),
                "overwrite": self.overwrite.get(),
            },
            "machines": [
                {"name": m.name, "host": m.host, "port": m.port, "slots": m.slots,
                 "enabled": m.enabled, "note": m.note}
                for m in self.machines
            ],
        }
        try:
            FLEET_PATH.parent.mkdir(parents=True, exist_ok=True)
            FLEET_PATH.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True),
                                  encoding="utf-8")
            self.log(f"machine list saved to {FLEET_PATH}")
        except OSError as exc:
            messagebox.showerror("Save", f"Could not write {FLEET_PATH}\n\n{exc}", parent=self)

    def _export_job(self) -> None:
        if not self.workflow_path.get().strip():
            messagebox.showwarning("Export", "Choose a workflow first.", parent=self)
            return
        path = filedialog.asksaveasfilename(
            title="Save job file", defaultextension=".yaml",
            initialdir=str(APP_ROOT / "jobs"),
            filetypes=[("Job YAML", "*.yaml"), ("All files", "*.*")])
        if not path:
            return
        try:
            job = self._build_job()
        except ValueError as exc:
            messagebox.showerror("Job", str(exc), parent=self)
            return

        overrides = []
        for o in self.overrides:
            entry: dict[str, Any] = {}
            if o.node_id:
                entry["node"] = o.node_id
            elif o.title:
                entry["title"] = o.title
            else:
                entry["class"] = o.class_type
            entry["field"] = o.field_name
            entry["value"] = o.value
            overrides.append(entry)

        data: dict[str, Any] = {
            "name": job.name,
            "workflow": str(job.workflow),
            "mode": job.mode,
            "count": job.count,
            "seed": job.seed,
        }
        if job.assets:
            data["assets"] = [str(a) for a in job.assets]
        if overrides:
            data["overrides"] = overrides
        if self.collect_enabled.get():
            data["collect_destination"] = self.dest.get().strip()
        Path(path).write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True), encoding="utf-8")
        self.log(f"job saved to {path}  -  run it later with:  cf run \"{path}\"")

    def _load_state(self) -> None:
        if not STATE_PATH.exists():
            return
        try:
            state = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        self.workflow_path.set(state.get("workflow", ""))
        self.assets_path.set(state.get("assets", ""))
        self.mode.set(state.get("mode", "shard"))
        self.count.set(str(state.get("count", 10)))
        self.seed_mode.set(state.get("seed_mode", "random"))
        self.seed_value.set(str(state.get("seed_value", 0)))
        self.preflight.set(bool(state.get("preflight", True)))
        for entry in state.get("overrides", []):
            self.overrides.append(Override(
                field_name=entry["field"], value=entry["value"],
                node_id=entry.get("node"), title=entry.get("title"), class_type=entry.get("class"),
            ))
        self._refresh_override_table()
        self._sync_seed_entry()
        if self.workflow_path.get():
            try:
                self._load_workflow()
            except Exception:  # noqa: BLE001 - a stale path must not block startup
                pass

    def _save_state(self) -> None:
        state = {
            "workflow": self.workflow_path.get(),
            "assets": self.assets_path.get(),
            "mode": self.mode.get(),
            "count": self.count.get(),
            "seed_mode": self.seed_mode.get(),
            "seed_value": self.seed_value.get(),
            "preflight": self.preflight.get(),
            "overrides": [
                {k: v for k, v in (
                    ("node", o.node_id), ("title", o.title), ("class", o.class_type),
                    ("field", o.field_name), ("value", o.value)) if v is not None}
                for o in self.overrides
            ],
        }
        try:
            STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
            STATE_PATH.write_text(json.dumps(state, indent=2), encoding="utf-8")
        except OSError:
            pass

    def _on_close(self) -> None:
        if self.busy and not messagebox.askyesno(
            "Quit", "A run is still going. Quit anyway?\n\n"
                    "The machines will keep working on what is already queued."):
            return
        self._save_state()
        self.destroy()


def _numeric(node_id: str) -> tuple[int, str]:
    try:
        return int(node_id), ""
    except ValueError:
        return 1 << 30, node_id


def main() -> int:
    try:
        app = ComfyFleetApp()
        app.mainloop()
        return 0
    except Exception:  # noqa: BLE001 - last resort so the window never dies silently
        detail = traceback.format_exc()
        try:
            root = tk.Tk()
            root.withdraw()
            messagebox.showerror("ComfyFleet crashed", detail)
            root.destroy()
        except tk.TclError:
            print(detail, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
