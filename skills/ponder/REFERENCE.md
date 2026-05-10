# Ponder reference — worked examples, recovery, troubleshooting

The prescriptive rules live in `SKILL.md`. This file is everything else: examples to copy, patterns to recognize, recovery playbooks, and operational notes you only need when something's off.

---

## Worked examples

### 1. Upload a screenshot to a Marketplace listing (the right way)

User: "upload my latest screenshot to my Bulbasaur Marketplace listing."

```
1. browser_status                                           # where are we?
   → Attached. URL: …/marketplace/edit/?listing_id=…

2. browser_snapshot
   → [e14] file-input "" (use browser_set_input_files, accepts=image/*…)
     [e17] button "Add photo"
   The hidden <input type=file> is right there — flagged for you.

3. Bash: ls -t ~/Desktop/Screenshot*.png | head -1         # read the REAL path
   → /Users/you/Desktop/Screenshot 2026-05-08 at 1.59.53 PM.png

4. browser_set_input_files("e14", [<path-from-step-3>])
   → Attached 1 file to e14: Screenshot 2026-05-08 at 1.59.53 PM.png.

5. browser_snapshot                                         # verify
   → "Photos · 2 / 10" + new thumbnail visible

6. Report: "Uploaded the screenshot to the Bulbasaur listing."
```

6 tool calls. No native picker. No `agent_do`. No vision. The Bash call in step 3 is critical — guessing the path produces `ENOENT` and forces the agent down the slow vision-grounded picker path. `ls -t` (most-recent-first) + `head -1` is the canonical "latest screenshot" lookup.

If the file-input ref is missing from the snapshot:
```
browser_click("e17")          # click the styled "Add photo" — opens picker
browser_snapshot              # the hidden <input type=file> usually appears now
browser_set_input_files(<ref>, [path])
screen_hotkey("escape")       # dismiss the picker that's still on screen
browser_snapshot              # verify
```

### Native file picker is open AND you know the absolute path

The fastest path is the macOS "Go to folder" shortcut. Skips visual targeting entirely — works on every native file picker.

```
screen_hotkey("cmd+shift+g")                            # opens Go-to-folder overlay
screen_type("/abs/path/file.png", thenPress: "enter")   # path → file selected + previewed
screen_hotkey("enter")                                  # commit (Open is the default button)
```

3 OS-level calls. ~1-2s wall time. **No vision grounding.** Use this whenever `browser_set_input_files` isn't available AND the picker is already open.

If you DON'T know the absolute path: use Bash (`ls -t ~/Desktop/Screenshot*.png | head -1`, `find ~/Documents -name "report.pdf"`, `mdfind kMDItemDisplayName=…`) to read it from disk first, then run the recipe above.

### `browser_snapshot` returns a URL that doesn't match what's on screen

Playwriter is attached to a different tab than what the user is looking at. This is normal when the user has multiple tabs all "green" (extension clicked on each).

```
browser_status                                  # already shows tab list when >1 attached
# … OR if you need a fresh enumeration:
browser_list_tabs                               # see all attached tabs
browser_switch_tab({urlIncludes: "edit"})       # switch by URL substring
# or browser_switch_tab({index: 2})             # by absolute index
browser_snapshot                                # now reflects the right page
```

`browser_status` lists all attached tabs inline when there are >1, so usually you don't need a separate `browser_list_tabs` — just read the tabs from the status response and pick the one you want.

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

Some sites use a custom upload widget that doesn't expose a real `<input type=file>`. Then prefer the atomic primitives over `agent_do`:

```
1. browser_click("<add-photo-ref>")                            # opens picker
2. Bash: ls -t ~/Desktop/Screenshot*.png | head -1             # find the path
3. agent_click("the file with the timestamp in the picker",
               mode: "double")                                  # opens directly into the field
4. browser_snapshot                                            # verify
```

If the picker doesn't accept double-click for whatever reason, two atomic clicks:

```
3a. agent_click("the most recent screenshot in the Today section")  # selects
3b. agent_click("the Open button in the file picker")               # commits
```

Each `agent_click` is ~2-3s, includes a post-action screenshot in its reply, and grounds the description through the same vision model that powers agent_do — without the autonomous loop overhead. Reserve `agent_do(surface: "file-picker", ...)` for cases where the picker layout is unfamiliar enough that the brain genuinely needs to explore.

### 5. Native app — drag a file to the trash

```
1. agent_observe("the document.pdf icon on the Desktop")           # sanity check
   → Located at (542, 318); screenshot attached. Looks right.
2. agent_drag("the document.pdf icon on the Desktop",
              "the trash in the dock")
   → Dragged in ~3s. Post-drag screenshot shows the icon is gone.
3. (optional) agent_click("the trash in the dock")                 # verify
```

`agent_drag` grounds source AND target IN PARALLEL on a single screenshot, so total time is roughly one ground call (~1-2s) + the drag itself (~300ms) + post-screenshot. Both endpoints must be visible at the same time — no scroll between source and target.

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
| `browser_click` failed twice on same ref | `browser_snapshot` again — page may have repainted; ref may have vanished. Or fall back to `agent_click("<element description>")` for vision-grounded retry. |
| `browser_navigate` keeps redirecting | Accept the redirect; use on-page nav. |
| `browser_type` did nothing | Click the field with `browser_click` first, then type. |
| Same action repeated 2+ times | STOP. Re-snapshot. Re-decide based on actual state, not what you "would have done next". |
| `agent_click` clicked the wrong thing | Run `agent_observe(<better description>)` to see where the model thinks it is, then refine the description and `agent_click` with the new wording. Mention surface ("in the file picker"), position ("in the bottom-right"), or visual cue ("the highlighted row"). |
| `browser_snapshot` returns a URL that doesn't match what's visible | Multi-tab attachment. `browser_status` already lists all attached tabs when >1 — call `browser_switch_tab({urlIncludes: "..."})` to switch, then re-snapshot. |
| Tool not found / "No such tool: screen_click" | The tool is `agent_click` (or `agent_drag`, `agent_observe`). The `screen_*` redirect-stubs return a fail with the right tool name + your args ready to paste — just re-call with `agent_*`. |
| `browser_set_input_files: ENOENT` | The harness now auto-tolerates whitespace mismatches (macOS Screenshot's U+202F NARROW NO-BREAK SPACE vs the regular ASCII space the model can't visually distinguish) AND case differences. If ENOENT still fires, the file is GENUINELY missing or in a different directory — re-run Bash `ls` / `find` to confirm the location, don't just retry the same path. |
| `agent_do exhausted` | OBSERVE FIRST (both `screen_screenshot` and `browser_snapshot`). Half the time the goal already landed. |

### Never call `screen_hotkey` to "see what's in another window"

`cmd+tab` to "find the file picker" is blind navigation that loses focus and almost always makes the situation worse. If you don't know where a window is, `screen_screenshot` first.

---

## Tool choice guidelines

Default to keyboard-style verbs (`browser_navigate`, `browser_type`, `screen_hotkey`, `screen_type`) — fast and reliable. Mouse-style verbs (`browser_click`, `agent_click`, `agent_drag`, `agent_do`) win when picking a SPECIFIC item from a list (search-result card, dropdown suggestion, listing tile, file in a picker).

For uploads: `browser_set_input_files` first (skips the picker entirely), then `browser_click` + `agent_click` if the site doesn't expose a real `<input type=file>`. `agent_do(surface: "file-picker")` is the last resort for unfamiliar pickers where exploration is needed.

For OS-level mouse work: `agent_click` and `agent_drag` are the primary tools — they're like `browser_click` but vision-grounded. `agent_do` is reserved for autonomous loops where the brain has to figure out the next verb AND target as it goes.

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
