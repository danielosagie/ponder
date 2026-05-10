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

**Fix-by-design (preferred):** the batched variant below supports `targetApp: "Calculator"`, which crops the screenshot to Calculator's front window before grounding so the decoy can't even reach the model. See the Batched variant section.

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
3. `screen_screenshot` — confirm Calculator is foregrounded (cheap pre-flight; even with `targetApp` set you want to be sure the app is running before the sequence call burns a grounding round-trip)
4. `agent_click_sequence({ steps: [AC, 4, 7, ×, 8, =], stepDelayMs: 50, targetApp: "Calculator" })` — single screenshot capture, six grounded coords via `provider.groundBatch` (one HTTP, server-side fan-out into llama-server's `--parallel 4` slots), six serial clicks at the bridge layer, ONE post-sequence screenshot returned in the tool response.

Two things to call out about the call shape:

- `stepDelayMs: 50` — Calculator buttons respond synchronously to `cliclick`, so the conservative 150ms default is just dead time. 50ms gives ~3 display frames of margin and saves ~500ms across 5 inter-click gaps.
- `targetApp: "Calculator"` — the screenshot is cropped to Calculator's front window before grounding, eliminating the embedded-screenshot decoy at the source. If Accessibility perms are missing or Calculator isn't running, the tool falls back to uncropped grounding silently (logs to stderr; the response's summary line tells you whether crop fired). On grounded coords landing OUTSIDE Calculator's window, the tool returns a `target_outside_window` error and refuses to click — the orchestrator should `screen_hotkey('cmd+tab')` and retry.

That's it. No separate post-verification `screen_screenshot` — the sequence tool's response already includes the post-sequence screenshot.

### Verification

The tool's text summary line tells you which ground path fired and whether crop was applied:

- `Ground via provider.groundBatch (1 HTTP, server-side fan-out)` → headline path. With `stepDelayMs: 50` + bridge clicks, target wall time ~3.2s (curl benchmark: 6-target `/ground/batch` in 2.0s vs 6 sequential `/ground` in 9s, a 4.5× HTTP-layer win on `--parallel 4` + `-c 16384` continuous batching).
- `Ground via Promise.all of 6 ground() calls` → parallel-fallback. Still much faster than 6 individual `agent_click` calls because the screenshot is shared, but no single-HTTP-fan-out win and `targetApp` cropping is silently dropped (single `ground()` doesn't carry a crop param).
- `(cropped to Calculator window: WxH at X,Y)` in the summary → `targetApp` cropping fired. The model only saw Calculator pixels; the decoy is impossible.
- `(targetApp="Calculator" requested but crop unavailable — see stderr)` → Accessibility perms denied, the app wasn't running, or the platform isn't darwin. Grounding still ran un-cropped; the run is still likely to succeed if there's no decoy on screen, just without the by-design defense.

**Fresh-server pre-flight.** Before running this benchmark, call `holo3_version` from the orchestrator. The returned `commit` should match `git rev-parse --short=12 HEAD`. If it doesn't, the running MCP server is stale (a child process from a prior session that predates the current code) — run `bash scripts/kill-stale-mcp.sh`, restart Claude Code, and re-call `holo3_version` to confirm.

If you see the fallback path on a freshly-restarted Claude Code session: check `curl $MODAL_BASE_URL/health` returns 200 with a `commit` field — that's the Modal endpoint's freshness check.

### Result JSONs

- Pre-sequence-tool baseline (6 individual `agent_click` calls + recovery): `bench/results/calculator-mouse-math-opus-2026-05-10T07-32-00Z.json` — 10 calls, 240s wall.
- Batched variant: `bench/results/calculator-mouse-math-batched-opus-<ISO-Z>.json` — 4 calls. Naming: `calculator-mouse-math-batched-<model>-<ISO-Z>.json`.

### Constraint deltas vs. parent case

- Constraint 3 ("One agent_click per button") is REPLACED by: "One `agent_click_sequence` for the whole compute. Don't fall back to per-button `agent_click` calls — that's the parent case, not this variant."
- Constraints 1 ("no keyboard input for the math") and 2 ("AC first") are unchanged.
