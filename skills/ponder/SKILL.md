---
name: ponder
description: Drive the user's REAL Chrome browser AND macOS desktop in a tight observe-decide-act loop. YOU are the planner — Ponder is your toolkit. After EVERY tool call, observe the new state and decide your ONE next move. browser_* tools handle in-page Chrome; browser_set_input_files uploads files without the native picker; agent_click / agent_drag are the FAST primitives for atomic OS-level actions you already know how to describe (~2-3s, like browser_click but vision-grounded); agent_do is the autonomous loop for open-ended OS work where the brain decides verb AND target; agent_observe previews where a click would land. screen_* are keyboard / scroll / inspect. Activates when the user mentions a website, asks to "open / visit / go to" a URL, asks to find/list/post/buy/search/message anything online, asks to drive a native app, or says "use ponder" / "use the ponder mcp".
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

## The five hard rules

1. **ref present → `browser_click` / `browser_type`** — never `agent_*`. Even if the click *opens* a native dialog, the click itself is in-Chrome.
2. **File upload from disk → `browser_set_input_files`** — never `agent_*`, never `browser_click` on the styled "Add photo" button as the upload step. The MCP surfaces hidden `<input type=file>` refs flagged `(use browser_set_input_files, accepts=…)` — so the **FIRST move on any upload task is `browser_snapshot`, NOT a click.** Most styled "Add photo" buttons surface the underlying input directly without anything having to "open" first; clicking around before you've snapshotted wastes calls. If the snapshot legitimately doesn't show one, THEN click the styled button and re-snapshot. **Don't know the exact path?** Use a Bash tool (`ls -t ~/Desktop/Screenshot*.png | head -1`, `find ~/Documents -name "report.pdf"`, `mdfind …`) to read it from disk — NEVER open Finder via `agent_do(surface: "finder")` to "find" a file; that burns ~30s of vision clicks when one Bash call gives you the path instantly. The path resolver is **whitespace-tolerant** (it auto-fixes the macOS Screenshot U+202F-vs-ASCII-space gotcha and case differences) so passing `~/Desktop/Screenshot 2026-05-08 at 1.59.53 PM.png` works even though the on-disk filename uses a NARROW NO-BREAK SPACE between the time and "PM" — but supplying the path you literally read from `ls` is still the safest move. **Native picker is open AND you know the absolute path?** `screen_hotkey("cmd+shift+g")` → `screen_type(path, thenPress: "enter")` → `screen_hotkey("enter")`. Three calls, ~1-2s, no vision. Works on every macOS file picker.
3. **OS-level click you can describe → `agent_click(target, mode?)`. OS-level drag → `agent_drag(from, to)`.** These are the FAST primitives — ~2-3s per call, same shape as `browser_click` but vision-grounded for things outside Chrome (file picker rows, Open buttons, Finder items, Spotlight results, dock icons, menu-bar items). They return a post-action screenshot so you can verify in the same reply. Use these whenever you already know the verb AND the target.
4. **agent_do is the AUTONOMOUS loop, not the default OS-click tool.** Reach for it ONLY when the brain has to decide verb AND target as it goes (open-ended exploration, multi-step OS dance with unknown surfaces). For atomic actions, agent_click is 5× faster. agent_do still requires a `surface` declaration; capped at 8 inner steps.
5. **After ANY tool call, observe before the next one.** agent_click and agent_drag include a post-action screenshot in their reply — look at it FIRST. agent_do replies include a final-frame screenshot — look at it FIRST. `exhausted` often means the goal already landed and the inner brain just couldn't recognize completion. NEVER chain another action without checking state.

## The 19 tools

| Tool | Surface | Use for |
|---|---|---|
| `browser_status` | Chrome | Cold-start probe (call first). Lists tab count + `*` marker; if >1 tabs attached, response shows them inline. |
| `browser_list_tabs()` | Chrome | Enumerate every attached tab — call when `browser_snapshot` returned an unexpected URL. |
| `browser_switch_tab({index?, urlIncludes?, pattern?})` | Chrome | Switch which tab subsequent browser_* targets. Common: `{urlIncludes: "edit"}`. |
| `browser_navigate(url)` | Chrome | Open / jump to a URL |
| `browser_snapshot()` | Chrome | List `[eN]` refs |
| `browser_click(ref)` | Chrome | One in-page click |
| `browser_type(ref, text, submit?)` | Chrome | One in-page type |
| `browser_set_input_files(ref, paths[])` | Chrome | Upload file(s) from disk — bypasses the native picker |
| `browser_scroll(dir, ref?, amount?)` | Chrome | Scroll page or element |
| `browser_read(ref?)` | Chrome | Get cleaned page text |
| **`agent_click(target, mode?)`** | **OS mouse** | **Atomic vision-grounded click (~2-3s). FIRST CHOICE for OS-level clicks you can describe.** |
| **`agent_drag(from, to)`** | **OS mouse** | **Atomic vision-grounded drag-and-drop (~2-3s). Parallel grounding of both endpoints.** |
| **`agent_observe(target)`** | **OS** | **Preview where a click would land WITHOUT clicking. Sanity check before commit.** |
| `agent_do(task, surface, context?, goal?)` | OS mouse | AUTONOMOUS loop for open-ended OS work — when verb AND target need to be decided as it goes |
| `screen_screenshot()` | OS | Inspect current screen |
| `screen_type(text, thenPress?)` | OS | Type at OS focus |
| `screen_hotkey(combo)` | OS | Keyboard shortcut |
| `screen_scroll_os(dir, amount?)` | OS | Scroll non-Chrome surface |
| `screen_wait(ms)` | OS | Sleep (use sparingly) |

> **`screen_click` / `screen_drag` / `screen_observe` are not real tools** — they return a redirect to `agent_click` / `agent_drag` / `agent_observe` (the `agent_*` namespace = vision-grounded; `screen_*` = keyboard / scroll / inspection). If you call them, you'll see the redirect; just re-call against `agent_*`.

`agent_click` and `agent_drag` are the OS-layer equivalent of `browser_click` — fast, atomic, deterministic-feeling. Reserve `agent_do` for the cases where you genuinely don't know what to click yet.

## What "ONE step" means

ONE tool call, ONE observable state change.

✅ `browser_navigate("…")` · `browser_click("e15")` · `browser_type("e16", "Bulbasaur")` · `browser_set_input_files("e22", ["/Users/me/Desktop/photo.png"])` · `agent_click("the Open button in the file picker")` · `agent_drag("the document.pdf icon", "the trash in the dock")` · `screen_hotkey("cmd+tab")`

❌ `agent_do(task: "open Marketplace, find listing, click Add Photo, select my screenshot, upload it", …)` — that's 5+ tool calls. YOU drive that loop.

## When to reach for which OS tool

Decision order:

1. **Already know the verb + target?** → `agent_click(target, mode?)` or `agent_drag(from, to)`. ~2-3s. Returns post-action screenshot. This is the default; it's like `browser_click` but for the OS layer.
2. **Want to verify the target exists before committing?** → `agent_observe(target)` first, then `agent_click(target)` if it looks right. The observe call returns a screenshot with the model's grounding noted; the click call re-grounds (don't pass coords back).
3. **Don't know what to click yet — open-ended exploration?** → `agent_do(task, surface, context?, goal?)`. The autonomous loop runs the brain to figure out verb + target as it goes. Always pass `surface`.

`agent_click` examples:
- `agent_click("the Open button in the file picker")`
- `agent_click("the highlighted Screenshot file in the Today section", mode: "double")`
- `agent_click("the Calculator icon in the dock")`
- `agent_click("the green Playwriter extension icon in the Chrome toolbar")`

`agent_drag` examples:
- `agent_drag("the document.pdf icon on the Desktop", "the trash in the dock")`
- `agent_drag("the brightness slider handle", "the right end of the slider track")`

`agent_do` surface enum (when you do need it):
- File picker rows / Open / Cancel buttons → `surface: "file-picker"` (but prefer `browser_set_input_files` whenever you can)
- Finder windows → `surface: "finder"`
- Spotlight items → `surface: "spotlight"`
- Dock / menu-bar icons → `surface: "dock"` / `surface: "menu-bar"`
- System permission/alert dialogs → `surface: "native-dialog"`
- OS-level drag-and-drop → `surface: "drag-drop"` (but `agent_drag` is faster if you know both endpoints)
- Anything else genuinely OS-level → `surface: "other"` and supply `context`

Use `goal` to give the autonomous brain framing context: `agent_do(task: "navigate Spotlight and pick the right Calculator", surface: "spotlight", goal: "computing 7*8")`.

## Quick rules of thumb

- **Disabled refs** are flagged `(disabled)` — UNCLICKABLE. Pick the autocomplete suggestion ref first.
- **Suggestion refs** are flagged `(suggestion)` — for autocomplete dropdowns; click one to un-disable Apply.
- **File-input refs** are flagged `(use browser_set_input_files, accepts=…)` — that's the right tool, never click them.
- **Redirected URL** (navigate returned ≠ requested) — DO NOT re-emit the same navigate; accept the redirect or use on-page nav.
- **Same action failed twice** — STOP. Re-snapshot. Re-decide based on actual state.
- **agent_do returned `exhausted`** — observe BOTH `browser_snapshot` AND `screen_screenshot`. Half the time the work is already done.
- **`browser_status` says "not attached"** — Chrome's security requires a user gesture. Take ONE `screen_screenshot` to see Chrome's actual state, then give the user ONE concise instruction ("Click the green Playwriter icon on the <tab> tab" if Chrome is visible; "Open Chrome to <url> and click the green Playwriter icon" if it isn't). Do NOT relay the verbose error message verbatim. Do NOT call `agent_do` to "attach" — it can't.
- **`browser_status` shows an unexpected URL** (or `>1` tabs attached and the `*` is on the wrong one) — call `browser_switch_tab({urlIncludes: "<substring>"})` to switch. Common when the user has the green icon clicked on multiple tabs. The response from `browser_status` already lists all tabs inline when there are multiple — pick from there.

## Reporting results

Past tense, lead with the answer. Informational request → answer + bulleted list with title/price/URL. Procedural task → one short past-tense confirmation. Got stuck → what blocked you, what's currently on screen, one concrete next step. NEVER start with "I will…" / "Let me…".

## Need more?

Worked examples (Bulbasaur upload, search listings, Calculator), search/location form patterns, troubleshooting (perms, bridge mode, provider config), and cost notes are in `REFERENCE.md` next to this file.
