---
id: bulbasaur-photo-upload
description: Upload the user's latest desktop screenshot to their Bulbasaur card listing on Facebook Marketplace.
tool_budget: 8
expected_happy_path_calls: 5
---

# Case: bulbasaur-photo-upload

The canonical regression test for the Ponder harness. The original failing run took **26 tool calls**; the post-refactor target is **≤8 in the worst case** (wrong tab attached + native picker fallback) and **≤5 in the happy path** (right tab + `browser_set_input_files` works).

## Task

> Upload the user's latest desktop screenshot to their Bulbasaur card listing on Facebook Marketplace.

## Preconditions

- Chrome is open on the listing edit page (`https://www.facebook.com/marketplace/edit/?listing_id=…`).
- The Playwriter extension has been clicked on that tab (icon is green).
- A screenshot file matching `~/Desktop/Screenshot*.png` exists (the test uses the most recent one).
- The Holo3 Electron dev server is running (`npm run dev`).
- The user is logged into Facebook with this listing as theirs.

## Constraints (the orchestrator should follow these)

1. **Prefer non-`agent_do` paths.** Use the structured tools where they fit: `browser_set_input_files`, `agent_click`, `Bash` for path discovery. `agent_do` is a last resort.
2. **Use Bash to find the file path.** `ls -t ~/Desktop/Screenshot*.png | head -1` — never use `agent_do(surface: "finder")` to hunt for files.
3. **If the Chrome ref is wrong (`browser_snapshot` URL ≠ user's intent),** call `browser_switch_tab` rather than charging into clicks.
4. **If a native file picker has to open,** prefer the Cmd+Shift+G + path + Enter recipe (3 OS-level calls, no vision) over `agent_click` per-row.
5. **Don't ask the user to confirm.** The user already pre-confirmed by triggering this benchmark.

## Success criteria

- The listing's photo count goes from `1 / 10` to `2 / 10` (or N → N+1 depending on starting state). Confirmed via a final `browser_snapshot` showing the increased count or a new thumbnail.
- Outcome reported as `success` in the result JSON.

## Tool budget

- **8 calls maximum.** Beyond that, mark the run as `exhausted` even if the upload eventually lands.
- Happy path expectation: **5 calls** (`browser_status` → `browser_snapshot` → `Bash` ls → `browser_set_input_files` → `browser_snapshot`).
- Worst-case path expectation: **7 calls** (add `browser_switch_tab` + a button click that reveals the file-input).

## Subagent prompt template

The assistant fills this in when spawning the subagent:

````
You are running benchmark `bulbasaur-photo-upload`. Drive the Ponder MCP to complete the task below.

TASK
{task}

CONSTRAINTS
{constraints}

PRESCRIBED SEQUENCE (5 calls — follow unless state forces a deviation)
1. browser_status                 — confirm tab attached, URL is the marketplace edit page
2. browser_snapshot               — find the file-input ref (e.g. e14, flagged "use browser_set_input_files")
3. Bash: ls -t ~/Desktop/Screenshot*.png | head -1   — read the real path from disk
4. browser_set_input_files(<ref-from-step-2>, [<path-from-step-3>])
5. browser_snapshot               — verify: photo count incremented, new thumbnail visible

DO NOT click "Add photo" or any other button before step 2's snapshot. The hidden file-input is surfaced directly in browser_snapshot for ~80% of upload widgets, including this one.

TOOL BUDGET
- Hard cap: 8 tool calls. If you can't finish by then, abort and report `exhausted`.
- Happy path: 5 calls per the prescribed sequence above.

REPORT BACK
After the task is done (or when you abort), reply with EXACTLY this JSON shape on the LAST line of your reply, no markdown fences, no prose after it:

{"tool_call_count": N, "tool_calls": ["tool_name_1", "tool_name_2", ...], "outcome": "success|unverified|failure|exhausted|error", "verification": "<one sentence describing what you saw in the final state>", "errors": ["..."] }

Where:
- tool_calls is the EXACT list of tool names you invoked, in order, including duplicates. Use the bare tool name (strip any mcp__ponder__ / mcp__holo3-browser__ prefix).
- outcome=success REQUIRES (a) your last call to be browser_snapshot AND (b) the verification text to cite a specific post-state observation (e.g., "Photos · 2 / 10 + new thumbnail at e40"). Without both, report outcome=unverified.
- outcome=unverified means the upload likely succeeded but you didn't take a final snapshot to prove it.
- outcome=exhausted means you hit the budget without reaching browser_set_input_files.
- outcome=error/failure means a tool returned a hard error you couldn't recover from.
- verification: one sentence of evidence (e.g., "Photos · 2 / 10 in final snapshot, new thumbnail visible at e40").
- errors: array of any tool errors observed (Cancel/empty if none). Include the literal error message text.
````

## Running

The assistant spawns a Haiku/Sonnet/Opus subagent with the prompt above, captures the structured JSON reply, and writes `bench/results/bulbasaur-photo-upload-<model>-<timestamp>.json`.
