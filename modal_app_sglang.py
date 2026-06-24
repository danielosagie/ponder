"""
Holo 3.1 (35B-A3B, FP8 safetensors) served via SGLang + a FastAPI shim exposing
/warm, /plan, /step, /ground, /ground/batch, /health — SAME contract as the
llama.cpp version (modal_app.py), so the TS client (remote.ts) is unchanged.

Why SGLang instead of llama.cpp:
  - Optimized vision prefill (Flash-Attn-3 vision backend, chunked prefill) +
    RadixAttention caches the screenshot prefix across the plan→ground split —
    the per-step bottleneck is the vision-encoder forward pass, which SGLang's
    kernels accelerate ~2-3x vs llama.cpp's mmproj path.
  - Loads the OFFICIAL FP8 checkpoint (Hcompany/Holo-3.1-35B-A3B-FP8, arch
    Qwen3_5MoeForConditionalGeneration) directly — no GGUF, no on-load quant.
  - Constrained JSON via XGrammar EBNF (`ebnf` request field) — our GBNF
    grammars port near-verbatim.

Coordinates are 0-1000 normalized (model-side); this server rescales to pixel
space from the request's screen size, identical to the llama.cpp version.
A boot-time grammar smoke test fails the container loudly if EBNF+vision
grounding doesn't return parseable {x,y} (the #1 migration risk).

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
# NB: no `from fastapi import Header` — the bench build has no web endpoints, and
# importing fastapi here drags in pydantic→typing_extensions, which is mismatched
# in the SGLang image (Sentinel ImportError). Re-add (with a typing_extensions
# upgrade) only when wiring the web endpoints back for the production cutover.

# ---------------------------------------------------------------------------
# Image: SGLang's official server image (CUDA + flashinfer + the engine
# prebuilt — no source build, no CMAKE dance). `.entrypoint([])` clears the
# image's default entrypoint so Modal can run our function code. Track a recent
# tag for Qwen3.5-MoE-VL support; PIN deliberately once A/B-validated (like the
# old llama.cpp b9082 pin).
# ---------------------------------------------------------------------------

SGLANG_IMAGE_TAG = os.environ.get("SGLANG_TAG", "lmsysorg/sglang:latest")

image = (
    # No add_python — use the image's OWN python (it has sglang installed);
    # adding a separate 3.11 would shadow it and `python3 -m sglang` would
    # import from the wrong interpreter. pip_install lands our deps in that
    # same python alongside sglang + Modal's injected client.
    modal.Image.from_registry(SGLANG_IMAGE_TAG)
    .entrypoint([])
    # httpx (proxy client) + Pillow (crop/upscale).
    .pip_install("httpx", "Pillow")
    # typing_extensions>=4.13: the sglang:latest image ships a pydantic/
    # pydantic_core that imports `typing_extensions.Sentinel` (added in 4.13)
    # against an OLDER typing_extensions — so even `sglang.launch_server` crashes
    # on its own pydantic import. A plain pip pin can be skipped by a stale layer
    # (the bug you hit). --force-reinstall busts that cache and overwrites the
    # dist-packages copy in place; the import check then fails the BUILD (not the
    # cold start) if Sentinel is STILL missing, so we never deploy a dead image
    # again. Do NOT touch huggingface_hub/transformers (downgrading broke them).
    .run_commands(
        "python3 -m pip install --no-cache-dir --upgrade --force-reinstall "
        "'typing_extensions>=4.13.2'",
        "python3 -c 'from typing_extensions import Sentinel; "
        'import typing_extensions as te; print("typing_extensions", te.__version__, "Sentinel OK")\'',
    )
)

app = modal.App("holo3-agent-sglang")
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
# Holo 3.1 official FP8 (block) safetensors (arch Qwen3_5MoeForConditionalGeneration).
# Both quantized checkpoints need Hopper: FP8-block + NVFP4(w4afp8) require GPU
# capability >= 90 (H100); A100/L40S (capability 80/89) reject them. On H100 the
# native block-FP8 path loads fine. (Already on the volume — no re-download.)
HF_REPO = "Hcompany/Holo-3.1-35B-A3B-FP8"
MODEL_LOCAL_DIR = f"{MODELS_DIR}/Holo-3.1-35B-A3B-FP8"  # snapshot dir on the volume

SGLANG_PORT = 30000  # SGLang server default; we proxy to it over 127.0.0.1

# XGrammar EBNF (passed as the `ebnf` request field) constraining {"x":int,"y":int}.
# Near-identical to the old llama.cpp GBNF — XGrammar's EBNF is GBNF-derived.
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
# One-shot: snapshot the FP8 safetensors repo into the Volume.
#   modal run modal_app_sglang.py::download_model
# ---------------------------------------------------------------------------

@app.function(image=image, volumes={MODELS_DIR: volume}, timeout=60 * 60)
def download_model() -> str:
    from huggingface_hub import snapshot_download

    os.makedirs(MODEL_LOCAL_DIR, exist_ok=True)
    snapshot_download(
        repo_id=HF_REPO,
        local_dir=MODEL_LOCAL_DIR,
        # safetensors + config + tokenizer + chat template; skip the GGUF/onnx
        # variants if the repo mixes them.
        allow_patterns=["*.safetensors", "*.json", "*.txt", "*.model", "*.jinja", "*.py"],
    )
    volume.commit()
    total = sum(
        os.path.getsize(os.path.join(MODEL_LOCAL_DIR, f))
        for f in os.listdir(MODEL_LOCAL_DIR)
        if os.path.isfile(os.path.join(MODEL_LOCAL_DIR, f))
    )
    return f"snapshot: {MODEL_LOCAL_DIR} ({total / 1e9:.1f} GB, {len(os.listdir(MODEL_LOCAL_DIR))} files)"


# ---------------------------------------------------------------------------
# Inference container — boots sglang.launch_server and proxies to it.
# ---------------------------------------------------------------------------

@app.cls(
    image=image,
    gpu="H100",  # REQUIRED for Holo's quantized checkpoints: FP8-block + NVFP4
    # both need GPU capability >=90 (Hopper); A100(80)/L40S(89) reject them. This
    # is the SPEED-CEILING test — H100 native block-FP8 + SGLang's optimized vision
    # kernels. Cold-start ~150s is the known H100 cost; keep-warm-while-open
    # amortizes it. If warm per-step ≈ 0.5s (3x vs llama.cpp 1.4s), it's the win.
    volumes={MODELS_DIR: volume},
    secrets=[auth_secret],
    scaledown_window=600,
    timeout=60 * 30,
    min_containers=0,
    max_containers=4,
)
@modal.concurrent(max_inputs=8)  # SGLang continuous-batches internally; no per-slot cap
class Holo3:
    @modal.enter()
    def start(self) -> None:
        import httpx

        if not os.path.isdir(MODEL_LOCAL_DIR) or not os.listdir(MODEL_LOCAL_DIR):
            raise RuntimeError(
                f"Model not found at {MODEL_LOCAL_DIR}. "
                "Run `modal run modal_app_sglang.py::download_model` first."
            )

        cmd = [
            "python3", "-m", "sglang.launch_server",
            "--model-path", MODEL_LOCAL_DIR,
            "--host", "127.0.0.1",
            "--port", str(SGLANG_PORT),
            "--trust-remote-code",          # required for the Qwen3.5-derived arch
            "--context-length", "32768",
            "--chunked-prefill-size", "8192",  # chunk the ~4k-token image prefill
            "--grammar-backend", "xgrammar",   # EBNF structured output (our `ebnf` field)
            "--mem-fraction-static", "0.85",
            # NB: NOT --mm-attention-backend fa3 — FA3 is Hopper-only; A100/L40S use
            # SGLang's default vision attention. The speedup vs llama.cpp comes from
            # SGLang's optimized vision kernels + RadixAttention (caches the screenshot
            # prefix across the plan→ground split) + chunked prefill. FP8 is auto-detected
            # from the checkpoint's config — no --quantization flag needed.
        ]
        print(f"Spawning: {' '.join(cmd)}", flush=True)
        self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

        self.client = httpx.Client(
            base_url=f"http://127.0.0.1:{SGLANG_PORT}",
            timeout=httpx.Timeout(180.0, connect=5.0),
        )
        self.aclient = httpx.AsyncClient(
            base_url=f"http://127.0.0.1:{SGLANG_PORT}",
            timeout=httpx.Timeout(180.0, connect=5.0),
        )

        # Poll /health until ready (SGLang reports healthy after the model loads).
        deadline = time.time() + 900  # 15 min cap (FP8 safetensors load is slower first time)
        while time.time() < deadline:
            if self.proc.poll() is not None:
                tail = self.proc.stdout.read().decode("utf-8", "replace") if self.proc.stdout else ""
                raise RuntimeError(f"sglang server exited early. Last output:\n{tail[-3000:]}")
            try:
                r = self.client.get("/health", timeout=2)
                if r.status_code == 200:
                    break
            except Exception:
                pass
            time.sleep(1)
        else:
            raise RuntimeError("sglang server did not become healthy within 15 min")

        self.has_vision = True

        # BOOT grammar smoke test — the #1 migration risk is that XGrammar EBNF
        # + structured output is broken on this model. Text-only (no image, so no
        # vision-encoder crash) so it cheaply asserts the grammar COMPILES and
        # CONSTRAINS output to parseable {"x":int,"y":int}. Fail the container
        # LOUDLY (mirrors the old `test -x llama-server` build guard) so we never
        # serve traffic with a broken grammar; the A/B is the accuracy net.
        try:
            smoke = self.client.post("/v1/chat/completions", json={
                "messages": [
                    {"role": "system", "content": 'Return JSON {"x":int,"y":int}.'},
                    {"role": "user", "content": 'Return {"x": 5, "y": 7}.'},
                ],
                "temperature": 0.0, "max_tokens": 64,
                "ebnf": GROUND_GRAMMAR,
                "chat_template_kwargs": {"enable_thinking": False},
            }, timeout=60)
            raw = _strip_think(smoke.json()["choices"][0]["message"]["content"])
            if self._parse_xy(raw) is None:
                raise RuntimeError(f"grammar smoke test returned non-{{x,y}}: {raw[:200]!r}")
        except Exception as e:
            raise RuntimeError(f"BOOT grammar smoke test FAILED (EBNF structured output broken on Holo?): {e}")

        print("sglang server ready (vision=True, grammar OK)", flush=True)

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
                "ebnf": STEP_GRAMMAR,
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
            "ebnf": GROUND_GRAMMAR,
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
            "ebnf": GROUND_GRAMMAR,
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
# A/B bench — a REMOTE function so it survives local disconnects during the
# long A100 cold-start (a plain `modal run` local entrypoint drops connection).
# NO web functions (Modal plan caps web fns at 8; the llama.cpp app uses them).
# Uses a synthetic realistic-size image: the vision patch count (= prefill cost)
# is set by resolution, NOT content, so this measures the TRUE per-step latency.
#   modal run --detach modal_app_sglang.py::bench_remote
#   then: modal app logs holo3-agent-sglang   (or read the returned string)
# ---------------------------------------------------------------------------

@app.function(image=image, volumes={MODELS_DIR: volume}, secrets=[auth_secret], timeout=1800)
def bench_remote(reps: int = 5) -> str:
    import base64, io, time as _t
    from PIL import Image, ImageDraw

    w, h = 1456, 816  # realistic browser viewport → same patch count as a real screenshot
    img = Image.new("RGB", (w, h), (242, 243, 247))
    d = ImageDraw.Draw(img)
    for i in range(36):
        x, y = (i % 6) * 230 + 20, (i // 6) * 120 + 20
        d.rectangle([x, y, x + 200, y + 90], outline=(70, 80, 95), fill=(205, 215, 228))
        d.text((x + 12, y + 36), f"Button {i}", fill=(15, 20, 35))
    buf = io.BytesIO(); img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()

    lines = [f"synthetic {w}x{h}, {len(buf.getvalue())} bytes — SGLang A100 FP8 (vs llama.cpp L40S ~1.4s warm)"]
    holo = Holo3()
    for i in range(reps):
        t0 = _t.time()
        out = holo.ground.remote("the Button 20 rectangle", b64, w, h)
        dt = _t.time() - t0
        kind = "COLD" if i == 0 else "warm"
        line = (f"  [{kind}] {dt:6.2f}s  x={out.get('x')} y={out.get('y')} "
                f"usage={out.get('usage', {})} err={out.get('error')}")
        print(line, flush=True)
        lines.append(line)
    return "\n".join(lines)
