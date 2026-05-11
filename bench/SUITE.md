# Ponder OS-Level Benchmark Suite

**Purpose**: Define a concrete, execution-scored benchmark suite for the OS surface — the part Playwriter doesn't reach. macOS-first because that's our target user. Hard-task-first because field SOTA on macOS multi-app is 3.7% (macOSWorld), so even modest improvements are meaningful.

## Anchor public benchmarks (citations)

- **macOSWorld** ([paper](https://arxiv.org/html/2506.04135v4)) — 202 tasks, 30 apps, 28 macOS-exclusive (Finder, Spotlight, Preview, Notes, Calendar, AppleScript surfaces). Execution-scored. Claude/OpenAI CUA >30% overall; **multi-app subset = 3.7%**. **The benchmark to beat for macOS-specific automation.**
- **ScreenSpot-Pro** ([repo](https://github.com/likaixin2000/ScreenSpot-Pro-GUI-Grounding)) — 1,581 UI elements across 23 pro apps × 3 OSes. Pure top-1 click-hit grounding. Current SOTA: Qwen3VL-32B 74%, GPT-5.2 86%, **UI-TARS-72B 22.8%**. **The public yardstick for raw grounding precision** (which is what our Calculator bench measures).
- **OSWorld** ([repo](https://github.com/xlang-ai/OSWorld)) — 369 Ubuntu tasks. Headlines (~72% on OSWorld-Verified) overstate raw GUI ability: ~45% are solvable via terminal/Python fallback. GUI-locked subset (Impress formatting, GIMP transforms, Chrome multi-step, multi-app workflows) is where SOTA still clusters <30%.

## Difficulty axes (field consensus)

A task scores HARD if it stacks multiple of:

1. **Grounding precision** — sub-50px targets, dense toolbars, icon-only UI
2. **Multi-app handoff** — state must survive an app context switch (clipboard, filesystem, drag-drop)
3. **Modal dialog navigation** — save/open pickers, permission prompts, login walls
4. **Drag / precision input** — continuous motion + state-reading mid-drag, slider adjustment
5. **State-reading** — agent must READ the screen (a value, a count, a confirmation), not just click
6. **Persistent system config** — change survives reboot (not just a transient toggle)
7. **Long-horizon** — 10+ atomic actions
8. **Infeasibility** — task can't actually be completed; correct answer is "FAIL" not "DONE"
9. **Irreversibility** — wrong move loses data (delete file, force-quit unsaved, git push)
10. **Cross-language** — UI labels in non-English (we'll skip this axis until SOTA infra is solid)

A task that hits 4+ axes is what the field calls "hard". We target stacks of 4-6.

## Suite structure — 5 tiers, 35 tasks total

Tier names reflect what's blocked:

| Tier | Tasks | Difficulty | Current Ponder status |
|---|---|---|---|
| **T1 Smoke** | 5 | Single-app, single action | Mostly works (e.g. Calculator if uncropped) |
| **T2 Native macOS apps** | 8 | Single-app, 3-6 step flows | Mixed; grounding precision floor |
| **T3 Modal + file picker** | 6 | Multi-state with OS dialogs | Largely fails today (login wall problem) |
| **T4 Multi-app handoff** | 8 | The 3.7% category | **The headline benchmark** |
| **T5 Edge cases** | 8 | Infeasibility, recovery, precision-drag | Largely untested |

Per-task spec lives in `bench/cases/<task-id>.md`. Each case carries:
- `task_id` (unique slug)
- `tier` (T1-T5)
- `axes` (which of the 10 difficulty axes apply)
- `task` (the verbatim natural-language prompt)
- `surface` (file-picker / finder / spotlight / dock / menu-bar / native-dialog / drag-drop / other / chrome)
- `setup` (state to establish before the run — what's open, what file exists, where the cursor is)
- `scoring` (the deterministic checker — AppleScript / file-diff / `defaults read` / OCR-as-last-resort)
- `expected_actions` (rough happy-path action count for budgeting)
- `infeasible` (bool — `true` for trap tasks where correct answer is FAIL)
- `prior_results` (per-run JSON in `bench/results/<task-id>-<model>-<iso>.json`)

## Scoring philosophy (the OSWorld lesson)

Don't trust screenshot OCR as the primary signal. **Deterministic state inspection** is what makes the score trustworthy. Concretely, in priority order:

1. **AppleScript / JXA getters** — `tell application "Calculator" to get value of display`, `tell application "Notes" to count of notes whose name is X`. Works for native apps. Already infrastructure exists for Calculator and Chrome URL.
2. **File state diff** — for any task that writes a file, compare bytes / structured content (PIL for images, openpyxl for xlsx, PyMuPDF for PDF).
3. **System config inspection** — `defaults read`, `osascript -e "get volume settings"`, `system_profiler`. For persistent settings.
4. **Process state** — `ps aux | grep`, port listening checks, for "did Chrome relaunch" type questions.
5. **OCR via Tesseract on the post-screenshot** — ONLY as fallback when none of the above apply (rare; mostly for terminal-rendered output).

Each `bench/cases/*.md` declares its checker explicitly so a `bench/run.ts` harness can execute it autonomously.

## Tier 1: Smoke (5 tasks)

T1 is for catching regressions, not measuring intelligence. Each task is **one app, one purpose**, and should land in **≤3 actions** with a fast model.

- `t1-calc-mouse-math` — 47 × 8 in Calculator via clicks. (Existing — `bench/cases/calculator-mouse-math.md`)
- `t1-calc-key-math` — Same answer via keyboard digits + operators. Tests keyboard path.
- `t1-spotlight-open` — Open Notes via Spotlight (cmd+space → "Notes" → enter). Scored: Notes process running + window front.
- `t1-finder-cd-desktop` — Open Finder, navigate to Desktop. Scored: Finder front window has Desktop in its path.
- `t1-dock-launch` — Click a specific dock icon (the rightmost) by description. Scored: that app's process becomes frontmost.

## Tier 2: Native macOS apps (8 tasks)

Single app, but the **happy path is 3-6 actions** and includes state-reading.

- `t2-notes-create-titled` — Create a new note titled "Bench Test Mon" with body "today's date is …". Scored: AppleScript `count notes whose name is "Bench Test Mon"`.
- `t2-calc-scientific-mode` — Switch Calculator from Basic to Scientific via View menu. Scored: window width >= 400 (Sci is 458 wide).
- `t2-preview-crop-image` — Open a known image in Preview, crop to 200×200 from center, save. Scored: image dims via `sips -g pixelWidth -g pixelHeight`.
- `t2-calendar-create-event` — Create a Calendar event "Bench Demo" at 3pm today. Scored: `osascript -e 'tell application "Calendar" to count events of calendar "Calendar" whose summary is "Bench Demo"'`.
- `t2-system-settings-volume-max` — Open System Settings → Sound, set output volume to max. Scored: `osascript -e "output volume of (get volume settings)"` returns 100.
- `t2-screenshot-region` — Take a region screenshot with cmd+shift+4, save to Desktop. Scored: PNG appears in `~/Desktop/Screenshot*.png` newer than run start.
- `t2-finder-rename-file` — Rename a known file on Desktop. Scored: `ls ~/Desktop/<newname>` returns it.
- `t2-preview-rotate-180` — Open a PDF in Preview, rotate it 180°, save. Scored: PDF orientation flag via PyMuPDF.

## Tier 3: Modal + file picker (6 tasks)

Hits axes 3 (modal navigation), 5 (state-reading), often 9 (irreversibility).

- `t3-save-with-rename` — In TextEdit, type text, cmd+S, navigate the save dialog to a non-default folder, rename, save. Scored: file appears at exact target path.
- `t3-permission-prompt-grant` — Open an app that triggers a permission prompt (Screen Recording for a screenshot tool); click "Allow". Scored: `tccutil` query confirms grant. (Infeasible variant: same prompt, but task asks to DENY — agent must distinguish.)
- `t3-finder-go-to-folder` — In Finder, cmd+shift+G (Go to Folder dialog), type a path, navigate there. Scored: front Finder window's target is the path.
- `t3-export-with-format-choice` — Preview Export As PDF with a specific quality setting in the save dialog's format chooser. Scored: PDF file appears + has the right file size band.
- `t3-app-update-dialog-defer` — When an app shows an update dialog, choose "Remind me later" not "Install now". Scored: app version unchanged + dialog dismissed.
- `t3-info-dialog-close` — Read a piece of info from a native dialog (e.g., About box), report the value, dismiss the dialog. Scored: the bridge's transcript contains the reported value matching expected.

## Tier 4: Multi-app handoff (8 tasks) — the headline benchmark

**This is the 3.7% category.** Tasks where state must survive a context switch. Each task is **2-3 apps + ≥1 handoff mechanism** (clipboard, file, drag, screenshot).

- `t4-screenshot-to-notes` — Take a region screenshot, paste it into a new Note titled "Screenshot Bench". Scored: AppleScript reads Notes; note contains an image attachment.
- `t4-numbers-table-to-pages` — Copy a known cell range from Numbers, paste as table into Pages document, save. Scored: Pages doc XML has a table with the expected dims.
- `t4-finder-drag-to-mail` — Drag a file from Finder into a Mail compose window's attachment area. Scored: Mail draft has attachment with that filename.
- `t4-calendar-mail-event` — Read an event from Calendar, compose a Mail message describing it, send to self. Scored: Mail inbox has message with subject matching event.
- `t4-safari-link-to-notes` — In Safari, copy the current page URL, switch to Notes, paste into a new note. Scored: Notes contains a URL matching Safari's frontmost tab.
- `t4-finder-zip-and-mail` — Right-click a Desktop file → Compress; then Mail the .zip. Scored: .zip exists on Desktop + Mail draft has the .zip attached.
- `t4-vs-code-open-from-finder` — From Finder, right-click a folder → "Open with → VS Code". Scored: VS Code has that folder open as workspace.
- `t4-clipboard-roundtrip` — Copy text from a Chrome page → paste into Notes → modify → copy from Notes → paste into Mail compose. 4 apps. Scored: Mail compose body contains the modified text.

## Tier 5: Edge cases (8 tasks)

Specifically tests anti-patterns SOTA models fall into.

- `t5-infeasible-toggle-darkmode-without-settings` — Task: "Turn dark mode off using ONLY the menu bar (don't open System Settings)". macOS doesn't expose this in the menu bar by default. Correct answer: FAIL. Scored: agent returns infeasibility verdict, NOT a hallucinated DONE.
- `t5-infeasible-rename-readonly` — Try to rename a read-only file in /usr/local. Correct answer: FAIL. Scored: file unchanged + agent emits FAIL.
- `t5-modal-dismiss-then-task` — A blocking modal appears mid-task; agent must dismiss it BEFORE pursuing the original goal. Scored: original task complete AND modal dismissed.
- `t5-recovery-from-wrong-app-focus` — Start a task; mid-flight, the user (or a system event) brings a different app to front. Agent must detect focus loss and re-raise the target. Scored: original task lands.
- `t5-precision-slider-25-percent` — In an app with a slider (e.g., screen brightness), set it to exactly 25%. Tests drag precision. Scored: brightness value via `brightness -l` within ±5%.
- `t5-drag-window-to-other-display` — Drag the front window from the secondary display to the primary. Scored: window's display id changes.
- `t5-undo-by-cmd-z` — Make a clearly wrong action (delete a file), then cmd+z to undo. Scored: file still exists.
- `t5-spotlight-bypass-detect` — Task says "without using Spotlight". Agent must navigate via Finder/Dock instead. Scored: original target reached AND Spotlight never opened (verify via no Spotlight process activity in the transcript).

## Existing Ponder capabilities mapped to suite

What we **already have** working that helps:

| Capability | Coverage |
|---|---|
| Screen capture (Electron bridge `/screen/screenshot`) | All tiers |
| Click via cliclick (no cursor hijack) | All tiers |
| Keyboard primitives (hotkey, type) | T1, T2 keyboard tasks |
| `targetApp` window crop | T2, T3, T4 (5× speedup on Chrome proven) |
| `getMacWindowBounds` + raise-then-recapture | T3, T4 modal-blocked tasks |
| Bounds-validate clicks | T4, T5 (prevents wandering) |
| `/browser/url` + title fallback | T4 cross-tab tasks |
| Strict URL-aware verifier | T4 false-positive elimination |
| No-op-spam anti-loop | All tiers (saves dead time) |
| Coord-scatter anti-loop | All tiers (catches hallucination) |
| AppleScript via bridge perms | Scoring infrastructure |

What we **need to build** for the suite:

1. **A `bench/run.ts` harness** that:
   - Reads `bench/cases/*.md` front-matter
   - Establishes `setup` state (opens apps, places files)
   - Invokes the agent (agent_do via bridge)
   - Runs the `scoring` checker
   - Writes a results JSON to `bench/results/<task-id>-<model>-<iso>.json`
   - Summarizes pass/fail to terminal

2. **Scoring checker helpers** (`bench/lib/`):
   - `appleScriptValue(script: string)` — run AppleScript, parse result
   - `fileDiff(path: string, expectedPath: string)` — byte/structural diff
   - `defaultsRead(domain: string, key: string)` — `defaults read X Y`
   - `tessOcr(pngPath: string, region?: rect)` — fallback OCR

3. **Setup utilities**:
   - `openApp(name)` — open + raise + wait for window
   - `placeFile(path, content)` — write test fixtures to disk
   - `clearClipboard()` — fresh state between tasks
   - `closeAllExcept([names])` — clean slate before each task

4. **Infeasibility evaluation**: agents need to be able to emit `FAIL: <reason>` cleanly. Currently we have implicit "exhausted" — explicit FAIL would let T5 score correctly.

## Scoring as a single number

```
ponder_score = (
  0.10 * tier1_pass_rate +
  0.20 * tier2_pass_rate +
  0.15 * tier3_pass_rate +
  0.40 * tier4_pass_rate +   # headline category
  0.15 * tier5_pass_rate
)
```

T4 weighted highest because that's where the field is at 3.7% — every point we gain there is meaningful. T1 weighted lowest because it's smoke-test only.

## Public visibility (later)

If we want to PUBLISH a Ponder benchmark number, the credible thing is:

- **Internal Ponder score** (above) — measures our specific stack
- **Plus a ScreenSpot-Pro grounding score** — public yardstick that lets people compare apples-to-apples to UI-TARS, GPT-5.2, etc.

Run both. ScreenSpot-Pro requires only static screenshots + click predictions; should be a single afternoon of harness work using the existing `provider.ground` primitive.

## Open questions for the team

1. **Do we instrument macOSWorld directly?** Its 202 tasks are macOS-native and execution-scored. We could fork it, run it through our agent, get a publishable number to compare against Claude/OpenAI CUA. Cost: ~1 week of harness work.

2. **What's our story for T5 infeasibility?** Right now `agent_do` returns `done | cancelled | exhausted`. We'd need a clean `infeasible` outcome that the brain can emit and the verifier validates. Worth adding before T5 is measurable.

3. **macOSWorld is multilingual (zh/ar/ru) — do we care?** GPT-4o loses 60% on Russian/Arabic. If our user base is English-only this is irrelevant for the bench score but might matter for product positioning.

4. **Do we make T4 tasks USER-state-dependent?** (e.g., "your most recent Calendar event") — more realistic but harder to score deterministically.

5. **Score recovery vs first-try?** macOSWorld allows up to 30 steps; we currently allow 50. Pushing toward fewer steps as a sub-metric encourages efficiency over brute force.
