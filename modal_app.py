"""
Holo3-35B-A3B-APEX-GGUF served via llama.cpp's `llama-server` (built from source
in the image) + a FastAPI shim that exposes /warm, /plan, /ground, /health.

Why this shape rather than llama-cpp-python:
  - llama-cpp-python's CUDA wheels are brittle; building from source needs
    CMAKE_CUDA_ARCHITECTURES and frequently breaks across versions.
  - llama-server is the upstream-blessed binary. Multimodal works out of the
    box with --mmproj. It exposes an OpenAI-compatible /v1/chat/completions
    plus a `grammar` field we use for the constrained {x,y} ground response.

Coordinates returned by Holo3 are 0-1000 normalized; this server rescales them
to pixel space using the screen size in the request, so the TS client never
sees normalized.

Auth: Bearer token from Modal Secret `holo3-agent-auth` (key TOKEN).
"""

from __future__ import annotations

import os
import re
import json
import time
import base64
import subprocess
from typing import Any

import modal
from fastapi import Header

# ---------------------------------------------------------------------------
# Image: CUDA devel image, llama.cpp built from source with CUDA + CURL on.
# Targeting sm_89 = Ada Lovelace (L4, L40S). Re-add 86 for A10G if needed.
# ---------------------------------------------------------------------------

CUDA_ARCHS = "89-real"  # L4 / L40S. For broader coverage use "75-real;80-real;86-real;89-real;90-real"

image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.4.1-devel-ubuntu22.04", add_python="3.11"
    )
    .apt_install(
        "git",
        "build-essential",
        "cmake",
        "ccache",
        "curl",
        "libcurl4-openssl-dev",
        "libgomp1",
    )
    .run_commands(
        "git clone --depth 1 https://github.com/ggml-org/llama.cpp /opt/llama.cpp || "
        "git clone --depth 1 https://github.com/ggerganov/llama.cpp /opt/llama.cpp",
        # The CUDA *driver* (libcuda.so.1) is not in the build container — it's
        # only on the GPU host at runtime. Point the linker at the CUDA stubs
        # so symbols (cuMemCreate, cuMemMap, …) resolve at link time, and add
        # an rpath-link so transitive linkage of libggml-cuda.so works.
        "ln -sf /usr/local/cuda/lib64/stubs/libcuda.so "
        "/usr/local/cuda/lib64/stubs/libcuda.so.1",
        f"cd /opt/llama.cpp && cmake -B build "
        f"-DGGML_CUDA=ON "
        f"-DCMAKE_CUDA_ARCHITECTURES={CUDA_ARCHS} "
        f"-DLLAMA_CURL=ON "
        f"-DCMAKE_BUILD_TYPE=Release "
        f"-DCMAKE_EXE_LINKER_FLAGS='-L/usr/local/cuda/lib64/stubs -Wl,-rpath-link,/usr/local/cuda/lib64/stubs' "
        f"-DCMAKE_SHARED_LINKER_FLAGS='-L/usr/local/cuda/lib64/stubs -Wl,-rpath-link,/usr/local/cuda/lib64/stubs'",
        "cd /opt/llama.cpp && cmake --build build --config Release -j$(nproc) "
        "--target llama-server",
        # Confirm the binary exists so a build failure is loud at image-build time.
        "test -x /opt/llama.cpp/build/bin/llama-server",
    )
    .pip_install(
        "fastapi[standard]==0.115.5",
        "huggingface_hub==0.26.2",
        "httpx==0.27.2",
    )
)

app = modal.App("holo3-agent")
volume = modal.Volume.from_name("holo3-models", create_if_missing=True)


def _strip_think(text: str) -> str:
    """Remove <think>...</think> reasoning blocks from Holo3 output.

    Holo3 has reasoning ON by default. We tell llama-server to disable it via
    `chat_template_kwargs.enable_thinking=False`, but if the template ignores
    that flag (older builds, custom templates), the model still emits a
    <think>...</think> block. Worse: with a tight max_tokens budget the model
    sometimes hits the cap mid-reasoning and the closing tag never arrives —
    in that case the entire content is wrapped in an unclosed <think> and
    naive `.*?</think>` regex finds nothing, leaking reasoning as the action.

    This helper:
      1. Removes every COMPLETE <think>...</think> block.
      2. If an opening <think> remains with no close, drops everything from
         that tag forward (the answer, if any, would be after the close —
         and there is no close, so nothing useful is being kept).
      3. Strips a stray leading </think> when the model started with empty
         reasoning.

    Mirrors hcompany.ts::stripThink so both providers behave identically.
    """
    out = re.sub(r"<think>[\s\S]*?</think>", "", text, flags=re.DOTALL)
    open_idx = out.find("<think>")
    if open_idx != -1:
        out = out[:open_idx]
    out = re.sub(r"^\s*</think>\s*", "", out, flags=re.IGNORECASE)
    return out.strip()

MODELS_DIR = "/models"
HF_REPO = "mudler/Holo3-35B-A3B-APEX-GGUF"
GGUF_FILENAME = os.environ.get("HOLO3_GGUF", "Holo3-35B-A3B-APEX-I-Compact.gguf")
MMPROJ_FILENAME = "mmproj.gguf"
LOCAL_GGUF_PATH = f"{MODELS_DIR}/{GGUF_FILENAME}"
LOCAL_MMPROJ_PATH = f"{MODELS_DIR}/{MMPROJ_FILENAME}"

LLAMA_PORT = 8080
LLAMA_BIN = "/opt/llama.cpp/build/bin/llama-server"

# GBNF grammar that constrains output to {"x":int,"y":int}.
GROUND_GRAMMAR = (
    'root   ::= "{" ws "\\"x\\"" ws ":" ws number ws "," ws "\\"y\\"" ws ":" ws number ws "}"\n'
    "number ::= [0-9]+\n"
    "ws     ::= [ \\t\\n]*\n"
)

auth_secret = modal.Secret.from_name(
    "holo3-agent-auth", required_keys=["TOKEN"]
)


# ---------------------------------------------------------------------------
# One-shot: download GGUF + mmproj into the Volume.
#   modal run modal_app.py::download_model
# ---------------------------------------------------------------------------

@app.function(image=image, volumes={MODELS_DIR: volume}, timeout=60 * 60)
def download_model() -> str:
    from huggingface_hub import hf_hub_download

    os.makedirs(MODELS_DIR, exist_ok=True)
    notes: list[str] = []

    for fname, label in [(GGUF_FILENAME, "weights"), (MMPROJ_FILENAME, "mmproj")]:
        local = f"{MODELS_DIR}/{fname}"
        if os.path.exists(local):
            notes.append(f"{label}: present ({os.path.getsize(local) / 1e9:.1f} GB)")
            continue
        hf_hub_download(
            repo_id=HF_REPO,
            filename=fname,
            local_dir=MODELS_DIR,
            local_dir_use_symlinks=False,
        )
        notes.append(
            f"{label}: downloaded ({os.path.getsize(local) / 1e9:.1f} GB)"
        )

    volume.commit()
    return " | ".join(notes)


# ---------------------------------------------------------------------------
# Inference container — boots llama-server and proxies to it.
# ---------------------------------------------------------------------------

@app.cls(
    image=image,
    gpu="L4",  # cheapest 24GB-class GPU; fits I-Compact (17GB) + KV cache
    volumes={MODELS_DIR: volume},
    secrets=[auth_secret],
    scaledown_window=600,
    timeout=60 * 30,
    min_containers=0,
    max_containers=4,
)
@modal.concurrent(max_inputs=4)
class Holo3:
    @modal.enter()
    def start(self) -> None:
        import httpx

        if not os.path.exists(LOCAL_GGUF_PATH):
            raise RuntimeError(
                f"GGUF not found at {LOCAL_GGUF_PATH}. "
                "Run `modal run modal_app.py::download_model` first."
            )

        cmd = [
            LLAMA_BIN,
            "-m", LOCAL_GGUF_PATH,
            "--host", "127.0.0.1",
            "--port", str(LLAMA_PORT),
            "-ngl", "999",
            "-c", "8192",
            "--no-warmup",
            # NB: --log-disable removed. We need llama-server's stderr in Modal
            # logs when image loading or chat-template rendering fails — the
            # FastAPI shim only ever sees the 4xx response body, which is too
            # generic to debug without the upstream trace.
        ]
        if os.path.exists(LOCAL_MMPROJ_PATH):
            cmd += ["--mmproj", LOCAL_MMPROJ_PATH]
        else:
            print("WARNING: mmproj not found, vision will be disabled", flush=True)

        print(f"Spawning: {' '.join(cmd)}", flush=True)
        self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

        self.client = httpx.Client(
            base_url=f"http://127.0.0.1:{LLAMA_PORT}",
            timeout=httpx.Timeout(120.0, connect=5.0),
        )

        # Poll /health until ready (or model load fails).
        deadline = time.time() + 600  # 10 min cap on first load
        while time.time() < deadline:
            if self.proc.poll() is not None:
                # Server died — read whatever it printed.
                tail = self.proc.stdout.read().decode("utf-8", "replace") if self.proc.stdout else ""
                raise RuntimeError(f"llama-server exited early. Last output:\n{tail[-2000:]}")
            try:
                r = self.client.get("/health", timeout=2)
                if r.status_code == 200:
                    break
            except Exception:
                pass
            time.sleep(1)
        else:
            raise RuntimeError("llama-server did not become healthy within 10 min")

        self.has_vision = os.path.exists(LOCAL_MMPROJ_PATH)
        print(f"llama-server ready (vision={self.has_vision})", flush=True)

    # ---- Brain (planner) ----

    @modal.method()
    def plan(
        self,
        task: str,
        history: list[str],
        screenshot_b64: str,
        screen_w: int,
        screen_h: int,
    ) -> dict[str, Any]:
        history_block = "\n".join(f"- {h}" for h in history[-3:]) or "(none)"
        dup_warning = ""
        if len(history) >= 2 and history[-1] == history[-2]:
            dup_warning = (
                "\nCRITICAL WARNING: your last action was repeated. "
                "If the screen did not change, switch strategy."
            )

        system = (
            "You are the Brain of a computer-use agent. Look at the screenshot "
            "and decide the SINGLE next action.\n"
            "\n"
            "Allowed actions (emit exactly one):\n"
            "  - click <thing>\n"
            "  - double click <thing>\n"
            "  - type \"text\"\n"
            "  - press KEY              (e.g. press enter, press esc)\n"
            "  - hotkey KEY+KEY         (e.g. hotkey cmd+tab to switch apps)\n"
            "  - drag <source> to <target>  (drag-and-drop one element onto another)\n"
            "  - scroll up / scroll down\n"
            "  - wait Ns\n"
            "  - DONE\n"
            "\n"
            "PREFER KEYBOARD SHORTCUTS when they're faster or more reliable than\n"
            "clicking. Useful ones:\n"
            "  • hotkey cmd+tab     switch to another open app\n"
            "  • hotkey cmd+space   open Spotlight to launch any app by name\n"
            "  • hotkey cmd+`       cycle windows within the current app\n"
            "  • hotkey cmd+w       close window\n"
            "  • hotkey cmd+t       new tab (browsers)\n"
            "  • press tab          move to next form field\n"
            "  • press enter        submit the focused field\n"
            "  • press esc          close popovers / cancel modals\n"
            "\n"
            "DRAG when an element needs to MOVE, not be clicked:\n"
            "  drag the file icon to the trash\n"
            "  drag the slider handle to the right end\n"
            "Both endpoints must be visible on screen; if the destination isn't,\n"
            "scroll first.\n"
            "\n"
            "Return ONLY one action sentence (or DONE). No commentary, no JSON, "
            "no chained actions."
        )
        user_text = (
            f"Task: {task}\n"
            f"Screen: {screen_w}x{screen_h}\n"
            f"Recent history:\n{history_block}{dup_warning}\n"
            "What is the next single action?"
        )

        body = {
            "messages": self._messages(system, user_text, screenshot_b64),
            "temperature": 0.2,
            # Bumped 128 → 256. With reasoning enabled (default), the old cap
            # got eaten entirely by <think>…</think> and the post-strip action
            # came out empty. Even with reasoning OFF, 256 is cheap insurance
            # against a slightly verbose answer being truncated mid-sentence.
            "max_tokens": 256,
            "stop": ["\n\n"],
            # Disable Qwen3-style reasoning at the chat-template layer. llama.cpp
            # passes chat_template_kwargs through to the Jinja renderer; the
            # Holo3 (Qwen3) template honors `enable_thinking`. Without this,
            # the model wraps its answer in <think>…</think>, runs out of
            # max_tokens before closing, and we return "" after stripping.
            "chat_template_kwargs": {"enable_thinking": False},
        }
        r = self.client.post("/v1/chat/completions", json=body)
        if r.status_code != 200:
            # Surface llama-server's actual error body to the client. Without
            # this, httpx raises a generic HTTPStatusError and the response
            # body — which contains the real message — is lost.
            raise RuntimeError(
                f"llama-server /v1/chat/completions returned {r.status_code}: "
                f"{r.text[:600]}"
            )
        out = r.json()
        text = _strip_think(out["choices"][0]["message"]["content"])
        return {"action": text, "usage": out.get("usage", {})}

    # ---- Eyes (grounder) ----

    @modal.method()
    def ground(
        self,
        instruction: str,
        screenshot_b64: str,
        screen_w: int,
        screen_h: int,
    ) -> dict[str, Any]:
        system = (
            "You return (x,y) coordinates to click as JSON: "
            "{\"x\": <int 0-1000>, \"y\": <int 0-1000>} "
            "where coordinates are normalized to a 1000x1000 grid over the screenshot."
        )
        user_text = f"Click target: {instruction}"

        body = {
            "messages": self._messages(system, user_text, screenshot_b64),
            "temperature": 0.0,
            # Same reasoning as plan(): grammar guarantees the FINAL output is
            # {"x":N,"y":N}, but the model still emits a <think>…</think>
            # preamble unless we disable it. Tiny budgets eat the answer.
            "max_tokens": 256,
            "grammar": GROUND_GRAMMAR,
            "chat_template_kwargs": {"enable_thinking": False},
        }
        r = self.client.post("/v1/chat/completions", json=body)
        if r.status_code != 200:
            raise RuntimeError(
                f"llama-server /v1/chat/completions returned {r.status_code}: "
                f"{r.text[:600]}"
            )
        out = r.json()
        raw = _strip_think(out["choices"][0]["message"]["content"])

        coords = self._parse_xy(raw)
        if coords is None:
            return {"error": f"could not parse coordinates: {raw[:120]}", "raw_text": raw}

        rx, ry = coords
        x = int(round((rx / 1000.0) * screen_w)) if rx <= 1000 else int(rx)
        y = int(round((ry / 1000.0) * screen_h)) if ry <= 1000 else int(ry)
        x = max(0, min(screen_w - 1, x))
        y = max(0, min(screen_h - 1, y))
        return {"x": x, "y": y, "raw": [rx, ry], "usage": out.get("usage", {})}

    # ---- Helpers ----

    def _messages(self, system: str, user_text: str, screenshot_b64: str) -> list[dict]:
        # Text-only path when:
        #   1. mmproj wasn't loaded (no vision capability), OR
        #   2. caller passed an empty screenshot (e.g., warm-up ping).
        # Sending image_url with empty/garbage data crashes some mmproj builds.
        if not self.has_vision or not screenshot_b64:
            return [
                {"role": "system", "content": system},
                {"role": "user", "content": user_text},
            ]
        return [
            {"role": "system", "content": system},
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/png;base64,{screenshot_b64}"
                        },
                    },
                    {"type": "text", "text": user_text},
                ],
            },
        ]

    @staticmethod
    def _parse_xy(text: str) -> tuple[int, int] | None:
        try:
            obj = json.loads(text)
            return int(obj["x"]), int(obj["y"])
        except Exception:
            pass
        nums = re.findall(r"\d+", text)
        if len(nums) >= 2:
            return int(nums[0]), int(nums[1])
        return None


# ---------------------------------------------------------------------------
# HTTP surface (auth-gated).
# ---------------------------------------------------------------------------

def _check_auth(authorization: str | None) -> None:
    from fastapi import HTTPException

    expected = os.environ.get("TOKEN")
    if not expected:
        raise HTTPException(status_code=500, detail="server: TOKEN not configured")
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    if authorization.split(None, 1)[1] != expected:
        raise HTTPException(status_code=403, detail="bad token")


@app.function(image=image, secrets=[auth_secret], min_containers=0)
@modal.fastapi_endpoint(method="GET", docs=True)
def health() -> dict[str, Any]:
    return {"ok": True, "ts": time.time()}


@app.function(image=image, secrets=[auth_secret], timeout=600)
@modal.fastapi_endpoint(method="POST", docs=True)
def warm(
    request: dict[str, Any] | None = None,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    """Force a container up. Returns when llama-server is healthy.

    Text-only ping: 1x1 PNGs crash some mmproj vision encoders, and we don't
    need to verify vision works during warmup — we just need the model
    weights resident in GPU memory and llama-server responsive.
    """
    _check_auth(authorization)
    holo3 = Holo3()
    t0 = time.time()
    # Empty screenshot_b64 → _messages() falls back to the text-only path
    # (no image_url part in the user content list).
    holo3.plan.remote("warmup ping", [], "", 0, 0)
    return {"ready": True, "warm_seconds": round(time.time() - t0, 2)}


@app.function(image=image, secrets=[auth_secret], timeout=120)
@modal.fastapi_endpoint(method="POST", docs=True)
def plan_endpoint(
    body: dict[str, Any],
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    _check_auth(authorization)
    holo3 = Holo3()
    return holo3.plan.remote(
        body["task"],
        body.get("history", []),
        body["screenshot_b64"],
        int(body.get("screen", [0, 0])[0]),
        int(body.get("screen", [0, 0])[1]),
    )


@app.function(image=image, secrets=[auth_secret], timeout=120)
@modal.fastapi_endpoint(method="POST", docs=True)
def ground_endpoint(
    body: dict[str, Any],
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    _check_auth(authorization)
    holo3 = Holo3()
    return holo3.ground.remote(
        body["instruction"],
        body["screenshot_b64"],
        int(body.get("screen", [0, 0])[0]),
        int(body.get("screen", [0, 0])[1]),
    )
