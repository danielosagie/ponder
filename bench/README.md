# Ponder benchmark suite

Real-environment integration benchmarks for the Ponder MCP. Each case describes a task, constraints, success criteria, and a tool budget. Runs are recorded to `results/<case-id>-<model>-<timestamp>.json` so we can track tool count, wall time, and outcome over time as the harness changes.

## Why these are integration tests, not unit tests

The Ponder runtime drives the user's REAL Chrome session and macOS desktop. Every benchmark therefore touches:

- The user's actual Chrome (Playwriter extension must be clicked on the relevant tab — see `browser_status`).
- The user's actual filesystem (e.g. screenshots on `~/Desktop`).
- The Holo3 vision model (or its router fallback) for OS-level grounding.
- The Electron Holo3 app (running `npm run dev`) so the bridge handles macOS perms.

You can't run these on CI without orchestrating a desktop. They're meant for manual / scheduled runs against a real workstation.

## Running a benchmark from inside Claude Code

In Claude Code (with this repo and the Ponder MCP attached), ask the assistant to run a case. The assistant spawns a Haiku/Sonnet/Opus subagent via its `Agent` tool with a benchmark-shaped prompt that demands structured JSON output, writes the result to `bench/results/`, and reports metrics back.

Example prompt:

> Run benchmark `bench/cases/bulbasaur-photo-upload.md` with model `haiku`. Save the result to `bench/results/`.

## Capturing Ponder server-side logs

The subagent only sees its own tool calls + replies. To also capture inner-loop telemetry (`[loop] 📋 flat mode …`, `[brain] → hcompany.plan …`, `[eyes] →`, `[router]`, anti-loop guards, verifier decisions, etc.), redirect `npm run dev` to a log file:

```bash
# In a terminal:
npm run dev 2>&1 | tee bench/results/dev-server.log
```

Then run the benchmark. The server-side log lines for the run are in `dev-server.log`; correlate with the result JSON's `started_at` / `ended_at` timestamps.

## Result schema

`bench/results/<case-id>-<model>-<timestamp>.json`:

```jsonc
{
  "id": "bulbasaur-photo-upload-haiku-2026-05-09T...",
  "case": "bulbasaur-photo-upload",
  "model": "haiku",
  "started_at": "2026-05-09T17:02:12.001Z",
  "ended_at": "2026-05-09T17:02:46.330Z",
  "elapsed_ms": 34329,
  "outcome": "success",          // success | failure | exhausted | error
  "tool_call_count": 7,
  "tool_calls": [
    { "tool": "browser_status", "ok": true, "notes": "1 tab attached, on edit page" },
    { "tool": "browser_snapshot", "ok": true, "notes": "[e22] file-input visible" },
    { "tool": "Bash", "ok": true, "notes": "ls -t ~/Desktop/Screenshot*.png | head -1" },
    { "tool": "browser_set_input_files", "ok": true, "notes": "e22, [path]" },
    { "tool": "browser_snapshot", "ok": true, "notes": "Photos · 2/10 confirmed" }
  ],
  "verification": "Photos · 2/10 confirmed in final snapshot",
  "errors": [],
  "subagent_summary": "Uploaded the screenshot in 5 calls. Used browser_set_input_files; no agent_do, no vision."
}
```

## Cases

- [`bulbasaur-photo-upload`](cases/bulbasaur-photo-upload.md) — the canonical regression test. Upload latest desktop screenshot to a Marketplace listing's photos. Expected: ≤7 tool calls in the worst case (wrong tab attached + native picker fallback), ≤5 in the happy path.
- [`calculator-mouse-math`](cases/calculator-mouse-math.md) — vision-grounded `agent_click` end-to-end on macOS Calculator. Per-click variant (~240s wall) and `agent_click_sequence`-batched variant (~3–7s).
- [`calculator-mouse-math-os`](cases/calculator-mouse-math-os.md) — a11y-grounded `os_*` variant of the calculator case. Zero vision tokens, target ≤ 2s wall. Run directly with `tsx scripts/bench-calculator-os.ts` to bypass the orchestrator.

## Adding a case

1. Write `bench/cases/<id>.md` with: task description, constraints, preconditions, success criteria, tool budget.
2. Run it once via the assistant; review the result JSON.
3. Set `tool_budget` based on the observed happy-path count + a small margin.
4. Add a row to the `Cases` section above.

## Comparing runs

Quick: `ls -t bench/results/<case-id>-*.json | head -5 | xargs jq '{model, elapsed_ms, tool_call_count, outcome}'`.

Trend over time across harness changes — useful when the prompt gets tweaked or a new primitive lands.
