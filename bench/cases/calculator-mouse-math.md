---
id: calculator-mouse-math
description: Demo case for OS-level agent_click with visible cursor motion. Compute 47 × 8 in macOS Calculator by clicking each button.
tool_budget: 12
expected_happy_path_calls: 9
---

# Case: calculator-mouse-math

A small demo case to validate `agent_click` end-to-end on the OS layer (the `bulbasaur-photo-upload` case is Chrome-only). The user should see the **real OS cursor physically move** to each Calculator button as the harness clicks it.

## Task

> Compute 47 × 8 in macOS Calculator by clicking each digit and operator with the mouse, then read the answer from the display.

## Preconditions

- macOS with Calculator.app installed (default).
- The Holo3 Electron dev server is running so the bridge handles `agent_click` (otherwise the host process needs Screen Recording + Accessibility permissions).
- The orchestrator can use `screen_*` (hotkey, type, screenshot) AND `agent_click`.
- Cursor IDE / Claude Code chat may be visible on a SECONDARY monitor — see "Known gotcha" below.

## Constraints

1. **Do NOT use keyboard input for the math.** The whole point is to see the cursor physically click each button. (Calculator does accept keyboard, so this is a constraint, not a limitation.)
2. **Clear before computing.** Calculator keeps the previous result on screen. First action after launch is `AC`.
3. **One agent_click per button.** Don't try to chain `agent_do` for the whole math.

## Happy-path sequence (9 calls)

1. `screen_hotkey("cmd+space")` — open Spotlight
2. `screen_type("Calculator", thenPress: "enter")` — launch
3. `screen_screenshot` — verify Calculator is up + see button positions
4. `agent_click("AC")` — clear any prior result
5. `agent_click("4")`
6. `agent_click("7")`
7. `agent_click("× multiply")`
8. `agent_click("8")`
9. `agent_click("=")`
10. `screen_screenshot` — read the answer (verification)

That's 10, but step 3 doubles as the verification screenshot for step 10 if Calculator was already in the foreground. The 9-call target assumes Calculator launches into a clean state.

## Known gotcha — embedded-screenshot grounding

When Cursor IDE / Claude Code is showing a screenshot of Calculator in its chat (because that screenshot was an output of a prior tool call), and BOTH the real Calculator AND that embedded picture-of-Calculator are visible on screen, `agent_click` may ground against the picture instead of the real window. Symptom: the click coords land on the chat pane, the real Calculator gets pushed behind, and the post-click screenshot shows Cursor in front.

**Recovery:** `screen_hotkey("cmd+tab")` to bring Calculator forward; the cursor moves to whichever display Calculator lives on, and the next screenshot will be of the right display, eliminating the decoy.

**Avoidance:** if you can, place Calculator on a DIFFERENT display from the orchestrator's chat window — there's no decoy if the displays don't both contain Calculator.

## Success criteria

- Calculator's display reads `376` (the correct answer for 47 × 8).
- The user observed the cursor moving between buttons (qualitative, not in the JSON record).

## Tool budget

- 12 calls. Anything more is a failure.

## Batched variant

> Variant id: `calculator-mouse-math-batched`
> Tool budget: **4 calls** (down from 12; happy path is exactly 4).

Once `agent_click_sequence` is wired up (commit 52505bb and the matching Modal-side `/ground/batch` shim), the six button clicks collapse into a single tool call. The static-UI assumption holds for Calculator: the keypad layout doesn't reflow between presses, so all six targets are visible from one shared screenshot.

### Happy-path sequence (4 calls)

1. `screen_hotkey("cmd+space")` — open Spotlight
2. `screen_type("Calculator", thenPress: "enter")` — launch
3. `screen_screenshot` — confirm Calculator is foregrounded on the cursor's display (catches the embedded-screenshot decoy from the gotcha section above)
4. `agent_click_sequence({ steps: [AC, 4, 7, ×, 8, =], stepDelayMs: 150 })` — one screenshot capture, six grounded coords (server-side fan-out via `provider.groundBatch` when available, else `Promise.all` of N parallel `ground()` calls), six serial clicks, ONE post-sequence screenshot returned in the tool response

That's it. No separate post-verification `screen_screenshot` — the sequence tool's response already includes the post-sequence screenshot.

### Verification

The tool's text summary line tells you which ground path fired:

- `Ground via provider.groundBatch (1 HTTP, server-side fan-out)` → headline path. Target wall time ~5s (curl benchmark: 6-target `/ground/batch` in 2.0s vs 6 sequential `/ground` in 9s, a 4.5× HTTP-layer win with `--parallel 4` + `-c 16384` continuous batching on the Modal-side llama-server).
- `Ground via Promise.all of 6 ground() calls` → parallel-fallback. Still ~2.4× faster than 6 individual `agent_click` calls because the screenshot is shared, but missing the single-HTTP-fan-out win.

If you see the fallback path on a freshly-deployed Modal: check (a) the running `src/mcp/server.ts` PID — if it predates commit 52505bb, restart it; (b) `curl /health` against `$MODAL_BASE_URL` returns 200.

### Result JSONs

- Pre-sequence-tool baseline (6 individual `agent_click` calls + recovery): `bench/results/calculator-mouse-math-opus-2026-05-10T07-32-00Z.json` — 10 calls, 240s wall.
- Batched variant: `bench/results/calculator-mouse-math-batched-opus-<ISO-Z>.json` — 4 calls. Naming: `calculator-mouse-math-batched-<model>-<ISO-Z>.json`.

### Constraint deltas vs. parent case

- Constraint 3 ("One agent_click per button") is REPLACED by: "One `agent_click_sequence` for the whole compute. Don't fall back to per-button `agent_click` calls — that's the parent case, not this variant."
- Constraints 1 ("no keyboard input for the math") and 2 ("AC first") are unchanged.
