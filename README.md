# ponder

Computer-use harness based off farza's clicky. Holo3-35B-A3B planner, hierarchical Ollama subtask manager, Convex for state, Modal for serverless GPU.

Cross-platform computer-use agent. Clicky-style cursor overlay for daily use, ollama-style history view in the full app, Holo3-35B-A3B served on Modal as the default backend, with a local Ollama toggle for offline. Convex for state and real-time UI.

## Quick start (M1, macOS)

```bash
# 1. Install deps
npm install

# 2. Bring Convex up — creates a free deployment, writes VITE_CONVEX_URL to .env.local
npx convex dev   # leave running in its own terminal

# 3. (Once) Deploy Modal app + populate the model volume
modal secret create holo3-agent-auth TOKEN=<random-strong-string>
modal run modal_app.py::download_model   # ~20GB, takes a while
modal deploy modal_app.py
# Copy the deployed URL (e.g. https://you--holo3-agent-plan-endpoint.modal.run)
# into MODAL_BASE_URL in .env (use the base, not the per-endpoint URL).

# 4. Start the app
cp .env.example .env
# edit .env: MODAL_BASE_URL, MODAL_BEARER_TOKEN, VITE_CONVEX_URL
npm run dev
```

The tray icon appears, the AppWindow opens (history view), and Modal warm-up kicks off in the background. Press ⌘⇧Space anywhere to summon the cursor overlay.

## Architecture

```
Electron (TS)      ┌─ Overlay window (cursor companion + chat)
                   ├─ App window    (ollama-style history)
                   └─ Tray + ⌘⇧Space hotkey
                          │
                          ▼ in-process agent loop
                   Brain → Eyes → Action  (ported from holo3-demo main.py)
                          │
            ┌─────────────┴─────────────┐
            │                           │
       Modal (Python)              Ollama (local)
       Holo3-35B-A3B-APEX          qwen2.5vl:7b
            │                           │
            └─────────────┬─────────────┘
                          ▼
                       Convex (sessions, steps, screenshots)
```

## Files

- `electron/main.ts` — tray, hotkey, IPC, window mgmt, agent kickoff
- `electron/windows.ts` — overlay (transparent, cursor-anchored) + app windows
- `src/agent/loop.ts` — Brain→Eyes→Action loop (port of `main.py:366-436`)
- `src/agent/providers/{remote,local}.ts` — Modal HTTP client / Ollama client
- `src/agent/warmup.ts` — startup warm-up + request queue
- `src/screen.ts` — `@nut-tree-fork/nut-js` wrapper (screenshot/click/type)
- `src/perms.ts` — macOS Accessibility / Screen Recording probes
- `src/renderer/overlay/Overlay.tsx` — cursor companion UI
- `src/renderer/app/App.tsx` — sessions list + detail view
- `convex/schema.ts` + `sessions.ts` + `steps.ts` — schema and functions
- `modal_app.py` — Modal deployment (only Python file)

## Permissions (macOS)

The app needs three permissions on first launch — System Settings → Privacy & Security:
1. **Accessibility** — for synthetic clicks/keyboard
2. **Screen Recording** — for screenshots
3. **Input Monitoring** — for the global ⌘⇧Space hotkey

The app probes these and surfaces a deep-link if anything is missing.

## Provider toggle

Tray icon → Provider → choose **Remote (Modal · Holo3)** or **Local (Ollama)**. Switching triggers a fresh warm-up; in-flight tasks complete on the previous provider.

## Local provider — always real Holo3

Run once per machine:

```bash
# default I-Compact (17.3GB) — Windows + 32GB RAM, or 24GB GPUs
bash scripts/setup-local.sh

# 16GB M1 (tight but possible)
TIER=I-Mini bash scripts/setup-local.sh

# bigger machine, more accuracy
TIER=I-Quality bash scripts/setup-local.sh
```

This downloads the chosen tier + the `mmproj.gguf` vision sidecar from `mudler/Holo3-35B-A3B-APEX-GGUF` and imports them into Ollama as `holo3` (via `scripts/Holo3.Modelfile`). The local provider always points at this model — no substitute. Override the Ollama model name with `OLLAMA_MODEL` in `.env` if you want to test alternatives.

## Modal — cheapest GPU

`modal_app.py` uses `gpu="L4"` (cheapest current-gen 24GB GPU, ~$0.80/hr) and `min_containers=0` so you only pay while a request is in flight. `scaledown_window=600` keeps the container warm 10 min after the last call. Default GGUF is **I-Compact** (17.3GB) — fits L4 with room for the KV cache.

## Development

```bash
npm run typecheck  # strict TS
npm run dev        # electron-vite with HMR
npm run build      # production bundle
```
