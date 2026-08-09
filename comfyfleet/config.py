"""Fleet and job configuration loading."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


class ConfigError(Exception):
    pass


@dataclass
class MachineCfg:
    name: str
    host: str
    port: int = 8000
    scheme: str = "http"
    enabled: bool = True
    slots: int = 2
    note: str = ""

    @property
    def base_url(self) -> str:
        return f"{self.scheme}://{self.host}:{self.port}"


@dataclass
class CollectCfg:
    enabled: bool = True
    destination: str = "outputs"
    layout: str = "{run_id}/{machine}/{filename}"
    overwrite: bool = False


@dataclass
class FleetCfg:
    name: str = "fleet"
    machines: list[MachineCfg] = field(default_factory=list)
    collect: CollectCfg = field(default_factory=CollectCfg)
    request_timeout: float = 20.0
    poll_interval: float = 2.0
    stall_timeout: float = 1800.0
    source_path: Path | None = None

    def enabled_machines(self, only: list[str] | None = None) -> list[MachineCfg]:
        picked = [m for m in self.machines if m.enabled]
        if only:
            wanted = {n.lower() for n in only}
            picked = [m for m in picked if m.name.lower() in wanted or m.host.lower() in wanted]
            missing = wanted - {m.name.lower() for m in picked} - {m.host.lower() for m in picked}
            if missing:
                raise ConfigError(f"unknown machine(s): {', '.join(sorted(missing))}")
        return picked


def _read_yaml(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise ConfigError(f"file not found: {path}")
    with path.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh)
    if not isinstance(data, dict):
        raise ConfigError(f"{path} must contain a YAML mapping")
    return data


def load_fleet(path: str | os.PathLike[str]) -> FleetCfg:
    path = Path(path)
    data = _read_yaml(path)

    defaults = data.get("defaults") or {}
    raw_machines = data.get("machines") or []
    if not raw_machines:
        raise ConfigError(f"{path} lists no machines")

    machines: list[MachineCfg] = []
    seen: set[str] = set()
    for entry in raw_machines:
        if isinstance(entry, str):  # shorthand: "WS-01 192.168.1.51:8000" or "192.168.1.51"
            entry = _parse_shorthand(entry)
        if not isinstance(entry, dict):
            raise ConfigError(f"bad machine entry: {entry!r}")
        host = entry.get("host")
        if not host:
            raise ConfigError(f"machine entry missing 'host': {entry!r}")
        name = str(entry.get("name") or host)
        if name.lower() in seen:
            raise ConfigError(f"duplicate machine name: {name}")
        seen.add(name.lower())
        machines.append(
            MachineCfg(
                name=name,
                host=str(host),
                port=int(entry.get("port", defaults.get("port", 8000))),
                scheme=str(entry.get("scheme", defaults.get("scheme", "http"))),
                enabled=bool(entry.get("enabled", defaults.get("enabled", True))),
                slots=max(1, int(entry.get("slots", defaults.get("slots", 2)))),
                note=str(entry.get("note", "")),
            )
        )

    collect_raw = data.get("collect") or {}
    collect = CollectCfg(
        enabled=bool(collect_raw.get("enabled", True)),
        destination=str(collect_raw.get("destination", "outputs")),
        layout=str(collect_raw.get("layout", "{run_id}/{machine}/{filename}")),
        overwrite=bool(collect_raw.get("overwrite", False)),
    )

    fleet_raw = data.get("fleet") or {}
    return FleetCfg(
        name=str(fleet_raw.get("name", path.stem)),
        machines=machines,
        collect=collect,
        request_timeout=float(fleet_raw.get("request_timeout", 20.0)),
        poll_interval=float(fleet_raw.get("poll_interval", 2.0)),
        stall_timeout=float(fleet_raw.get("stall_timeout", 1800.0)),
        source_path=path,
    )


def _parse_shorthand(text: str) -> dict[str, Any]:
    parts = text.split()
    if len(parts) == 2:
        name, addr = parts
    else:
        name, addr = None, parts[0]
    host, _, port = addr.partition(":")
    out: dict[str, Any] = {"host": host}
    if name:
        out["name"] = name
    if port:
        out["port"] = int(port)
    return out


@dataclass
class Override:
    field_name: str
    value: Any
    node_id: str | None = None
    title: str | None = None
    class_type: str | None = None

    def describe(self) -> str:
        target = self.node_id or (f"title:{self.title}" if self.title else f"class:{self.class_type}")
        return f"{target}.{self.field_name}"


@dataclass
class JobCfg:
    workflow: Path
    assets: list[Path] = field(default_factory=list)
    mode: str = "shard"            # shard | mirror
    count: int = 1                 # shard: total runs; mirror: runs per machine
    seed: Any = "random"           # int base, "random", or "keep"
    overrides: list[Override] = field(default_factory=list)
    collect_destination: str | None = None
    name: str = "job"
    source_path: Path | None = None


def load_job(path: str | os.PathLike[str]) -> JobCfg:
    path = Path(path)
    data = _read_yaml(path)
    base = path.parent

    wf = data.get("workflow")
    if not wf:
        raise ConfigError(f"{path} has no 'workflow:' key")
    workflow = (base / wf).resolve() if not Path(wf).is_absolute() else Path(wf)

    assets_raw = data.get("assets") or []
    if isinstance(assets_raw, (str, os.PathLike)):
        assets_raw = [assets_raw]
    assets = [Path(a) if Path(a).is_absolute() else (base / a).resolve() for a in assets_raw]

    mode = str(data.get("mode", "shard")).lower()
    if mode not in ("shard", "mirror"):
        raise ConfigError("mode must be 'shard' or 'mirror'")

    return JobCfg(
        workflow=workflow,
        assets=assets,
        mode=mode,
        count=max(1, int(data.get("count", 1))),
        seed=data.get("seed", "random"),
        overrides=_parse_overrides(data.get("overrides")),
        collect_destination=data.get("collect_destination"),
        name=str(data.get("name", path.stem)),
        source_path=path,
    )


def _parse_overrides(raw: Any) -> list[Override]:
    if not raw:
        return []
    out: list[Override] = []
    if isinstance(raw, dict):
        # shorthand mapping: {"6.text": "hello", "title:Positive.text": "hi"}
        for key, value in raw.items():
            out.append(_override_from_key(str(key), value))
        return out
    if not isinstance(raw, list):
        raise ConfigError("'overrides' must be a mapping or a list")
    for entry in raw:
        if not isinstance(entry, dict):
            raise ConfigError(f"bad override entry: {entry!r}")
        if "field" not in entry or "value" not in entry:
            raise ConfigError(f"override needs 'field' and 'value': {entry!r}")
        selectors = [k for k in ("node", "title", "class") if k in entry]
        if len(selectors) != 1:
            raise ConfigError(f"override needs exactly one of node/title/class: {entry!r}")
        out.append(
            Override(
                field_name=str(entry["field"]),
                value=entry["value"],
                node_id=str(entry["node"]) if "node" in entry else None,
                title=str(entry["title"]) if "title" in entry else None,
                class_type=str(entry["class"]) if "class" in entry else None,
            )
        )
    return out


def _override_from_key(key: str, value: Any) -> Override:
    selector, _, field_name = key.rpartition(".")
    if not selector or not field_name:
        raise ConfigError(f"override key must look like '<node>.<field>': {key!r}")
    # tolerate "6.inputs.text"
    if selector.endswith(".inputs"):
        selector = selector[: -len(".inputs")]
    if selector.startswith("title:"):
        return Override(field_name=field_name, value=value, title=selector[6:])
    if selector.startswith("class:"):
        return Override(field_name=field_name, value=value, class_type=selector[6:])
    return Override(field_name=field_name, value=value, node_id=selector)
