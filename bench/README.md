# Ponder benchmark suite

Real-environment integration benchmarks for the Ponder MCP. Each case describes a task, constraints, success criteria, and a tool budget. Runs are recorded to `results/<case-id>-<model>-<timestamp>.json` so we can track tool count, wall time, and outcome over time as the harness changes.

## Why these are integration tests, not unit tests

The Ponder runtime drives the user's REAL Chrome session and macOS desktop. Every benchmark therefore touches:

- The user's actual Chrome (Playwriter extension must be clicked on the relevant tab — see `browser_status`).
- The user's actual filesystem (e.g. screenshots on `~/Desktop`).
- The Holo3 vision model (or its router fallback) for OS-level grounding.
- The Electron Holo3 app (running `npm run dev`) so the bridge handles macOS perms.

You can't run these on CI without orchestrating a desktop. They're meant for manual / scheduled runs against a real workstation.

## Running a benchmark

### Via the harness (recommended for the OS suite)

```sh
npx tsx bench/run.ts <case-id>             # full run
npx tsx bench/run.ts <case-id> --dry-run   # parse + setup + score (skip agent)
npx tsx bench/run.ts <case-id> --no-setup  # skip setup block (state already staged)
npx tsx bench/run.ts <case-id> --targetApp Calculator   # override targetApp
```

`bench/run.ts` parses the case .md (frontmatter + `## Task` blockquote + first ```sh block in `## Setup` and `## Scoring`), preflights the Electron bridge SHA against `git rev-parse --short=12 HEAD`, runs setup, POSTs to `http://127.0.0.1:7900/agent_do`, runs scoring with env vars (`OUTCOME`, `RUN_START_ISO`, `RUN_END_ISO`), and writes a result JSON.

The harness exit code is `0` for PASS, `1` for FAIL, `2` for UNKNOWN (no PASS/FAIL line in scorer stdout) — useful for shell loops over the suite.

#### Verdict convention

Every `## Scoring` block must emit a final line that **starts with `PASS` or `FAIL`**. The harness reads the LAST such line as the verdict (so intermediate `echo` calls for diagnostics are fine). Examples:

- `PASS` — bare verdict, no reason needed
- `PASS: note created with correct URL` — verdict with reason
- `FAIL: false-positive DONE on infeasible task` — verdict with reason
- `FAIL: CATASTROPHIC — fixture file missing` — canonical FAIL prefix even for catastrophic outcomes (do NOT invent custom prefixes; the parser only matches PASS / FAIL)

#### Authority order

From the t4-safari-link-to-notes pilot (2026-05-11): the strict verifier and deterministic AppleScript scorer can **disagree**. The harness records both signals but treats the deterministic check as authoritative. The result JSON's `disagreement: true` flag fires whenever they conflict.

```
deterministic_score  >  strict_verifier  >  agent_self_reported_outcome
```

A high disagreement rate across the suite is itself a useful signal about verifier quality — track it.

### Via a Claude Code subagent (legacy, for the original Chrome cases)

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

## Adding a case

1. Write `bench/cases/<id>.md` with: task description, constraints, preconditions, success criteria, tool budget.
2. Run it once via the assistant; review the result JSON.
3. Set `tool_budget` based on the observed happy-path count + a small margin.
4. Add a row to the `Cases` section above.

## Comparing runs

Quick: `ls -t bench/results/<case-id>-*.json | head -5 | xargs jq '{model, elapsed_ms, tool_call_count, outcome}'`.

Trend over time across harness changes — useful when the prompt gets tweaked or a new primitive lands.
