# Ponder reference — worked examples, recovery, troubleshooting

The prescriptive rules live in `SKILL.md`. This file is everything else: examples to copy, patterns to recognize, recovery playbooks, and operational notes you only need when something's off.

---

## Worked examples

### 1. Upload a screenshot to a Marketplace listing (the right way)

User: "upload my latest screenshot to my Bulbasaur Marketplace listing."

```
1. browser_status                           # observe: where are we?
   → Attached. URL: …/marketplace/edit/?listing_id=…

2. browser_snapshot
   → [e15] button "Add photo"
     [e22] file-input "" (use browser_set_input_files, accepts=image/*)
   The hidden <input type=file> is right there — flagged for you.

3. browser_set_input_files("e22", ["/Users/dosagie/Desktop/Screenshot 2026-05-08 at 1.59.53 PM.png"])
   → Attached 1 file to e22: Screenshot 2026-05-08 at 1.59.53 PM.png.

4. browser_snapshot                         # verify the upload landed
   → "Photos · 2 / 10" + new thumbnail visible

5. Report: "Uploaded the screenshot to the Bulbasaur listing."
```

5 tool calls. No native picker. No `agent_do`. No vision.

If the file-input ref is missing from the snapshot:
```
browser_click("e15")          # click the styled "Add photo" — opens picker
browser_snapshot              # the hidden <input type=file> usually appears now
browser_set_input_files(<ref>, [path])
screen_hotkey("escape")       # dismiss the picker that's still on screen
browser_snapshot              # verify
```

### 2. Find 3 Marketplace listings under $3,000 (pure Chrome — no agent_do)

```
browser_status
browser_navigate("https://www.facebook.com/marketplace")
browser_snapshot                                         # find search/location refs
browser_type("<search-ref>", "Civic")
browser_snapshot                                         # autocomplete dropdown rendered
browser_click("<location-suggestion-ref>")               # apply location
browser_snapshot                                         # results loaded
browser_read                                             # collect listing details
# … click into N detail pages, browser_read each
# Report with title + price + URL.
```

### 3. Compute 7 × 8 in Calculator (pure OS — no agent_do)

```
screen_hotkey("cmd+space")                       # Spotlight
screen_type("Calculator", thenPress: "enter")    # launch
screen_type("7*8", thenPress: "enter")           # compute
screen_screenshot                                # read display
# Report "7 * 8 = 56".
```

### 4. Hybrid (Chrome + OS file picker — only when set_input_files won't work)

Some sites use a custom upload widget that doesn't expose a real `<input type=file>`. Then:

```
browser_click("<add-photo-ref>")
agent_do(task: "select the most recent screenshot in the Today section and click Open",
         surface: "file-picker",
         goal: "uploading screenshot to Marketplace listing")
browser_snapshot                                 # back in Chrome — verify upload
```

Note `surface: "file-picker"` is required. The brain gets `goal` as framing so it stays oriented.

---

## Patterns to recognize

### TYPE → CLICK SUGGESTION → CLICK APPLY (search / location forms)

A `(disabled)` ref is UNCLICKABLE — wastes 5s on a Playwright timeout. When you typed into a search/location/combobox and the submit button is disabled, your NEXT action MUST be `browser_click` on a `(suggestion)` ref, NOT the disabled button, NOT `press enter`.

```
[e86] textbox "Location"
[e91] option "Marietta, GA, United States" (suggestion)
[e90] button "Apply" (disabled)
Last action: browser_type e86 "Marietta, GA"
  Wrong: browser_click e90       ← disabled, hangs 5s
  Wrong: press enter             ← submit goes through the button
  Right: browser_click e91       ← Apply un-disables on next snapshot
```

### Redirect detection

If `browser_navigate(X)` lands on Y ≠ X, DO NOT re-emit the same navigate (the runtime guard rejects it anyway). Either accept the redirected URL and use on-page filters, or `screen_screenshot` to see what's actually on screen.

### List tasks ("find N items")

Don't stop at the search-results page — that page only shows TITLES + PRICES; the user wants DETAILS. For each of the N items: click the listing card → `browser_read` once the detail page loads → either back-button or click the next listing in results. Only report after all N detail pages have been read.

---

## Recovery playbook

### After ANY agent_do return (`done`, `exhausted`, `cancelled`, `error`)

The agent_do reply now INCLUDES the final-frame screenshot as an attached image. **Look at it FIRST.** If it shows the goal already achieved, just report success — do NOT re-fire agent_do or chain more clicks.

If the screenshot is ambiguous, `browser_snapshot` and/or `screen_screenshot` for a fresh view BEFORE deciding the next move.

```
agent_do(task: "select most recent screenshot and click Open",
         surface: "file-picker")
   → Outcome: exhausted (10 steps, no DONE)

# WRONG: another agent_do, or pressing cmd+tab to "see what happened"
# RIGHT: observe both surfaces

screen_screenshot      # picker gone, Chrome in front, edit page visible
browser_snapshot       # new thumbnail in the photos row

# Goal landed; brain just couldn't recognize completion. Report success.
```

### Tool-specific recovery

| Symptom | Recovery |
|---|---|
| `browser_click` failed twice on same ref | `browser_snapshot` again — page may have repainted; ref may have vanished. Or fall back to `agent_do(surface: "other", context: "<element description>")`. |
| `browser_navigate` keeps redirecting | Accept the redirect; use on-page nav. |
| `browser_type` did nothing | Click the field with `browser_click` first, then type. |
| Same action repeated 2+ times | STOP. Re-snapshot. Re-decide based on actual state, not what you "would have done next". |
| `agent_do exhausted` | OBSERVE FIRST (both `screen_screenshot` and `browser_snapshot`). Half the time the goal already landed. |

### Never call `screen_hotkey` to "see what's in another window"

`cmd+tab` to "find the file picker" is blind navigation that loses focus and almost always makes the situation worse. If you don't know where a window is, `screen_screenshot` first.

---

## Tool choice guidelines

Default to keyboard-style verbs (`browser_navigate`, `browser_type`, `screen_hotkey`, `screen_type`) — fast and reliable. Mouse (`browser_click`, `agent_do`) wins when picking a SPECIFIC item from a list (search-result card, dropdown suggestion, listing tile, file in a picker).

For uploads, ALWAYS try `browser_set_input_files` before falling back to `agent_do(surface: "file-picker")`.

---

## Reporting results

| Request shape | Reply shape |
|---|---|
| Informational ("find 3 X under $Y") | Lead with the answer ("Found 3 listings under $3000:") + hyphen-bulleted list with title + price + URL pulled from `browser_read`. Up to 12 items. |
| Procedural ("post X to Marketplace") | One short past-tense sentence confirming what was done. |
| Got stuck | Past tense — what blocked you, what's currently visible, suggest one concrete next step. |

NEVER start with "I will…" / "Let me…" / "First, I'll…". Report what HAPPENED.

---

## Operational notes

### Cost & cancellation

The MCP server cold-starts on the first tool call (~1–2s). `agent_do`'s first call additionally pays ~30–60s of provider warmup on Modal (cold container) or ~1–2s on H Company; subsequent calls are fast. `agent_do` runs at most 8 inner steps by default (cap is `PONDER_AGENT_DO_MAX_STEPS`); a 240s hard ceiling per call protects against runaway. Cancellation (Esc in Claude Code) tears down the in-flight provider HTTP fetch within ~2s.

### Bridge / no-bridge modes

When the Holo3 Electron app is running it exposes a localhost HTTP bridge at `:7900`. `agent_do` calls auto-forward to that bridge so they run inside the Electron process — the user's tray-menu provider choice is active, the Buddy bubble shows progress, history is persisted, and macOS perms (Screen Recording, Accessibility) are granted to the Electron binary.

When the bridge isn't reachable, `agent_do` falls back to running locally inside the MCP server's process. That requires the host process (Claude Code, etc.) to have macOS Screen Recording perms — if it doesn't, you'll see "Failed to capture screen". Either grant the perm to the host or start the Electron app and retry.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Failed to capture screen` | Host process is missing macOS Screen Recording. Either grant it (System Settings → Privacy & Security → Screen Recording) OR start the Holo3 Electron app so the bridge takes over. |
| Mouse/keyboard fires but nothing happens | Host process is missing Accessibility. Same place in System Settings. |
| `No Chrome tab attached` | User clicks the green Playwriter extension icon. |
| `agent_do` returns "Provider not configured" | User needs `HAI_API_KEY` (easiest), Modal creds, or local Ollama with the holo3 model. The MCP loads `.env` automatically. |
| `agent_do` returns `exhausted` | OBSERVE FIRST (`screen_screenshot` + `browser_snapshot`). The goal often already landed. If the screen confirms it isn't done, decompose into smaller tool calls — don't re-fire `agent_do` blindly. |
| `agent_do` validation error: "requires a surface" | You forgot the `surface` parameter. Pick one of `file-picker | finder | spotlight | dock | menu-bar | native-dialog | drag-drop | other`. If the action is in a Chrome page, switch to a `browser_*` tool instead. |
| Brain emitted invalid action twice → exhausted | The Holo3 model is mis-formatting (often regurgitating prompt text). Re-snapshot and re-call with a tighter task description. |
