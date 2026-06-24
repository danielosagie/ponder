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
        # PINNED to llama.cpp tag b9082 (released ~2026-05-08, before the
        # May-10 changes that broke our deploy). Without the pin, --depth 1
        # tracked main and a recent rebuild pulled mmproj changes that
        # (a) produce ~30 more image-tokens per screenshot (pushed prompts
        # over the prior 4096 per-slot ceiling) and (b) made each forward
        # pass over the image patches ~30× slower (~9.7s/target on L4 vs.
        # ~0.33s/target previously). See bench/results/calculator-mouse-
        # math-batched-opus-2026-05-10T16-48-14Z.json modal_inference_
        # regression for the diagnosis. Bump this tag deliberately when
        # you're ready to absorb behavior changes.
        "git clone --depth 1 --branch b9082 https://github.com/ggml-org/llama.cpp /opt/llama.cpp || "
        "git clone --depth 1 --branch b9082 https://github.com/ggerganov/llama.cpp /opt/llama.cpp",
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
        # For server-side cropping in /ground/batch when callers pass a
        # `crop` rect (e.g. agent_click_sequence with targetApp). Tiny
        # wheel, native via libjpeg/zlib already in the CUDA image.
        "Pillow==11.0.0",
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
    # Orphan CLOSING tag with no opener (live-observed 2026-06-10: the
    # model emitted reasoning prose directly, then "</think>", then ran
    # out of budget — the prose leaked through as the "action"). All
    # complete pairs are already gone, so anything before a remaining
    # </think> is reasoning; the answer (if any) is after it.
    close_idx = out.rfind("</think>")
    if close_idx != -1:
        out = out[close_idx + len("</think>"):]
    return out.strip()


def _shrink_for_ctx(task: str) -> str:
    """Recovery for 'request exceeds the available context size' (8192/slot):
    the overwhelmingly common cause is a huge [CHROME ACTIVE …] AX-snapshot
    block appended to the task by the client. Drop it (the screenshot still
    shows the page); as a last resort hard-cap the task text."""
    marker = task.find("[CHROME ACTIVE")
    if marker != -1:
        return task[:marker] + "\n[page snapshot omitted: prompt was too large]"
    return task[:6000]


def _is_ctx_overflow(err: Exception) -> bool:
    return "exceeds the available context" in str(err)


MODELS_DIR = "/models"
# Holo 3.1 (official H Company GGUF) — was mudler's Holo3-35B-A3B-APEX (3.0, deprecated 2026-06-15).
HF_REPO = "Hcompany/Holo-3.1-35B-A3B-GGUF"
GGUF_FILENAME = os.environ.get("HOLO3_GGUF", "q4_k_m.gguf")  # 21.3 GB Q4_K_M
MMPROJ_FILENAME = "mmproj.f16.gguf"  # vision projector, 899 MB
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

# Combined plan+ground (/step): one forward pass yields the action AND,
# for mouse-aimed verbs, the click point. Halves per-step model time vs
# the sequential /plan → /ground pair (each of which re-uploads the
# screenshot and re-runs the vision tower on it). Coordinates are null
# for keyboard/scroll/wait/DONE verbs and for drag (drag needs TWO
# points — it stays on the split path).
STEP_GRAMMAR = (
    'root   ::= "{" ws "\\"action\\"" ws ":" ws string ws "," ws'
    ' "\\"x\\"" ws ":" ws coord ws "," ws "\\"y\\"" ws ":" ws coord ws "}"\n'
    'coord  ::= number | "null"\n'
    "number ::= [0-9]+\n"
    'string ::= "\\"" char* "\\""\n'
    'char   ::= [^"\\\\\\x00-\\x1f] | "\\\\" esc\n'
    'esc    ::= ["\\\\/bfnrt] | "u" hex hex hex hex\n'
    "hex    ::= [0-9a-fA-F]\n"
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
    gpu="L40S",  # 48GB. KEPT after measuring H100 (2026-06-17): H100 is ~3x faster on the
    # prefill-bound vision step WHEN WARM, but Modal H100 cold-start/scheduling is ~150s
    # (capacity-constrained) vs L40S ~22s — a net LOSS for on-demand (min_containers=0,
    # cold-starts often). L40S also has comparable BF16 TFLOPS to A100 (~362 vs ~312), so
    # A100 wouldn't speed the compute-bound prefill much either. The real per-step lever is
    # trimming screenshot tokens, not the GPU. Holo 3.1 q4_k_m 21.3GB + 0.9GB mmproj fit fine.
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
            # Context budget. With --parallel 4 below, llama.cpp splits
            # this into 4 KV-cache slots (-c / --parallel = per-slot
            # ceiling). For grounding the prompt is ~50 tokens of text
            # plus the mmproj's image patches; for an L4-typical screen
            # capture the patch count alone is ~4000-4100 tokens. The
            # 16384/4 = 4096 per-slot budget we previously ran with was
            # JUST under that — we got bitten by a rebuild that nudged
            # the patch tokenizer slightly, pushing prompts to 4119-4127
            # tokens and producing exceed_context_size_error 400s on
            # every grounding call (see commit log).
            #
            # 32768/4 = 8192 per slot doubles the headroom, comfortably
            # absorbs any future patch-tokenizer drift, and stays well
            # within the L4's 24 GB total (model ~17 GB; the extra KV
            # cache is ~4-6 GB).
            "-c", "32768",
            # CONTINUOUS BATCHING — the unlock for ground_batch and for
            # parallel agent_click_sequence-style fan-outs. Without this,
            # llama-server processes ONE request at a time even when the
            # Modal class is configured for max_inputs=4 — the four
            # concurrent in-flight Modal calls all serialize through the
            # single llama-server inference slot, defeating the point.
            # With --parallel 4, llama.cpp interleaves up to 4 prompts in
            # the same forward pass; total throughput for batches ≤ 4 ≈
            # one request's wall time + a small overhead, which is
            # exactly what makes the batch endpoint a 4× speedup instead
            # of a wash.
            "--parallel", "4",
            # PREFILL SPEEDUP (no resolution/accuracy change — same image, fewer
            # GPU-seconds = faster AND cheaper per step):
            #  -fa: flash attention. The per-step cost is prefill of the ~4k-token
            #       screenshot; FA makes that attention faster and frees KV memory.
            #  -ub 2048: physical micro-batch. Default 512 splits a 4k-token image
            #       prefill into 8 passes; 2048 does it in 2 → much better GPU use.
            #  -b 4096: logical batch ceiling to match.
            "-fa",
            "-b", "4096",
            "-ub", "2048",
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
        # Separate async client so ground_batch() can fire N concurrent
        # POSTs to llama-server's --parallel slots via asyncio.gather.
        # httpx's sync Client and AsyncClient are independent — keeping
        # both means the existing sync ground()/plan() methods don't have
        # to change, and ground_batch can use the async path natively.
        self.aclient = httpx.AsyncClient(
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
            "\n"
            "If the Task text says Chrome is ACTIVE and lists [eN] element refs,\n"
            "these browser actions are ALSO valid — PREFER them for anything\n"
            "inside the web page (faster and more precise than pixel clicks):\n"
            "  - browser.navigate <url>      (e.g. browser.navigate https://www.google.com/search?q=...)\n"
            "  - browser.click e<N>\n"
            "  - browser.type e<N> \"text\" [enter]\n"
            "  - browser.read\n"
            "  - browser.scroll up / browser.scroll down\n"
            "Return ONLY one action sentence (or DONE). No commentary, no JSON, "
            "no chained actions."
        )
        user_text = (
            f"Task: {task}\n"
            f"Screen: {screen_w}x{screen_h}\n"
            f"Recent history:\n{history_block}{dup_warning}\n"
            "What is the next single action?"
        )

        def run_plan(task_text: str) -> dict[str, Any]:
            ut = (
                f"Task: {task_text}\n"
                f"Screen: {screen_w}x{screen_h}\n"
                f"Recent history:\n{history_block}{dup_warning}\n"
                "What is the next single action?"
            )
            body = {
                "messages": self._messages(system, ut, screenshot_b64),
                "temperature": 0.2,
                "max_tokens": 256,
                "stop": ["\n\n"],
                "chat_template_kwargs": {"enable_thinking": False},
            }
            r = self.client.post("/v1/chat/completions", json=body)
            if r.status_code != 200:
                raise RuntimeError(
                    f"llama-server /v1/chat/completions returned {r.status_code}: "
                    f"{r.text[:600]}"
                )
            return r.json()

        try:
            out = run_plan(task)
        except RuntimeError as e:
            if not _is_ctx_overflow(e):
                raise
            out = run_plan(_shrink_for_ctx(task))
        text = _strip_think(out["choices"][0]["message"]["content"])
        return {"action": text, "usage": out.get("usage", {})}



    # ---- Brain+Eyes combined (one forward pass) ----

    @modal.method()
    def step(
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
            "\n"
            "If the Task text says Chrome is ACTIVE and lists [eN] element refs,\n"
            "these browser actions are ALSO valid — PREFER them for anything\n"
            "inside the web page (faster and more precise than pixel clicks):\n"
            "  - browser.navigate <url>      (e.g. browser.navigate https://www.google.com/search?q=...)\n"
            "  - browser.click e<N>\n"
            "  - browser.type e<N> \"text\" [enter]\n"
            "  - browser.read\n"
            "  - browser.scroll up / browser.scroll down\n"
            "browser.* actions take x = null and y = null.\n"
            "Reply with ONLY this JSON object, nothing else:\n"
            '{"action": "<one action sentence>", "x": <int|null>, "y": <int|null>}\n'
            "- action is the COMPLETE action sentence naming the target —\n"
            "  NEVER a bare verb like \"click\" or \"press\".\n"
            "- For click / double click: x,y = the exact point to click, as\n"
            "  integers normalized to a 1000x1000 grid over the screenshot.\n"
            "- For type/press/hotkey/scroll/wait/DONE and for drag: x and y\n"
            "  are null (drag endpoints are grounded separately).\n"
            "\n"
            "Example replies (format only — pick YOUR action from the screen):\n"
            '{"action": "click the blue Submit button", "x": 512, "y": 833}\n'
            '{"action": "double click the report.pdf file icon", "x": 217, "y": 405}\n'
            '{"action": "type \\"47*8\\"", "x": null, "y": null}\n'
            '{"action": "press enter", "x": null, "y": null}\n'
            '{"action": "hotkey cmd+space", "x": null, "y": null}\n'
            '{"action": "drag the file icon to the trash", "x": null, "y": null}\n'
            '{"action": "DONE", "x": null, "y": null}'
        )
        user_text = (
            f"Task: {task}\n"
            f"Screen: {screen_w}x{screen_h}\n"
            f"Recent history:\n{history_block}{dup_warning}\n"
            "What is the next single action?"
        )

        def call(messages: list[dict[str, Any]]) -> dict[str, Any]:
            body = {
                "messages": messages,
                # Deterministic: the grammar pins the shape; temperature 0
                # pins the choice (the dup-warning + growing history break
                # loops, not sampling noise).
                "temperature": 0.0,
                # Action sentence + coords fit comfortably; 384 leaves
                # headroom for long type-"..." payloads.
                "max_tokens": 384,
                "grammar": STEP_GRAMMAR,
                "chat_template_kwargs": {"enable_thinking": False},
            }
            r = self.client.post("/v1/chat/completions", json=body)
            if r.status_code != 200:
                raise RuntimeError(
                    f"llama-server /v1/chat/completions returned "
                    f"{r.status_code}: {r.text[:600]}"
                )
            return r.json()

        messages = self._messages(system, user_text, screenshot_b64)
        try:
            out = call(messages)
        except RuntimeError as e:
            if not _is_ctx_overflow(e):
                raise
            # Prompt blew the 8192/slot ctx (huge AX snapshot in the task).
            # Drop the snapshot block and retry once.
            user_text = (
                f"Task: {_shrink_for_ctx(task)}\n"
                f"Screen: {screen_w}x{screen_h}\n"
                f"Recent history:\n{history_block}{dup_warning}\n"
                "What is the next single action?"
            )
            messages = self._messages(system, user_text, screenshot_b64)
            out = call(messages)
        raw = _strip_think(out["choices"][0]["message"]["content"])
        try:
            parsed = json.loads(raw)
        except (ValueError, TypeError):
            # Grammar should make this unreachable; degrade to plan-shaped
            # output so the client's split-path fallback grounds separately.
            return {"action": raw.strip(), "x": None, "y": None,
                    "usage": out.get("usage", {})}
        action = str(parsed.get("action") or "").strip()

        # Malformed-action guard: under grammar-constrained greedy decoding
        # the model occasionally emits just the verb ("click", "press") or
        # nests JSON inside the action string ('{"action": "click", "x": …'
        # until the token cap) — both useless for history/recipes and
        # unparseable client-side. ONE corrective retry with the malformed
        # reply echoed back.
        bare_verbs = {"click", "double", "double click", "right click",
                      "press", "hotkey", "type", "drag", "scroll", "wait"}
        finish = out["choices"][0].get("finish_reason")
        malformed = (
            action.lower() in bare_verbs
            or action.lstrip().startswith("{")
            or '"action"' in action
            or finish == "length"
        )
        if malformed:
            retry_messages = messages + [
                {"role": "assistant", "content": raw},
                {"role": "user", "content": (
                    f'Your reply was malformed (action was "{action[:60]}"). '
                    "Reply again with ONE short JSON object whose action is a "
                    "COMPLETE action sentence naming the target or key (e.g. "
                    '{"action": "click the 7 button", "x": 374, "y": 512} or '
                    '{"action": "press enter", "x": null, "y": null}). '
                    "Do NOT nest JSON inside the action string."
                )},
            ]
            out = call(retry_messages)
            raw = _strip_think(out["choices"][0]["message"]["content"])
            try:
                parsed = json.loads(raw)
                action = str(parsed.get("action") or "").strip()
            except (ValueError, TypeError):
                pass  # keep the bare verb; client falls back to split path
        rx, ry = parsed.get("x"), parsed.get("y")
        if isinstance(rx, (int, float)) and isinstance(ry, (int, float)):
            x = int(round((rx / 1000.0) * screen_w)) if rx <= 1000 else int(rx)
            y = int(round((ry / 1000.0) * screen_h)) if ry <= 1000 else int(ry)
            x = max(0, min(screen_w - 1, x))
            y = max(0, min(screen_h - 1, y))
            return {"action": action, "x": x, "y": y, "raw": [rx, ry],
                    "usage": out.get("usage", {})}
        return {"action": action, "x": None, "y": None,
                "usage": out.get("usage", {})}

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

    # ---- Eyes (batched grounder) ----

    async def _ground_one_async(
        self,
        instruction: str,
        screenshot_b64: str,
        screen_w: int,
        screen_h: int,
    ) -> dict[str, Any]:
        """Async single-target grounding. Same shape as ground() but uses
        the async httpx client so multiple calls can fan out to
        llama-server's --parallel slots simultaneously via asyncio.gather.

        Returns the same dict shape as ground() — caller (ground_batch)
        builds a list[dict] and the endpoint forwards it. Errors are
        returned as {"error": ..., "raw_text": ...} so a partial batch
        success is representable (vs. raising and aborting the whole
        batch on a single bad target).
        """
        system = (
            "You return (x,y) coordinates to click as JSON: "
            "{\"x\": <int 0-1000>, \"y\": <int 0-1000>} "
            "where coordinates are normalized to a 1000x1000 grid over the screenshot."
        )
        user_text = f"Click target: {instruction}"

        body = {
            "messages": self._messages(system, user_text, screenshot_b64),
            "temperature": 0.0,
            "max_tokens": 256,
            "grammar": GROUND_GRAMMAR,
            "chat_template_kwargs": {"enable_thinking": False},
        }
        try:
            r = await self.aclient.post("/v1/chat/completions", json=body)
        except Exception as e:
            return {"error": f"llama-server request failed: {e!r}"}
        if r.status_code != 200:
            return {
                "error": (
                    f"llama-server /v1/chat/completions returned {r.status_code}: "
                    f"{r.text[:300]}"
                )
            }
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

    @modal.method()
    async def ground_batch(
        self,
        instructions: list[str],
        screenshot_b64: str,
        screen_w: int,
        screen_h: int,
        crop: dict[str, int] | None = None,
        upscale: float | None = None,
    ) -> list[dict[str, Any]]:
        """Ground N instructions against ONE screenshot.

        Mechanically: fires N concurrent POSTs to llama-server via the
        async client, all sharing the same screenshot bytes (the image
        is encoded once in this Python process and embedded in each
        request's content list). With --parallel 4 on llama-server,
        up to 4 prompts run in the same forward pass; for batches > 4,
        the extra requests queue at llama-server's level (not Modal's),
        so we don't burn additional containers.

        Wall time ≈ ceil(N / 4) × per-request-time + small overhead,
        vs. N × per-request-time for sequential single calls. For N=6
        on an L4 that typically lands at ~5s vs. ~15s.

        When `crop` is set ({"x", "y", "w", "h"} in screenshot-pixel
        space), the screenshot is decoded with PIL, cropped to that
        rect, and re-encoded before grounding. The grounded coords
        come back in CROPPED-image space — the client must translate
        back with `actual_x = result.x + crop.x`. Used to defend the
        "embedded-screenshot decoy": when the chat is showing the
        same app's screenshot on the same display as the real app,
        cropping to just the real app's window deletes the decoy
        from the model's input. Adds ~10-30ms PIL cost for typical
        screen sizes — negligible vs. inference.

        Returns a list of N dicts in the SAME order as `instructions`.
        Each dict is either `{"x":int,"y":int,"raw":[...],"usage":{...}}`
        on success or `{"error": str, ...}` on per-target failure —
        callers handle partial success.
        """
        import asyncio

        # Crop happens ONCE, then every grounding call shares the cropped
        # image. Bail-on-error: if PIL crop fails (truncated PNG, OOB
        # rect), fall through to the un-cropped path so the sequence
        # still has a chance to land. Caller's bounds validation will
        # catch any decoy mis-grounding either way.
        effective_b64 = screenshot_b64
        effective_w = screen_w
        effective_h = screen_h
        if crop:
            try:
                from PIL import Image
                import io

                cx = int(crop.get("x", 0))
                cy = int(crop.get("y", 0))
                cw = int(crop.get("w", 0))
                ch = int(crop.get("h", 0))
                if cw > 0 and ch > 0:
                    raw = base64.b64decode(screenshot_b64)
                    img = Image.open(io.BytesIO(raw))
                    # Clamp the rect to the image so a bounds-off crop
                    # (caller's screen-space math was wrong) returns SOME
                    # image instead of throwing.
                    iw, ih = img.size
                    left = max(0, min(iw, cx))
                    upper = max(0, min(ih, cy))
                    right = max(left, min(iw, cx + cw))
                    lower = max(upper, min(ih, cy + ch))
                    if right > left and lower > upper:
                        cropped = img.crop((left, upper, right, lower))
                        # UPSCALE: when set, resize the cropped image
                        # by `upscale` factor before grounding. The
                        # field of view is unchanged (still just the
                        # target window) — we just give the model more
                        # pixels per UI element. The grounded coords
                        # come back in the UPSCALED image's space
                        # (0–upscaled_w by 0–upscaled_h); we pass the
                        # upscaled dims as effective_w/effective_h so
                        # the model's 0–1000 normalized output scales
                        # to the upscaled image and we divide back
                        # afterwards.
                        #
                        # CRITICAL: we report `effective_w/effective_h`
                        # to the model and to llama-server as the
                        # SCREEN dims. The model's pixel coordinates
                        # come back in this space. The caller needs to
                        # DIVIDE returned coords by `upscale` to get
                        # coords in the original cropped-image space,
                        # then add crop.x/y to translate to screen.
                        # We do that division on the server here so
                        # callers see coords in cropped-image space
                        # regardless of upscale factor (so existing
                        # client code doesn't need to know about it).
                        if upscale and upscale > 1.0:
                            ucw = int((right - left) * upscale)
                            uch = int((lower - upper) * upscale)
                            cropped = cropped.resize(
                                (ucw, uch),
                                Image.LANCZOS,
                            )
                            print(
                                f"[ground_batch] upscale {upscale}x: "
                                f"{right - left}x{lower - upper} → {ucw}x{uch}"
                            )
                        buf = io.BytesIO()
                        cropped.save(buf, format="PNG")
                        effective_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
                        # Report effective dims at the UPSCALED size so
                        # the model's 0-1000 normalized output maps
                        # onto upscaled pixels — more spatial budget.
                        effective_w = cropped.size[0]
                        effective_h = cropped.size[1]
            except Exception as e:
                # Log to stderr so the failure is visible in modal logs,
                # but don't fail the request — un-cropped grounding is
                # still useful, just lacks the decoy defense.
                print(f"[ground_batch] crop failed: {e}; using uncropped")

        results = await asyncio.gather(
            *[
                self._ground_one_async(instr, effective_b64, effective_w, effective_h)
                for instr in instructions
            ]
        )
        # If we upscaled, the returned x/y are in upscaled-image space.
        # Divide by upscale so the caller receives coords in the
        # ORIGINAL cropped-image space — keeps the client-side coord
        # translation (`screen_x = result.x + crop.x`) unchanged.
        if upscale and upscale > 1.0 and crop:
            for r in results:
                if isinstance(r, dict) and "x" in r and "y" in r:
                    r["x"] = int(round(r["x"] / upscale))
                    r["y"] = int(round(r["y"] / upscale))
                    # Also annotate so curl tests can see what happened.
                    r["upscale_applied"] = upscale
        return results

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
def step_endpoint(
    body: dict[str, Any],
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    """Combined plan+ground: one model call → {"action", "x", "y"}.

    Same request shape as /plan. x/y are SCREEN-space ints (already
    rescaled from the 0-1000 grid server-side, like /ground) or null
    for keyboard/scroll/wait/DONE/drag actions. Clients treat null
    coords on a mouse-aimed action as "fall back to /ground".
    """
    _check_auth(authorization)
    holo3 = Holo3()
    return holo3.step.remote(
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


# Batch grounding: ONE screenshot + N instructions → N coords. The win over
# N parallel calls to /ground (the existing endpoint) is two-fold:
#   1. The screenshot is uploaded ONCE over the wire instead of N times.
#      For a 1-3 MB PNG and a batch of 6, that's 5-15 MB and ~half a
#      second of bandwidth saved on a typical home connection.
#   2. The single Modal call routes to ONE container's --parallel 4 slots
#      instead of fanning out to N independent containers — keeps the
#      L4 GPU resident and avoids cold-start churn for batches > 4.
#
# Timeout is 5 min (vs. 2 min for /ground) so a worst-case batch of 12
# targets hitting a cold container can complete without a 504. Each
# inference still has its own 120s ceiling inside the model method.
@app.function(image=image, secrets=[auth_secret], timeout=300)
@modal.fastapi_endpoint(method="POST", docs=True)
def ground_batch_endpoint(
    body: dict[str, Any],
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    _check_auth(authorization)
    instructions = body.get("instructions") or []
    if not isinstance(instructions, list) or not instructions:
        return {"error": "instructions must be a non-empty list of strings"}
    if not all(isinstance(s, str) and s.strip() for s in instructions):
        return {"error": "every instruction must be a non-empty string"}
    if len(instructions) > 16:
        return {
            "error": (
                f"max 16 instructions per batch (got {len(instructions)}). "
                "Split into multiple calls — long sequences usually hide a "
                "screen state-change that should split anyway."
            )
        }
    # Optional `crop` rect. When set, the server crops the screenshot
    # to that rect before grounding (defense against the embedded-
    # screenshot decoy used by `agent_click_sequence` with `targetApp`).
    # Coords come back in CROPPED-image space; client translates.
    crop = body.get("crop")
    if crop is not None:
        if not isinstance(crop, dict):
            return {"error": "crop must be an object {x, y, w, h}"}
        try:
            crop = {k: int(crop[k]) for k in ("x", "y", "w", "h")}
        except (KeyError, TypeError, ValueError):
            return {
                "error": "crop must contain integer x, y, w, h",
            }
        if crop["w"] <= 0 or crop["h"] <= 0:
            return {"error": "crop w and h must be positive"}

    # Optional `upscale` factor. When set (e.g. 2.0 or 3.0), the
    # cropped image is enlarged with PIL.Image.LANCZOS BEFORE
    # grounding. Same field of view, more pixels per UI element →
    # the model's 0-1000 normalized output maps onto a higher-
    # resolution coordinate space, so adjacent buttons get further
    # apart in normalized-unit space and are easier to distinguish.
    # Server reports coords back in the ORIGINAL cropped-image
    # space (divides by upscale before returning), so the client's
    # crop.x/y translation works unchanged. Validated May-11 on
    # Calculator's 230×408 keypad where 0–1000 normalization gave
    # only ~14 normalized units per 57px button — model jitter of
    # ±5 units routinely flipped buttons. At upscale 2.5×, units
    # per button rise to ~35, well above noise.
    upscale = body.get("upscale")
    if upscale is not None:
        try:
            upscale = float(upscale)
        except (TypeError, ValueError):
            return {"error": "upscale must be a number"}
        if upscale < 1.0 or upscale > 8.0:
            return {"error": "upscale must be in [1.0, 8.0]"}

    holo3 = Holo3()
    results = holo3.ground_batch.remote(
        instructions,
        body["screenshot_b64"],
        int(body.get("screen", [0, 0])[0]),
        int(body.get("screen", [0, 0])[1]),
        crop,
        upscale,
    )
    return {"results": results}
