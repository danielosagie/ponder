---
task_id: t4-safari-link-to-notes
tier: T4
axes:
  - multi-app-handoff
  - state-reading
  - long-horizon
expected_actions: 7
infeasible: false
---

# T4 — Copy Safari URL into a new Note

A representative T4 multi-app handoff task. Tests the **clipboard
state survives an app context switch** axis — the one where field
SOTA is 3.7% on macOSWorld.

## Task (verbatim prompt to agent_do)

> In Safari (frontmost window), copy the URL of the current tab to
> the clipboard. Then switch to the Notes app, create a new note
> titled "Bench Safari Link <ISO-timestamp>", and paste the URL as
> the body. After saving, return the URL value in your DONE message.

## Surface

`other` — but the brain will encounter `safari` (`targetApp` should
auto-detect) AND `notes` (separate `targetApp` after switch).

## Setup (before run)

1. Open Safari to a specific URL: `https://example.com/bench-fixture`.
2. Quit and re-launch Notes so the notes list is on default state.
3. Move the cursor onto the display containing Safari (so initial
   screenshot captures the right one).

```sh
osascript -e 'tell application "Safari" to make new document with properties {URL:"https://example.com/bench-fixture"}'
osascript -e 'tell application "Notes" to quit'
sleep 0.5
open -a Notes
```

## Scoring (deterministic, no OCR)

```sh
# 1. Notes contains a note created during the run window
EXPECTED_URL="https://example.com/bench-fixture"
RUN_START_ISO="<from harness, e.g. 2026-05-11T14:00:00Z>"

osascript <<'APPLESCRIPT'
  tell application "Notes"
    set matches to notes whose name starts with "Bench Safari Link"
    if (count of matches) is 0 then return "FAIL: no matching note"
    set theNote to item 1 of matches
    set noteBody to body of theNote
    -- body comes back as HTML; check it contains the expected URL
    if noteBody contains "example.com/bench-fixture" then
      return "PASS"
    else
      return "FAIL: note exists but body doesn't contain URL"
    end if
  end tell
APPLESCRIPT
```

PASS condition: AppleScript returns `"PASS"`.
FAIL conditions: any of —
- No Note created (clipboard handoff broke OR Notes never opened)
- Note created but body empty (paste never landed)
- Body contains a DIFFERENT URL (agent copied the wrong tab)
- Body contains the literal text "{URL}" or similar (placeholder not substituted — small-model failure mode)

No OCR. No screenshot diff. Pure state inspection — survives display
arrangement changes, theme changes, font changes.

## Why this task hits hard axes

| Axis | How |
|---|---|
| Multi-app handoff | Safari → clipboard → Notes. Loses state on any focus glitch. |
| State-reading | Agent must KNOW the URL (or trust the clipboard). Verifier reads it back. |
| Long-horizon | ~7 atomic actions: focus Safari → cmd+l → cmd+c → cmd+tab/Dock → new note → title → paste → save. |

## Expected happy path (~7 steps)

```
1. focus Safari (it should already be frontmost from setup — agent may skip)
2. press cmd+l           (URL bar focus)
3. press cmd+c           (copy URL)
4. switch app: Dock-click Notes OR cmd+tab to Notes
5. press cmd+N           (new note)
6. type "Bench Safari Link <ISO>"
7. press tab, then cmd+v (paste URL as body)
8. press cmd+s OR just leave (Notes auto-saves)
9. emit DONE with the URL value
```

The "FAST PATH" hint in `brain.ts` for FB Marketplace doesn't apply
here — there's no constructable URL. Pure mechanical clipboard task.

## What we expect Ponder to fail on (current capabilities)

Without further work, the brain might:

- **Lose Safari's URL** if the cmd+l happens BEFORE Safari is frontmost
  (focus order matters). Mitigated by our `raise+recapture` (commit
  `1976d6c`) — should be reliable.
- **Click into Notes' note-list instead of opening a new note** —
  same grounding-precision class we hit on Calculator buttons.
  Mitigated by the auto-detect cropping (`4956638`/`4defce2`) which
  shrinks Notes' window to a cropped image.
- **Type into the wrong note** if a previous note is focused.
- **Verifier falsely VERIFY** if a partial state ("Bench Safari Link"
  title but no body) is reached. The new strict-verifier prompt
  (`1957823`) requires "concrete proof" — the body containing the
  URL is the concrete signal it should require here.

## Prior runs

Track here once the harness lands. Format:

| Date | Commit | Outcome | Wall | Steps | Notes |
|---|---|---|---|---|---|
| TBD | TBD | TBD | TBD | TBD | First run after harness. |
