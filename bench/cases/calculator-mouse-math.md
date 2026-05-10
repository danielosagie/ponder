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
