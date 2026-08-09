"""Loading, inspecting and patching API-format ComfyUI workflows."""

from __future__ import annotations

import copy
import json
import random
from pathlib import Path
from typing import Any, Iterator

from .config import Override

SEED_FIELDS = ("seed", "noise_seed", "rand_seed")

ASSET_FIELDS = ("image", "images", "video", "audio", "file", "mask", "filename", "path", "video_file")
ASSET_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif",
    ".mp4", ".mov", ".mkv", ".webm", ".avi",
    ".wav", ".mp3", ".flac", ".ogg", ".m4a",
}

MAX_SEED = 0xFFFFFFFFFFFFFFFF


class WorkflowError(Exception):
    pass


class Workflow:
    """An API-format workflow: {node_id: {"inputs": {...}, "class_type": "...", "_meta": {...}}}."""

    def __init__(self, data: dict[str, Any], source: Path | None = None) -> None:
        self.data = data
        self.source = source

    # ---------------------------------------------------------------- loading

    @classmethod
    def load(cls, path: str | Path) -> "Workflow":
        path = Path(path)
        if not path.exists():
            raise WorkflowError(f"workflow not found: {path}")
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise WorkflowError(f"{path} is not valid JSON: {exc}") from exc

        if isinstance(data, dict) and "prompt" in data and isinstance(data["prompt"], dict):
            data = data["prompt"]  # some tools wrap the API payload

        if not isinstance(data, dict):
            raise WorkflowError(f"{path}: expected a JSON object at the top level")

        if "nodes" in data and "links" in data:
            raise WorkflowError(
                f"{path} is a UI workflow, not an API workflow.\n"
                "  In ComfyUI: Workflow -> Export (API)  (enable Settings -> Lite Graph -> "
                "'Enable dev mode options' on older builds), then point the job at that file."
            )

        for node_id, node in data.items():
            if not isinstance(node, dict) or "class_type" not in node or "inputs" not in node:
                raise WorkflowError(
                    f"{path}: node {node_id!r} is not in API format "
                    "(expected 'class_type' and 'inputs'). Re-export with Export (API)."
                )
        return cls(data, source=path)

    def clone(self) -> "Workflow":
        return Workflow(copy.deepcopy(self.data), source=self.source)

    # -------------------------------------------------------------- inspection

    def nodes(self) -> Iterator[tuple[str, dict[str, Any]]]:
        yield from self.data.items()

    def class_types(self) -> set[str]:
        return {str(node.get("class_type")) for _, node in self.nodes()}

    @staticmethod
    def title_of(node: dict[str, Any]) -> str:
        meta = node.get("_meta") or {}
        return str(meta.get("title") or node.get("class_type") or "")

    def seed_nodes(self) -> list[tuple[str, str]]:
        """[(node_id, field)] for every literal seed widget."""
        found: list[tuple[str, str]] = []
        for node_id, node in self.nodes():
            for field_name, value in (node.get("inputs") or {}).items():
                if field_name in SEED_FIELDS and isinstance(value, (int, float)) and not isinstance(value, bool):
                    found.append((node_id, field_name))
        return found

    def asset_refs(self) -> list[tuple[str, str, str]]:
        """[(node_id, field, filename)] for widget values that look like input files."""
        found: list[tuple[str, str, str]] = []
        for node_id, node in self.nodes():
            for field_name, value in (node.get("inputs") or {}).items():
                if not isinstance(value, str) or not value:
                    continue
                suffix = Path(value).suffix.lower()
                if suffix in ASSET_EXTENSIONS and (
                    field_name in ASSET_FIELDS or "image" in field_name or "video" in field_name
                ):
                    found.append((node_id, field_name, value))
        return found

    def widget_values(self) -> list[tuple[str, str, str, str]]:
        """[(node_id, class_type, field, value)] for every string widget - used for model checks."""
        found: list[tuple[str, str, str, str]] = []
        for node_id, node in self.nodes():
            class_type = str(node.get("class_type"))
            for field_name, value in (node.get("inputs") or {}).items():
                if isinstance(value, str):
                    found.append((node_id, class_type, field_name, value))
        return found

    # ---------------------------------------------------------------- patching

    def apply_overrides(self, overrides: list[Override]) -> list[str]:
        """Mutates in place. Returns human-readable descriptions of what changed."""
        applied: list[str] = []
        for override in overrides:
            targets = list(self._match_nodes(override))
            if not targets:
                raise WorkflowError(f"override {override.describe()} matched no node")
            for node_id, node in targets:
                inputs = node.setdefault("inputs", {})
                if override.field_name not in inputs:
                    raise WorkflowError(
                        f"override {override.describe()}: node {node_id} "
                        f"({node.get('class_type')}) has no input {override.field_name!r}. "
                        f"Available: {', '.join(sorted(inputs))}"
                    )
                if isinstance(inputs[override.field_name], list):
                    raise WorkflowError(
                        f"override {override.describe()}: node {node_id}.{override.field_name} is "
                        "wired to another node, not a literal widget - it cannot be overridden."
                    )
                inputs[override.field_name] = override.value
                preview = str(override.value)
                if len(preview) > 60:
                    preview = preview[:57] + "..."
                applied.append(f"{node_id}.{override.field_name} = {preview}")
        return applied

    def _match_nodes(self, override: Override) -> Iterator[tuple[str, dict[str, Any]]]:
        for node_id, node in self.nodes():
            if override.node_id is not None and node_id == override.node_id:
                yield node_id, node
            elif override.title is not None and self.title_of(node) == override.title:
                yield node_id, node
            elif override.class_type is not None and node.get("class_type") == override.class_type:
                yield node_id, node

    def set_seed(self, seed: int) -> int:
        """Set every literal seed widget. Returns the number of widgets patched."""
        count = 0
        for node_id, field_name in self.seed_nodes():
            self.data[node_id]["inputs"][field_name] = int(seed) & MAX_SEED
            count += 1
        return count

    def rewrite_asset_names(self, mapping: dict[str, str]) -> None:
        """Point asset widgets at the names the remote machine returned after upload."""
        for node_id, field_name, value in self.asset_refs():
            if value in mapping and mapping[value] != value:
                self.data[node_id]["inputs"][field_name] = mapping[value]


def random_seed() -> int:
    return random.randint(0, MAX_SEED)
