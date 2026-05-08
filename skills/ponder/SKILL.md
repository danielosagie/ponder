---
name: ponder
description: Drive the user's REAL Chrome browser AND macOS desktop in a tight observe-decide-act loop. YOU are the planner — Ponder is your toolkit. After EVERY tool call, observe the new state (browser_snapshot or screen_screenshot) and decide your ONE next move. Never bundle multi-step goals into a single agent_do call. browser_* tools handle in-page Chrome; browser_set_input_files uploads files from disk without the native picker; agent_do handles ONE atomic OS-level mouse step (with a `surface` declared); the rest of screen_* are keyboard / scroll / inspect. Activates when the user mentions a website, asks to "open / visit / go to" a URL, asks to find/list/post/buy/search/message anything online, asks to drive a native app, or says "use ponder" / "use the ponder mcp".
---

# Ponder — drive Chrome + the macOS desktop in a state-grounded loop

**You are the planner. Ponder is your toolkit.** Worked examples and troubleshooting live in `REFERENCE.md`; this file is the rules.

## The loop (run this every time)

```
1. OBSERVE   browser_snapshot()  (Chrome)  OR  screen_screenshot()  (OS)
2. DECIDE    ONE next action — the smallest meaningful step
3. CALL      ONE tool for that action
4. READ      the result → goto 1
end when the goal is satisfied or a step legitimately failed
```

You're better at planning than the inner brain. Don't hand it multi-step goals — it over-decomposes.

## The four hard rules

1. **ref present → `browser_click` / `browser_type`** — never `agent_do`. Even if the click *opens* a native dialog, the click itself is in-Chrome.
2. **File upload from disk → `browser_set_input_files`** — never `agent_do`, never `browser_click` on the styled "Add photo" button as the upload step. The MCP surfaces hidden `<input type=file>` refs flagged `(use browser_set_input_files, accepts=…)`. If you don't see one, click the styled button first, then re-snapshot.
3. **agent_do requires a `surface`** — one of `file-picker | finder | spotlight | dock | menu-bar | native-dialog | drag-drop | other`. If the action is in a Chrome page, do NOT use agent_do; use a `browser_*` tool. Capped at 8 inner steps — atomic means atomic.
4. **After ANY tool call, observe before the next one.** The agent_do reply includes the final-frame screenshot — look at it FIRST. `exhausted` often means the goal already landed and the inner brain just couldn't recognize completion. NEVER chain another action without checking state.

## The 14 tools

| Tool | Surface | Use for |
|---|---|---|
| `browser_status` | Chrome | Cold-start probe (call first) |
| `browser_navigate(url)` | Chrome | Open / jump to a URL |
| `browser_snapshot()` | Chrome | List `[eN]` refs |
| `browser_click(ref)` | Chrome | One in-page click |
| `browser_type(ref, text, submit?)` | Chrome | One in-page type |
| `browser_set_input_files(ref, paths[])` | Chrome | Upload file(s) from disk — bypasses the native picker |
| `browser_scroll(dir, ref?, amount?)` | Chrome | Scroll page or element |
| `browser_read(ref?)` | Chrome | Get cleaned page text |
| `agent_do(task, surface, context?, goal?)` | OS mouse | ONE atomic OS mouse step |
| `screen_screenshot()` | OS | Inspect current screen |
| `screen_type(text, thenPress?)` | OS | Type at OS focus |
| `screen_hotkey(combo)` | OS | Keyboard shortcut |
| `screen_scroll_os(dir, amount?)` | OS | Scroll non-Chrome surface |
| `screen_wait(ms)` | OS | Sleep (use sparingly) |

There is intentionally NO low-level mouse-aim tool. For OS mouse work, use `agent_do` with `surface` set.

## What "ONE step" means

ONE tool call, ONE observable state change.

✅ `browser_navigate("…")` · `browser_click("e15")` · `browser_type("e16", "Bulbasaur")` · `browser_set_input_files("e22", ["/Users/me/Desktop/photo.png"])` · `agent_do(task: "click Open in the file picker", surface: "file-picker")` · `screen_hotkey("cmd+tab")`

❌ `agent_do(task: "open Marketplace, find listing, click Add Photo, select my screenshot, upload it", …)` — that's 5+ tool calls. YOU drive that loop.

## When to reach for agent_do

Only when there's no `[eN]` ref AND no keyboard path. Always pass `surface`:

- File picker rows / Open / Cancel buttons → `surface: "file-picker"` (BUT prefer `browser_set_input_files` whenever you can — it skips the picker entirely)
- Finder windows → `surface: "finder"`
- Spotlight items → `surface: "spotlight"`
- Dock / menu-bar icons → `surface: "dock"` / `surface: "menu-bar"`
- System permission/alert dialogs → `surface: "native-dialog"`
- OS-level drag-and-drop → `surface: "drag-drop"`
- Anything else genuinely OS-level → `surface: "other"` and supply `context`

Use `goal` to give the brain framing context: `agent_do(task: "click Open", surface: "file-picker", goal: "uploading screenshot to Marketplace listing")`.

## Quick rules of thumb

- **Disabled refs** are flagged `(disabled)` — UNCLICKABLE. Pick the autocomplete suggestion ref first.
- **Suggestion refs** are flagged `(suggestion)` — for autocomplete dropdowns; click one to un-disable Apply.
- **File-input refs** are flagged `(use browser_set_input_files, accepts=…)` — that's the right tool, never click them.
- **Redirected URL** (navigate returned ≠ requested) — DO NOT re-emit the same navigate; accept the redirect or use on-page nav.
- **Same action failed twice** — STOP. Re-snapshot. Re-decide based on actual state.
- **agent_do returned `exhausted`** — observe BOTH `browser_snapshot` AND `screen_screenshot`. Half the time the work is already done.

## Reporting results

Past tense, lead with the answer. Informational request → answer + bulleted list with title/price/URL. Procedural task → one short past-tense confirmation. Got stuck → what blocked you, what's currently on screen, one concrete next step. NEVER start with "I will…" / "Let me…".

## Need more?

Worked examples (Bulbasaur upload, search listings, Calculator), search/location form patterns, troubleshooting (perms, bridge mode, provider config), and cost notes are in `REFERENCE.md` next to this file.
