"""A fake ComfyUI server - lets you exercise ComfyFleet without touching a GPU box.

    python tools/mock_comfy.py --port 8801 --name FAKE-01 --delay 3

It implements the same endpoints ComfyFleet uses (/system_stats, /object_info,
/prompt, /history, /view, /upload/image, /queue, /interrupt, /free) and produces
a small solid-colour PNG per job.
"""

from __future__ import annotations

import argparse
import json
import queue
import struct
import threading
import time
import uuid
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

STATE: dict = {}


def make_png(width: int, height: int, rgb: tuple[int, int, int]) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    raw = b"".join(b"\x00" + bytes(rgb) * width for _ in range(height))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 6))
            + chunk(b"IEND", b""))


OBJECT_INFO = {
    "CheckpointLoaderSimple": {"input": {"required": {"ckpt_name": [["sd_xl_base_1.0.safetensors",
                                                                    "dreamshaper_8.safetensors"]]}}},
    "CLIPTextEncode": {"input": {"required": {"text": ["STRING", {"multiline": True}], "clip": ["CLIP"]}}},
    "EmptyLatentImage": {"input": {"required": {"width": ["INT"], "height": ["INT"], "batch_size": ["INT"]}}},
    "KSampler": {"input": {"required": {
        "seed": ["INT"], "steps": ["INT"], "cfg": ["FLOAT"],
        "sampler_name": [["euler", "dpmpp_2m", "ddim"]],
        "scheduler": [["normal", "karras", "simple"]],
        "denoise": ["FLOAT"], "model": ["MODEL"], "positive": ["CONDITIONING"],
        "negative": ["CONDITIONING"], "latent_image": ["LATENT"]}}},
    "VAEDecode": {"input": {"required": {"samples": ["LATENT"], "vae": ["VAE"]}}},
    "SaveImage": {"input": {"required": {"images": ["IMAGE"], "filename_prefix": ["STRING"]}}},
    "LoadImage": {"input": {"required": {"image": [[]]}}},
    # Newer ComfyUI declares upload combos this way - options live in the settings dict,
    # not in the first element. LoadVideo is the common example.
    "LoadVideo": {"input": {"required": {"file": ["COMBO", {"options": [], "video_upload": True}]}}},
}


def _input_files(suffixes: tuple[str, ...]) -> list[str]:
    return sorted(p.name for p in STATE["input_dir"].glob("*")
                  if p.is_file() and p.suffix.lower() in suffixes)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quieter
        if STATE["verbose"]:
            print(f"[{STATE['name']}] {fmt % args}")

    # ---------------------------------------------------------------- helpers

    def _send(self, code: int, body: bytes, content_type: str = "application/json") -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code: int = 200) -> None:
        self._send(code, json.dumps(obj).encode("utf-8"))

    # -------------------------------------------------------------------- GET

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path, query = parsed.path, parse_qs(parsed.query)

        if path == "/system_stats":
            self._json({
                "system": {"os": "nt", "comfyui_version": "0.3.44-mock",
                           "python_version": "3.13.5 (mock)"},
                "devices": [{"name": STATE["gpu"], "type": "cuda",
                             "vram_total": 24 * 1024**3, "vram_free": 21 * 1024**3}],
            })
        elif path == "/object_info":
            info = dict(OBJECT_INFO)
            info["LoadImage"] = {"input": {"required": {"image": [
                _input_files((".png", ".jpg", ".jpeg", ".webp"))]}}}
            info["LoadVideo"] = {"input": {"required": {"file": [
                "COMBO", {"options": _input_files((".mp4", ".mov", ".mkv", ".webm")),
                          "video_upload": True}]}}}
            self._json(info)
        elif path == "/prompt":
            self._json({"exec_info": {"queue_remaining": STATE["queue"].qsize() + len(STATE["running"])}})
        elif path == "/queue":
            self._json({"queue_running": list(STATE["running"]), "queue_pending": []})
        elif path.startswith("/history"):
            pid = path.rsplit("/", 1)[-1]
            if pid in ("history", ""):
                self._json(STATE["history"])
            else:
                record = STATE["history"].get(pid)
                self._json({pid: record} if record else {})
        elif path == "/view":
            name = (query.get("filename") or [""])[0]
            target = STATE["output_dir"] / name
            if target.exists():
                self._send(200, target.read_bytes(), "image/png")
            else:
                self._json({"error": "not found"}, 404)
        else:
            self._json({"error": f"mock: no route {path}"}, 404)

    # ------------------------------------------------------------------- POST

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b""

        if path == "/prompt":
            data = json.loads(body or b"{}")
            prompt = data.get("prompt", {})
            errors = _validate(prompt)
            if errors:
                # Same shape real ComfyUI returns when a node's file does not exist.
                self._json({
                    "error": {"type": "prompt_outputs_failed_validation",
                              "message": "Prompt outputs failed validation",
                              "details": "", "extra_info": {}},
                    "node_errors": errors,
                }, 400)
                return
            prompt_id = str(uuid.uuid4())
            STATE["queue"].put((prompt_id, prompt))
            self._json({"prompt_id": prompt_id, "number": 1, "node_errors": {}})
        elif path == "/upload/image":
            name = _multipart_filename(body) or f"upload-{uuid.uuid4().hex[:8]}.bin"
            payload = _multipart_payload(body)
            (STATE["input_dir"] / name).write_bytes(payload)
            self._json({"name": name, "subfolder": "", "type": "input"})
        elif path in ("/interrupt", "/free"):
            self._json({})
        elif path == "/queue":
            data = json.loads(body or b"{}")
            if data.get("clear"):
                while not STATE["queue"].empty():
                    STATE["queue"].get_nowait()
            self._json({})
        else:
            self._json({"error": f"mock: no route {path}"}, 404)


def _validate(prompt: dict) -> dict:
    """Reject LoadVideo / LoadImage nodes whose file is not in the input folder."""
    checks = {"LoadVideo": ("file", "Invalid video file"), "LoadImage": ("image", "Invalid image file")}
    errors: dict = {}
    for node_id, node in prompt.items():
        if not isinstance(node, dict):
            continue
        spec = checks.get(node.get("class_type"))
        if not spec:
            continue
        field, label = spec
        name = (node.get("inputs") or {}).get(field)
        if isinstance(name, str) and not (STATE["input_dir"] / name).exists():
            errors[node_id] = {
                "errors": [{"type": "custom_validation_failed",
                            "message": "Custom validation failed for node",
                            "details": f"{field} - {label}: {name}",
                            "extra_info": {"input_name": field}}],
                "dependent_outputs": [], "class_type": node["class_type"],
            }
    return errors


def _multipart_filename(body: bytes) -> str | None:
    marker = b'filename="'
    i = body.find(marker)
    if i < 0:
        return None
    j = body.find(b'"', i + len(marker))
    return body[i + len(marker): j].decode("utf-8", "replace")


def _multipart_payload(body: bytes) -> bytes:
    i = body.find(b"\r\n\r\n")
    if i < 0:
        return body
    end = body.rfind(b"\r\n--")
    return body[i + 4: end if end > i else len(body)]


def worker() -> None:
    counter = 0
    while True:
        prompt_id, prompt = STATE["queue"].get()
        STATE["running"].append(prompt_id)
        time.sleep(STATE["delay"])
        counter += 1
        seed = 0
        for node in prompt.values():
            if isinstance(node, dict) and "seed" in (node.get("inputs") or {}):
                seed = node["inputs"]["seed"]
        colour = ((seed * 37) % 255, (seed * 91) % 255, (seed * 13) % 255)
        filename = f"{STATE['name']}_{counter:05d}_.png"
        (STATE["output_dir"] / filename).write_bytes(make_png(64, 64, colour))
        STATE["history"][prompt_id] = {
            "prompt": [0, prompt_id, prompt, {}, []],
            "outputs": {"9": {"images": [{"filename": filename, "subfolder": "", "type": "output"}]}},
            "status": {"status_str": "success", "completed": True, "messages": []},
        }
        STATE["running"].remove(prompt_id)
        STATE["queue"].task_done()


def main() -> None:
    ap = argparse.ArgumentParser(description="Fake ComfyUI server for testing ComfyFleet")
    ap.add_argument("--port", type=int, default=8801)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--name", default="MOCK")
    ap.add_argument("--gpu", default="NVIDIA GeForce RTX 4090 (mock)")
    ap.add_argument("--delay", type=float, default=3.0, help="seconds per generation")
    ap.add_argument("--root", default=None, help="where to keep input/ and output/")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    root = Path(args.root or Path(__file__).resolve().parent / "_mock" / args.name)
    (root / "input").mkdir(parents=True, exist_ok=True)
    (root / "output").mkdir(parents=True, exist_ok=True)

    STATE.update({
        "name": args.name, "gpu": args.gpu, "delay": args.delay, "verbose": args.verbose,
        "queue": queue.Queue(), "running": [], "history": {},
        "input_dir": root / "input", "output_dir": root / "output",
    })
    threading.Thread(target=worker, daemon=True).start()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"mock ComfyUI '{args.name}' on http://{args.host}:{args.port}  ({args.delay}s per job)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("bye")


if __name__ == "__main__":
    main()
