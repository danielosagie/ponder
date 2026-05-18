# Refactor the Ponder/Holo3 orchestration boundary

## Context

The Bulbasaur upload took **26 tool calls** for a flow that should be **4**. The
trace from the user's logs shows two systems fighting each other:

1. **Capability gap** — Facebook's "Add photo" is an `<input type=file>` that
   Playwright's `setInputFiles()` could fill in one call. We don't expose it,
   so the only path is the native macOS file picker, which Holo3 vision is
   weak on (it can't reliably ground "the most recent screenshot" in a Finder
   sheet).
2. **Orchestration gap** — when vision struggles, our guards rebound the work
   back to the orchestrator with text-shaped advice that re-triggers the same
   guard on the next call. The orchestrator did the right decomposition; the
   guards rejected the *punctuation*, not the intent. Anti-loop bailed on
   actions that were actually working (the screenshot really was selected
   when "click Screenshot..." was killed as a 3/4 repeat).

Goal: make the contract between orchestrator and inner agent **explicit and
narrow**, give the orchestrator a way to bypass vision when CDP can do the job,
and make the safety guards solve problems instead of relaying them.

## Observed failures (from the user's logs)

| # | Symptom | Tool calls wasted |
|---|---------|---|
| F1 | `agent_do` rejected "find the screenshot from Desktop **and** click Open" — 2 separators tripped the compound-task heuristic | 2 |
| F2 | `agent_do` rejected `click on the "Screenshot 2...PM.png" file` because the click-verb regex doesn't know the file picker is OS-level (the orchestrator already named "file picker dialog" in the *previous* call but the guard only sees the current task string) | 2 |
| F3 | Anti-loop killed `click {"x":668,"y":363}` after 3 repeats — but the file *was* selected (next screenshot showed highlight + preview). False positive. | 3 |
| F4 | Brain emitted `"The last step was incorrect. The current step is:"` as an "action" — it parroted the user-prompt guidance text. There is no output validator. | 2 |
| F5 | `cmd+space` opened Spotlight but the brain then pressed Enter into nothing 3 times (it didn't see Spotlight wasn't focused). Anti-loop killed it. | 5 |
| F6 | `agent_do` returned `DONE` after a single click without confirming the file picker actually opened — `/\bDONE\b/i` matches loosely | 1 |
| F7 | Each `agent_do` call ran with `maxSteps=50, stepPause=6500ms` — capacity for ~5 minutes of inner-loop suffering before bailing | (time, not calls) |
| F8 | Orchestrator-side workaround: drag the file from Desktop to Add Photo. The vision agent got `Outcome: exhausted` after 3 stuck clicks on Add Photo. | 3 |

Net: ~18 of the 26 tool calls were guard-induced thrash, not real work.

## Root causes

1. **No `browser_set_input_files` MCP tool.** Playwright supports it; our
   `BrowserClient` interface doesn't expose it (see
   `src/agent/browser/types.ts:36-88`). This forces every file upload through
   the native picker, which is the surface our vision model is worst on.
2. **`<input type=file>` is invisible in `browser_snapshot`.** They serialize
   as a generic textbox (see `playwriter.ts:241-248`), so the orchestrator
   has no signal to prefer setInputFiles even if it existed.
3. **Text-heuristic guards on `agent_do` are over-eager.** Both guards
   (compound-task by separator count, in-Chrome by click-verb regex) infer
   intent from the task *string* rather than from declared semantics
   (`src/mcp/tools.ts:520-592`). Natural-sounding tasks fail; the
   orchestrator must reverse-engineer guard syntax to get through.
4. **`isDone()` matches `DONE` anywhere in the action.**
   `src/agent/brain.ts:145-147` uses `/\bDONE\b/i` — any phrase containing
   the word slips through.
5. **No validation that the brain's output is a real verb.** If the model
   echoes prompt text or an explanation, the loop tries to ground it as a
   click target (see logs: "click {x:584,y:731}" on text that was meta-
   reasoning).
6. **Anti-loop ignores screen change.** The loop already prefetches a
   `screenHash` per step (see `loop.ts:756`) but only checks action
   repetition, not whether the screen actually changed. Repeated same-action
   with changing screen = real progress, not a loop.
7. **`flat` mode drops `overallGoal`.** `loop.ts:179-189` explicitly sets
   `overallGoal: undefined` for `agent_do`. The brain has no idea why it's
   selecting a screenshot or what to do if the file picker isn't the right
   dialog.
8. **History annotations look like actions.** Strings like
   `(rejected: clicked disabled e3 …)` are pushed to `history[]` as if
   they're past actions (`loop.ts:736-738, 698, 958`). The brain reads them
   back next step and sometimes echoes the prose into its own output (F4).
9. **`MAX_STEPS=50, stepPause=6500ms` for `agent_do`.** Atomic OS-level
   steps shouldn't ever need 50 attempts. A high cap turns "this isn't
   working" into "this isn't working for 5 minutes."
10. **The /ponder skill is a 275-line essay.** The orchestrator has to
    internalize prose to behave well. A prescriptive ~80-line checklist
    would do better and leave room for fewer mistakes.

## Recommended changes — prioritized

### P0 — capability fix (highest leverage)

**P0.1  Add `browser_set_input_files` MCP tool.** A single new tool turns
this 26-call task into ~4 calls. Implementation is small:
- `src/agent/browser/types.ts` — add `setInputFiles(ref: string, paths: string[]): Promise<void>` to `BrowserClient`.
- `src/agent/browser/playwriter.ts` — implement via
  `await page.locator(refToSelector(ref)).setInputFiles(paths)`.
  `refToSelector` already exists at line 590.
- `src/mcp/tools.ts` — register `browser_set_input_files` next to
  `browser_click` (model the handler on lines 1072-1083). Description must
  state: "use this for ANY upload of a file already on disk; do not use
  agent_do to navigate the file picker — this skips the picker entirely."

**P0.2  Mark file inputs distinctively in `browser_snapshot`.** In
`playwriter.ts` SNAPSHOT_SCRIPT (around line 241), when serializing an
`input[type=file]` emit a different role label, e.g.
`[e15] file-input "Add photo" accept="image/*"` instead of the generic
textbox shape. This is the discoverability cue that tells the orchestrator
to reach for `browser_set_input_files`.

### P1 — make the orchestrator/inner-agent contract explicit

**P1.1  Replace text-heuristic guards on `agent_do` with a `surface` enum.**
- Drop the compound-task separator counter (`tools.ts:520-551`).
- Drop the click-verb regex (`tools.ts:553-592`).
- Add required parameter `surface: "file-picker" | "finder" | "spotlight"
  | "dock" | "menu-bar" | "native-dialog" | "drag-drop" | "other"`.
- If `surface` is missing → reject with: "agent_do requires a `surface`
  declaration so we know it isn't reachable via browser_*. If the target is
  in a Chrome page, use browser_snapshot+browser_click instead."
- Add optional `context: string` (one sentence) the orchestrator passes
  through ("we're uploading a screenshot to a Marketplace listing"). The
  inner brain prepends this to the task so it can disambiguate weird states.

**P1.2  Cap `agent_do` at 8 inner steps default.** In `tools.ts` agent_do
handler (`loop.ts:179` invocation), pass `maxSteps: 8` and
`stepPause: 1500ms` — short, atomic, force re-planning at the orchestrator
layer. Today's 50/6500 means a single bad call burns 5 minutes.

**P1.3  Pass `overallGoal` through flat mode.** `loop.ts:184` currently
hardcodes `overallGoal: undefined` for flat mode — change to forward
`opts.overallGoal` so the brain has framing context. Surface this via a
new optional `goal` parameter on the `agent_do` MCP tool.

### P1 — fix the bugs that turn one mistake into N

**P1.4  Tighten DONE detection.** `src/agent/brain.ts:145-147`:
```
- return /\bDONE\b/i.test(action);
+ return /^\s*DONE\.?\s*$/m.test(action);  // line-anchored, optional period
```

**P1.5  Validate brain output is a real action verb.** In `brain.ts`,
after `provider.plan(...)` returns, regex-check the trimmed first line
against the allow-list (already documented at lines 138-139 plus drag/done):
```
^(click|double click|type|press|hotkey|drag|scroll|wait|done|browser\.)
```
If it doesn't match, do NOT push to history as an action; record an
internal `[invalid: <first 80 chars>]` note and re-call once with a
"emit exactly one verb on its own line" reminder. After two consecutive
invalid outputs → return `"exhausted"` cleanly.

**P1.6  Make anti-loop screen-aware.** `loop.ts:755-767`: add a parallel
check on the prefetched `screenHash`. Only bail when action is repeated
3/4 AND the screen hash hasn't changed across those 4 steps. If the screen
*is* changing, the action is making progress (Finder selecting files, list
auto-scrolling, dropdown filtering) — keep going.

**P1.7  Sanitize history annotations.** Change the synthetic-history
format from action-shaped to note-shaped so the brain can't echo it:
```
- const synthetic = `(rejected: clicked disabled ${ref} — pick a suggestion first)`;
+ const synthetic = `[note: previous click on disabled ${ref} was skipped — try a suggestion ref]`;
```
Apply at `loop.ts:698, 736, 958`. Brain prompt should also instruct: "lines
starting with `[note:` are system observations, not your prior actions —
do not quote them."

### P2 — make the orchestrator easier to onboard

**P2.1  Slim `skills/ponder/SKILL.md` to ≤90 lines.** Keep:
- The 4-step observe/decide/act loop
- The single hard rule: "ref present → browser_click; file upload → browser_set_input_files; native dialog → agent_do with surface set"
- A 6-line "tools at a glance" table
Move the worked examples + recovery playbooks to
`skills/ponder/REFERENCE.md` (loaded only if the orchestrator hits trouble).

**P2.2  Update `agent_do` tool description** to mention the new `surface`
parameter and the `browser_set_input_files` escape hatch. Remove
"select the most recent screenshot in this Desktop file picker and click
Open" from GOOD examples (that exact case should now be
`browser_set_input_files`).

## File-by-file change list

| File | Change |
|------|--------|
| `src/agent/browser/types.ts:36-88` | Add `setInputFiles(ref, paths)` to `BrowserClient` |
| `src/agent/browser/playwriter.ts:139-152` | Add `setInputFiles` to `PWPage` interface |
| `src/agent/browser/playwriter.ts:640-655` | Implement `client.setInputFiles` (mirror `client.click`) |
| `src/agent/browser/playwriter.ts:241-248` | Distinct serialization for `input[type=file]` in SNAPSHOT_SCRIPT |
| `src/mcp/tools.ts:483-514` | Update `agent_do` description: add `surface`/`context`/`goal` params, mention `browser_set_input_files` |
| `src/mcp/tools.ts:520-592` | Remove both text-heuristic guards; replace with `surface` enum check |
| `src/mcp/tools.ts:~841` | Pass `maxSteps: 8, stepPause: 1500` and forward `overallGoal` to `runMissionLoop` flat path |
| `src/mcp/tools.ts:~1090` | Register new `browser_set_input_files` tool (model on `browser_click`) |
| `src/agent/loop.ts:179-189` | Stop hardcoding `overallGoal: undefined` in flat mode |
| `src/agent/loop.ts:698, 736-738, 958` | Convert synthetic history strings to `[note: ...]` shape |
| `src/agent/loop.ts:750-767` | Add `screenHash` parity check before bailing on action-repeat |
| `src/agent/brain.ts:145-147` | Tighten `isDone` to line-anchored exact match |
| `src/agent/brain.ts:117-132` | Validate model output against verb allow-list; one retry then exhausted |
| `src/agent/providers/hcompany.ts:415-423` | Soften user prompt to remove echoable boilerplate; add "lines starting with `[note:` are system observations" |
| `skills/ponder/SKILL.md` | Slim to ~90 lines; new prescriptive checklist; cite `browser_set_input_files` for uploads |
| `skills/ponder/REFERENCE.md` | New file: worked examples + recovery playbooks moved out of SKILL.md |

## Existing utilities to reuse (no new code needed)

- `refToSelector` in `playwriter.ts:590-597` — reuse for `setInputFiles` impl.
- `screenHash` already prefetched per step in `loop.ts:756` (use as-is for
  P1.6).
- `KEYBOARD_ONLY` regex at `brain.ts:138-139` — extend, don't rewrite, for
  P1.5 verb allow-list.
- Existing `extractTypedText` + `normalizeAction` in `loop.ts` — leave
  alone, the screen-aware anti-loop just adds a parallel check.

## Verification

Run end-to-end before/after on the Bulbasaur task:

1. **Capability test (P0):** Point the orchestrator at the listing edit URL,
   then expect a flow of:
   - `browser_status` (probe)
   - `browser_navigate <url>`
   - `browser_snapshot` (sees `[eN] file-input "Add photo"`)
   - `browser_set_input_files e15 ["/Users/dosagie/Desktop/Screenshot ....png"]`
   - `browser_snapshot` (verify "Photos · 2 / 10")
   Total: 5 calls, no vision, no anti-loop, no `agent_do`.
2. **Guard test (P1.1):** Call `agent_do({task: "click the Open button",
   surface: "file-picker"})` — should run. Call without `surface` — should
   reject with the new structured-intent error. Call with
   `surface: "chrome-page"` — should reject pointing to `browser_*`.
3. **DONE regression (P1.4):** Mock the brain to emit "I'm DONE looking
   around"; loop should NOT terminate. Mock it to emit "DONE."; should.
4. **Brain validator (P1.5):** Mock the brain to emit "The last step was
   incorrect…"; the loop should treat it as invalid, retry once, and on
   second invalid exit "exhausted" cleanly without grounding text as a
   click target.
5. **Anti-loop screen-aware (P1.6):** Synthetic test: same action 4×,
   different `screenHash` each time → loop continues. Same action 4×, same
   `screenHash` → loop bails as before.
6. **Smoke test on a known-good non-upload flow** (e.g. "search marketplace
   for honda civic and report top 3 listings") — verify behavior unchanged
   and no new flakes from the guard removal.

If all six pass, run the original Bulbasaur task one more time and confirm
total tool count is ≤8.

## Out of scope (intentionally deferred)

- Replacing the `qwen3.5:0.8b` router or `holo3-35b-a3b` brain. Better
  models would help but the wins above are model-independent.
- Auto-correcting Spotlight-vs-Finder confusion (cmd+space → wrong target).
  Once `agent_do` requires `surface: "spotlight"` explicitly, the
  orchestrator can't accidentally end up there.
- Building a Convex-backed transcript replay system to debug guard
  decisions. Useful long-term, not on the critical path for the speed/
  reliability problem the user described.
