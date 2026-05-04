"""
Diagnose why Holo3 vision requests fail on Modal with
  {"error":{"code":400,"message":"Failed to load image or audio file"}}

Reuses the same Image + GGUF volume as modal_app.py, but boots llama-server
inside the function and probes /v1/chat/completions with several image payload
shapes. Prints the llama.cpp commit + every variant's status code + body so we
can pinpoint which form (if any) the current mmproj/llama.cpp accepts.

Run:
    modal run scripts/diag_modal.py
"""
from __future__ import annotations

import base64
import io
import os
import subprocess
import time
from typing import Any

import modal

# Import the same Image + volume + paths from modal_app so we test the SAME
# environment the prod endpoints use.
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from modal_app import (  # noqa: E402
    image,
    volume,
    MODELS_DIR,
    LOCAL_GGUF_PATH,
    LOCAL_MMPROJ_PATH,
    LLAMA_BIN,
    LLAMA_PORT,
)

diag_app = modal.App("holo3-agent-diag")


def _make_test_png(size: int = 64) -> bytes:
    """Plain solid-color PNG. Encoded inline so the diagnostic doesn't need PIL."""
    # 64x64 white PNG, hand-built so we don't depend on Pillow inside the image.
    # Structure: PNG signature + IHDR + IDAT (zlib of one row of 0xFF * 64 bytes
    # repeated 64 times, with filter byte 0) + IEND.
    import zlib
    sig = b"\x89PNG\r\n\x1a\n"

    def chunk(tag: bytes, data: bytes) -> bytes:
        import struct
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    import struct
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # 8-bit RGB
    raw = b""
    for _ in range(size):
        raw += b"\x00" + b"\xff\xff\xff" * size  # filter=None + RGB white
    idat = zlib.compress(raw, 9)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


@diag_app.function(
    image=image,
    gpu="L4",
    volumes={MODELS_DIR: volume},
    timeout=60 * 20,
)
def probe() -> dict[str, Any]:
    import httpx

    # 1. llama.cpp commit baked into the image
    try:
        commit = subprocess.check_output(
            ["git", "-C", "/opt/llama.cpp", "rev-parse", "HEAD"],
            text=True,
        ).strip()
        ts = subprocess.check_output(
            ["git", "-C", "/opt/llama.cpp", "log", "-1", "--format=%ci"],
            text=True,
        ).strip()
    except Exception as e:
        commit = f"<error: {e}>"
        ts = ""

    # 2. Spawn llama-server (same args as modal_app.py)
    cmd = [
        LLAMA_BIN,
        "-m", LOCAL_GGUF_PATH,
        "--host", "127.0.0.1",
        "--port", str(LLAMA_PORT),
        "-ngl", "999",
        "-c", "8192",
        "--no-warmup",
        # NOTE: --log-disable removed — we want stderr to go to Modal logs.
    ]
    if os.path.exists(LOCAL_MMPROJ_PATH):
        cmd += ["--mmproj", LOCAL_MMPROJ_PATH]

    print(f"[diag] llama.cpp commit: {commit} ({ts})", flush=True)
    print(f"[diag] spawning: {' '.join(cmd)}", flush=True)
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        bufsize=1,
        text=True,
    )

    # Tee stdout to our logs in the background so we see what llama-server says.
    import threading
    server_log: list[str] = []

    def _drain() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            server_log.append(line.rstrip())
            print(f"[llama] {line.rstrip()}", flush=True)

    threading.Thread(target=_drain, daemon=True).start()

    client = httpx.Client(
        base_url=f"http://127.0.0.1:{LLAMA_PORT}",
        timeout=httpx.Timeout(120.0, connect=5.0),
    )

    # Wait for /health
    deadline = time.time() + 600
    while time.time() < deadline:
        if proc.poll() is not None:
            return {
                "stage": "server_died",
                "commit": commit,
                "log_tail": server_log[-50:],
            }
        try:
            r = client.get("/health", timeout=2)
            if r.status_code == 200:
                break
        except Exception:
            pass
        time.sleep(1)
    else:
        return {"stage": "server_never_healthy", "commit": commit, "log_tail": server_log[-50:]}

    # 3. /props — inspect what llama-server reports about the loaded model
    try:
        props = client.get("/props").json()
    except Exception as e:
        props = {"error": str(e)}

    # 4. Probe several image payload shapes
    png = _make_test_png(64)
    b64 = base64.b64encode(png).decode()
    file_path = "/tmp/diag.png"
    with open(file_path, "wb") as f:
        f.write(png)

    variants: list[tuple[str, dict]] = [
        (
            "openai_object_data_uri",
            {
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
                            {"type": "text", "text": "describe in one word"},
                        ],
                    }
                ],
                "max_tokens": 8,
                "temperature": 0,
            },
        ),
        (
            "openai_string_data_uri",
            {
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "image_url", "image_url": f"data:image/png;base64,{b64}"},
                            {"type": "text", "text": "describe in one word"},
                        ],
                    }
                ],
                "max_tokens": 8,
                "temperature": 0,
            },
        ),
        (
            "image_url_object_file_path",
            {
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "image_url", "image_url": {"url": f"file://{file_path}"}},
                            {"type": "text", "text": "describe in one word"},
                        ],
                    }
                ],
                "max_tokens": 8,
                "temperature": 0,
            },
        ),
        (
            "raw_image_data_field",
            {
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "image_data", "image_data": {"data": b64, "id": 0}},
                            {"type": "text", "text": "describe in one word"},
                        ],
                    }
                ],
                "max_tokens": 8,
                "temperature": 0,
            },
        ),
        (
            "legacy_image_id_in_text",
            {
                "messages": [
                    {
                        "role": "user",
                        "content": "[img-0]describe in one word",
                    }
                ],
                "image_data": [{"data": b64, "id": 0}],
                "max_tokens": 8,
                "temperature": 0,
            },
        ),
    ]

    results: list[dict[str, Any]] = []
    for name, body in variants:
        t0 = time.time()
        try:
            r = client.post("/v1/chat/completions", json=body, timeout=120)
            content = ""
            try:
                j = r.json()
                if r.status_code == 200:
                    content = j.get("choices", [{}])[0].get("message", {}).get("content", "")
            except Exception:
                pass
            results.append({
                "variant": name,
                "status": r.status_code,
                "ms": int((time.time() - t0) * 1000),
                "body_head": r.text[:400],
                "content": content[:200],
            })
            print(
                f"[diag] {name:35s} → {r.status_code} in {results[-1]['ms']}ms  body={r.text[:200]!r}",
                flush=True,
            )
        except Exception as e:
            results.append({"variant": name, "error": str(e)[:400]})
            print(f"[diag] {name:35s} → EXCEPTION {e}", flush=True)

    return {
        "commit": commit,
        "commit_ts": ts,
        "props_summary": {
            k: props.get(k)
            for k in ("default_generation_settings", "modalities", "model_path", "n_ctx", "build_info")
            if k in props
        },
        "props_raw_keys": list(props.keys()) if isinstance(props, dict) else None,
        "results": results,
    }


@diag_app.local_entrypoint()
def main() -> None:
    out = probe.remote()
    import json
    print("=" * 70)
    print(json.dumps(out, indent=2, default=str))
    print("=" * 70)
