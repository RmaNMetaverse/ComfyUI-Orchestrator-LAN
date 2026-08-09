"""Scan a LAN range for reachable ComfyUI instances."""

from __future__ import annotations

import ipaddress
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from .client import ComfyClient, ComfyError

DEFAULT_PORTS = (8000, 8188, 8189)


def expand_targets(spec: str) -> list[str]:
    """Accept '192.168.1.0/24', '192.168.1.10-40', or a single host/name."""
    spec = spec.strip()
    if "/" in spec:
        net = ipaddress.ip_network(spec, strict=False)
        return [str(ip) for ip in net.hosts()]
    if "-" in spec:
        head, _, tail = spec.rpartition("-")
        base = head.rsplit(".", 1)[0]
        first = int(head.rsplit(".", 1)[1])
        last = int(tail)
        return [f"{base}.{i}" for i in range(first, last + 1)]
    return [spec]


def scan(spec: str, ports: tuple[int, ...] = DEFAULT_PORTS, timeout: float = 1.5,
         workers: int = 128) -> list[dict[str, Any]]:
    targets = [(host, port) for host in expand_targets(spec) for port in ports]

    def probe(pair: tuple[str, int]) -> dict[str, Any] | None:
        host, port = pair
        client = ComfyClient(name=host, host=host, port=port, timeout=timeout)
        try:
            info = client.ping()
        except ComfyError:
            return None
        info["host"] = host
        info["port"] = port
        return info

    found: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for result in pool.map(probe, targets):
            if result:
                found.append(result)
    return sorted(found, key=lambda r: (r["host"], r["port"]))
