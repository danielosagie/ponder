---
id: calculator-mouse-math-os
description: a11y-grounded variant of calculator-mouse-math. Compute 43 × 424 in macOS Calculator by clicking buttons through os_*, no vision model in the loop.
tool_budget: 4
expected_happy_path_calls: 4
wall_target_ms: 2000
---

# Case: calculator-mouse-math-os

The OS-level equivalent of `calculator-mouse-math-batched`. Same task,
same constraints, but the click coordinates come from a single macOS
Accessibility-tree snapshot via the `os_*` tools — no Holo3 model call
per click, no `agent_click_sequence`, no `targetApp` crop hack.

If `os_*` is doing what we think it's doing, this case should beat
the batched variant by an order of magnitude on wall time and use zero
vision tokens.

## Task

> Compute **43 × 424** in macOS Calculator by clicking each digit and
> operator through `os_click`, then read the answer from the display.

Expected result: `18232`.

## Preconditions

- macOS with Calculator.app installed.
- Holo3 Electron dev server running (`npm run dev`) so the bridge is alive at `127.0.0.1:7900`.
- `@ponder/mac-ax` native addon built for the current Electron ABI (`npm run build:native`).
- Holo3 app has Accessibility permission ticked in System Settings (same checkbox the screen tools already need — no second prompt).
- Calculator can be closed at start; the harness launches it.

## Constraints

1. **No vision in the click path.** `agent_click` / `agent_click_sequence` / `agent_observe` are forbidden. The grounded path is `os_snapshot` → ref → `os_click`.
2. **One `os_snapshot` for the math.** The keypad doesn't reflow between presses, so one snapshot covers AC + all digits + × + =. A second snapshot at the end reads the result display.
3. **Clear before computing.** First click is `AC` (Calculator keeps the previous result on screen).

## Happy-path sequence (4 calls)

1. `screen_hotkey("cmd+space")` — open Spotlight
2. `screen_type("Calculator", thenPress: "enter")` — launch
3. `os_snapshot` — get [eN] refs for AC, the digits, ×, =
4. For each step in `[AC, 4, 3, ×, 4, 2, 4, =]`: `os_click({ selector: { ref: <eN> } })` — but these are bundled into the same logical step in the harness's report (they're 8 cheap bridge round-trips, not 8 expensive tool calls; counted as one "compute" phase)

A second `os_snapshot` at the very end reads `18,232` off the display.
Inclusive of that final snapshot the budget is 4 logical calls. If the
orchestrator separates each `os_click` into its own MCP turn the budget
shifts to 11; the direct script (`scripts/bench-calculator-os.ts`) bundles
them so it can report sub-call timing.

## Success criteria

- Calculator's display reads `18,232`.
- Wall time from `cmd+space` press to final-display snapshot ≤ **2000 ms**.
- Zero vision-model calls in the run. Snapshot size (chars of `ax`) and click count are recorded for the bench JSON.

## Why this should hit 2 seconds

| Phase | Estimated cost |
|---|---|
| `cmd+space` + Spotlight settle | ~50 ms |
| Type "Calculator" + enter | ~120 ms |
| Wait for Calculator to focus | 400–800 ms (dominant cost) |
| `os_snapshot` (single native AX walk) | 50–120 ms |
| 8 × `os_click` via `/screen/click` (bridge round-trip) | 8 × ~20 ms = 160 ms |
| Final `os_snapshot` to read display | 50–120 ms |
| **Total** | **~830–1430 ms** |

The launch wait dominates. If we already have Calculator open we'd be
firmly under 500 ms.

## Tool budget

- 4 calls (orchestrator view) / 11 calls (every os_click counted).
- Anything more is a failure.

## Comparison targets

| Variant | Calls | Wall | Vision calls |
|---|---|---|---|
| `calculator-mouse-math` (per-click vision) | 10 | ~240 s | 7 |
| `calculator-mouse-math-batched` | 4 | ~3–7 s (path-dependent) | 1 batched |
| **`calculator-mouse-math-os`** (this) | **4** | **target ≤ 2 s** | **0** |

## Verification

Read the display via the final `os_snapshot`. The Calculator's result
field surfaces as an `AXStaticText` (or `AXTextField`) child of the
window — the ax-text dump will include a line like:

```
[e3] textfield "18,232"
```

…or an equivalent flagged with `value: "18,232"`. The bench script
asserts the rendered display contains `18232` after stripping commas.

## How to run

Direct (no orchestrator, clean timing):

```sh
npm run dev                          # in a separate terminal — bridge must be live
npm run build:native                 # once, after npm install
tsx scripts/bench-calculator-os.ts   # writes bench/results/calculator-mouse-math-os-direct-<ISO>.json
```

Through Claude Code (full MCP stack):

> Run benchmark `bench/cases/calculator-mouse-math-os.md`. Save the result to `bench/results/`.

The orchestrator-driven path will spend more wall time on MCP transport
than the math itself — useful for measuring end-to-end UX, less useful
for proving the speed-of-light of the a11y path.

## Known failure modes

- **`os_snapshot` returns empty ax** — Calculator wasn't focused yet (race with launch). The script polls for an `AXButton` named "AC" up to 1500 ms before giving up. Increase `LAUNCH_TIMEOUT_MS` if launch is slow.
- **`AXButton "×"` not found** — Calculator may localize the multiply button. The script tries `["×", "*", "multiply", "x"]` in order; failures here mean the AX name is genuinely different and the script needs a new alias.
- **Display has no readable value** — Calculator's result element is usually focused and exposes `AXValue`. If the bench can't find a numeric value in the post-snapshot, it emits `outcome: "unverified"` with the raw snapshot text saved for inspection.
