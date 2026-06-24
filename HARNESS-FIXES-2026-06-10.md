# Harness fixes — 2026-06-10

This session closed out both items from `NEXT-WORK-2026-05-18.md` and
root-caused the misclick/latency complex to THREE stacked bugs, all now
fixed and validated. Per-step time went **20–30s → ~3.5–4s warm**, and
grounding is correct **even when the target window is occluded**.

## Root causes found (in order of discovery)

### 1. nut-js screenshots were native Retina mislabeled `scaleFactor: 1`

NEXT-WORK's open question resolved by direct measurement: on a single
display, `screen.screenshot()`'s nut-js path returns a **3024×1964
native PNG** while reporting `1512×982, scaleFactor: 1`. Consequence
chain:

- `maybeCropToTargetApp` multiplied crop coords by `sf=1` and sliced a
  *logical-coordinate rect out of a native PNG* → the model was shown
  the **wrong region at half size** → ~100% mis-grounding on cropped
  steps (the "misclicks").
- The MIN_CROP_DIM_PX=300 guard therefore forced full-frame uploads
  (~1.6 MB ×2 per step) → the ~10s/call Modal latency ("takes
  forever").
- "It used to be good": with a multi-monitor setup, capture went
  through `captureViaDesktopCapturer`, which computes the true scale
  from IHDR. Going single-display silently switched to the broken path.

**Fix:** `screen.ts` nut-js path derives `scaleFactor` from the PNG's
IHDR dims (same pattern the desktopCapturer path already used).

### 2. `cropAndScalePng` mangled images (sips flag composition)

Combining `--cropToHeightWidth` + `--resampleHeightWidth` in ONE sips
invocation emits garbage (measured: a 460×816 crop + same-size resample
returned **70×339**). Split into two invocations.

**Fallout discovery:** the eyes.ts refine experiment was condemned 0/8
(~76px) on 2026-05-18 *because of this bug* — the model was grounding
mangled pixels. With the fix, the same bench scores **refined 8/8 at
~1px mean error — the most precise grounding mode measured**
(uncropped ~3px, cropped ~6px). Still default-off (costs one extra
ground call); enable `PONDER_GROUND_REFINE=1` for tiny-target surfaces.

Also: the crop now uses sips instead of Electron `nativeImage`, so it
**works in the tsx MCP process** (previously crop silently no-opped
outside Electron → MCP-driven runs always paid full-frame).

### 3. Floating windows defeat raise → crop captures the occluder

Live probe: the **iOS Simulator pins itself at CGWindowLevel 8**, above
every layer-0 window; `raiseMacApp` can never beat it, and the crop
captured the Simulator's pixels at Calculator's coords (the May-11
incident class, recurring — "the 7 button" grounded onto the Simulator).

**Fix:** `screen.captureWindowDirect(app)` — CGWindowList via a tiny
Swift helper (compiled once to `~/.ponder/bin/ponder-winlist`; JXA's
ObjC bridge segfaults on this call) + `screencapture -l<windowId>`,
which captures the window's **own backing store**: native-res,
crop-free, occlusion-proof, ~325ms. `maybeCropToTargetApp` prefers it
and falls back to the legacy recapture+sips-crop path. The same window
list gives deterministic **occlusion detection** — overlapping windows
are named in the log (clicks land on whatever is physically on top, so
the loop warns instead of failing silently).

## Item 2 (decompose) — implemented per spec

- `src/agent/decompose.ts`: ONE strong-model plan call → JSON array of
  atomic steps; any parse failure / ≤1 step / >12 steps (cap, env
  `PONDER_DECOMPOSE_MAX_STEPS`) degrades to flat. Never worse.
- Flat-branch integration in `runTask`: double-gated
  (`opts.decompose` AND `PONDER_DECOMPOSE=on`), per-step budget 8
  (`PONDER_DECOMPOSE_STEP_MAXSTEPS`), advance only on verified "done"
  (the in-subtask verifier/completion-probe gate), one retry on
  `exhausted`, second `exhausted` aborts, `infeasible` propagates,
  `MAX_STEPS_TOTAL` enforced.
- Threaded end-to-end: MCP `agent_do(multistep: true)` → bridge body
  `decompose: true` → `electron/main.ts` → `runTask`. Bench frontmatter
  `multistep: true` passes it too.

## Playwriter ↔ VLM sync

- `snapshot()` no longer calls `bringToFront()` unconditionally (it was
  reverting every tab switch the vision path or user made — the two
  stacks fought each step). It now **follows the visible tab**
  (`syncToVisibleTab`): adopts whichever tab is actually visible;
  forces front only when nothing is.
- `BrowserClient.geometry()` added: window + viewport bounds in OS
  logical coords + devicePixelRatio (via in-page `window.screenX`/
  outer-inner deltas) — the coordinate bridge for mapping DOM points to
  screen clicks.

## Logs → reproducible recipes

- **Self-healing replay** (Stagehand pattern): recorded `[eN]` refs are
  tried first; on failure, a fresh snapshot is taken and the step's
  recorded `refLabel` (role + name) re-resolves to the current ref.
- **Recorded pacing**: replay sleeps the recorded inter-step gap
  (clamped [150, 5000]ms) instead of a flat 400ms.
- Direct MCP `browser_click`/`browser_type`/`browser_set_input_files`
  now stamp `refLabel` + URL from the latched `browser_snapshot` (zero
  extra snapshots) → codegen emits durable `getByRole` selectors.
- Bridge-forwarded `agent_do` steps now **mirror into the process trace
  buffer** (previously silently missing from `ponder_recipe_save`), and
  the bridge transcript payload cap went 120 → 2000 chars so payloads
  survive the parse round-trip.

## Loop latency micro-fixes

- Completion probe now runs **concurrently with the plan call**
  (sequential only on rate-limited hcompany).
- Drag's two ground calls run concurrently.
- `stepPause` default 1200 → 400ms (env `PONDER_STEP_PAUSE_MS`);
  agent_do's pause 1500 → 500ms. Settles are unchanged and separate.

## Provider

- hcompany default model `holo3-35b-a3b` → `holo3-1-35b-a3b`
  (**the old id is deprecated by H Company on 2026-06-15**); `.env`
  updated too. H's docs for Holo3.x: grounding = temperature 0,
  thinking off, JSON-schema `{x,y}` in [0,1000] normalized against the
  exact image bytes sent; ≤3 screenshots in context; durable state in
  the `note` field. Our Modal pipeline already matches the coordinate
  convention.

## Validation (all green)

- `bench/vision-precision.ts --case calculator`: uncropped 8/8 3px,
  cropped 8/8 6px, refined 8/8 1px
  (`bench/results/vision-precision-calculator-2026-06-10T14-30-07.json`).
- `bench/probe-crop.ts` (new): crop geometry offline — native 460×816,
  visually verified.
- `bench/probe-step.ts` (new): bounded 2-step live run — grounds "7" at
  4–5px **through a floating occluder**, ~3.7s/step warm
  (capture 325ms + plan 2.0s + ground 1.2s + exec 115ms).
- `npm run typecheck` clean.

## Adversarial review round (same day)

A 14-agent review of the staged diff confirmed 9 findings; ALL are
fixed in the same changeset:

- **Stale `sf` after multi-monitor recapture** (regression introduced
  by the floor hoist) — `sf` now refreshed after `shot = newShot`.
- **`captureWindowDirect` accepted partially off-screen windows** —
  the Swift helper now also emits display bounds; off-screen windows
  fall back to the legacy path (helper recompiles automatically via
  the source-hash stamp).
- **Completion probe inherited verify()'s fail-open** — a transient
  provider error counted as "done" and would falsely advance a
  decompose plan. `verify()` grew `errorDefault`; the probe passes
  `false` (fail-closed), DONE-claim verification keeps fail-open.
- **Bridge mirror wrote wall-clock timestamps** — recorded pacing
  collapsed to the floor for bridge segments. `recordAction` accepts
  `atEpochMs`; the mirror rebases the transcript's real `t`.
- **Mirror ran for ponder_browser_ensure's auto-attach clicks** —
  toolbar-click machinery polluted recipes. Now gated (`mirrorTrace`,
  agent_do only), skips error outcomes and `_truncated` payloads.
- **healRef renumbering hazard** — one heal renumbers every `[eN]`;
  unlabeled later steps would silently act on wrong elements. Now:
  `healedOnce` set by the snapshot itself, unlabeled/unmatched steps
  FAIL-STOP after a heal, `browser_scroll_element` heals too.
- **healRef first-match ambiguity** — empty accessible names refused,
  matches must be UNIQUE (role+name) or healing declines.
- **Recorded pacing slept on think-time** — ceiling cut to 2s
  (8s after navigate/Spotlight/submit-type launches), `wait` steps no
  longer double-pay, stale "Default 400" tool docs corrected.
- **mcpRefMeta latch staleness** — browser_navigate's internal
  snapshot now refreshes the latch (it re-stamps refs on the new page).

Plus minors: scale-aware floor on the direct path (300px for 1x
sources), occluder warnings now reach the BRAIN's history (not just
the console), decompose plan call is cancellable + clamps to the
remaining MAX_STEPS_TOTAL, parsePlanArray tolerates brackets in prose
(6/6 unit cases), Screenshot interface docs rewritten (the old comment
asserted the exact falsehood that caused the bug), .env.example model
id updated, bridge timeout scales up for decomposed runs (≥600s).

## Round 2 (same day, post-MCP-restart): combined step + primitive crop

- **Combined plan+ground (`/step`)** — modal_app.py grew a `step()`
  method + endpoint: ONE grammar-constrained call returns
  `{"action", "x", "y"}` (coords null for keyboard verbs and drag).
  Validated against the live grounder: **4/4 targets agree within 8px**
  at ~1.2s warm for action+coords combined (vs ~2.5–3.5s for the
  sequential pair — each leg re-uploads the image and re-runs the
  vision tower). Client side: optional `provider.step` on
  ProviderClient (remote only), `think()` now returns
  `{action, coords}`, the loop skips the dedicated ground call when
  coords are pre-resolved. Gate: `PONDER_COMBINED_STEP` (default ON;
  "off" forces the split path). Defects fall back per-step: bare-verb
  actions (seen under grammar-constrained greedy decoding: `"click"`
  with no target) are caught BOTH server-side (few-shot examples + one
  corrective retry) and client-side (bare-verb guard → split plan), so
  the worst case is exactly the old behavior. NOTE: Modal keeps
  routing to the old warm container after a deploy until it scales
  down — `modal container stop <id>` to force the new code.
- **agent_click / agent_observe `targetApp` crop** — the "fast
  primitives" were grounding the full 1.6MB frame. New optional param
  crops to the app window first (`cropFrameToApp`: window-direct when
  the frame is locally captured, sips crop of the bridge frame
  otherwise, scale-aware floor, silent fallback). Same 6–20×
  image-token reduction the loop gets.
- **Refine-on-retry** — when the brain re-emits the SAME normalized
  action as the previous step (suspected misclick), the loop ignores
  combined coords and re-grounds with the coarse→fine refine pass
  (~1px) for the second attempt. `findCoordinates` accepts a per-call
  `{refine}` override.

## Round 2b: click-time occlusion (the last delivery gap)

Live 40-step run (47×8 on Calculator) exposed it: coordinates were
dead-on every step, but clicks registered only in BURSTS — Calculator's
display accumulated garbage ("8,788") from partial sequences. Isolated
click test registers fine. Diagnosis: **capture-time raising can't hold
Z-order through ~2s of model time** — another window (this user's chat
window covers Calculator's coords) comes back on top and the CGEvent
lands on it. Zero occluder warnings fire because at CAPTURE time the
raise had just succeeded.

Fixes (both deterministic, no model calls):
- **Pre-dispatch re-check**: `screen.frontWindowAtPoint(x,y)` (~80ms)
  right before the click; foreign window on top → re-raise → re-check →
  dispatch (with a loud log if a floating window still wins).
- **Click-delivery feedback**: previous action was a mouse click AND
  the screen hash is byte-identical → push
  `[note: the previous click changed NOTHING on screen…]` so the brain
  re-emits the action instead of plowing ahead (re-emission also
  triggers refine-on-retry). The retry detector now skips synthetic
  notes when walking history.

Also observed working as designed in the same run: client bare-verb
guard → split-plan fallback → refine retry (1px grounds); probe/plan
overlap (concurrent verifier + step calls); decompose degraded to flat
on a single-item plan (prompt could be better — it returned only the
first step; fallback contract held).

## Round 2c: SwiftUI click delivery + live decompose findings

Deterministic 5-button probe (no model) found the LAST mechanical bug:
**SwiftUI controls drop synthetic teleport-clicks**. Bare `cliclick
c:x,y` registered 2/5 on Calculator; `m:x,y w:200 c:x,y` (pointer-move
+ 200ms dwell + click) registered 5/5 twice. screen.click now always
pre-moves (env `PONDER_CLICK_DWELL_MS`, 0 = legacy parked-cursor
teleport). Note: the cursor physically moves now — correctness over
stillness.

Also landed: pre-dispatch delivery check (`screen.clickObstruction` —
point coverage AND active-app in one winlist exec; re-raise on either;
caught Figma stealing focus mid-run), click-no-change feedback note to
the brain, transient provider errors burn a step instead of killing the
run (3 consecutive = real outage), refine domain guard (refine declines
on already-zoomed sources — it mis-ground 4→1 on window crops while
scoring 1px on full frames), per-call completion-probe cadence
(decompose sub-steps probe at step 2/every 2).

**Live decompose milestone**: step 1 ran the full cycle — clicked 4,
brain emitted DONE, verifier confirmed, advanced to step 2. The
remaining gap is SEMANTIC: when a stray click corrupts state (display
"478"), the plan has no recovery and the verifier judges the OVERALL
math instead of the step's local goal, so the loop grinds. Next move
(top priority): decompose should emit `{step, expect}` pairs ("click
the 7" / "display shows 47"); verify each step against its OWN expect,
and on expect-mismatch insert a recovery step (clear + re-enter)
instead of retrying the same click. This is the NEXT-WORK "C pairing"
idea, generalized.

## Round 3: the slow-failing web-task trace (user's "game 3" run)

The user's live Electron run ("find who won game 3 of the finals")
failed in 3 steps / ~75s and exposed a DIFFERENT bottleneck class than
click delivery — wrong path selection + full-frame latency:

- Blank `about:blank` tab → the grounding-first brain hallucinated a
  "search icon"; router escalated wrongly; planner/narrator burned ~9s
  timing out against local Ollama.
- No targetApp → no crop → ~1.4MB native frames at 19-27s/model-call.
- Model-output defects ate the two-strike guard: leaked reasoning
  ending in an orphan `</think>`, and nested-JSON action strings
  filling the 384-token cap.
- The browser-stall detector fired after a NO-OP step and told the
  brain a native dialog was open (false).

Fixes (all landed; Modal redeployed + container bounced):
- **Web kickstart** (`PONDER_WEB_KICKSTART`, default on): step 0 +
  attached browser + blank tab + non-native task → deterministic
  `browser.navigate` to the URL in the task or a Google search FOR the
  task. Zero model time; the brain starts from real content.
- **Full-frame downscale** (`PONDER_FULLFRAME_DOWNSCALE`, default on):
  uncropped Retina frames resample to logical before upload. Measured:
  same ground 13.7s → **3.4s**; precision on tiny targets dips (Apple
  menu +20px on one sample) — acceptable because precision work runs
  in crops and refine-on-retry backstops the full-frame regime.
- **Modal**: `_strip_think` handles orphan trailing `</think>`; /step's
  corrective retry now also triggers on JSON-fragment actions and
  finish_reason=length; /plan and /step prompts list the `browser.*`
  verbs as valid when Chrome context is present (the model wanted to
  navigate and had no vocabulary for it).
- **Stall detector** requires the previous step to have actually
  executed something before claiming an OS dialog appeared.

NOTE: the running Electron app needs a restart to pick up the TS-side
changes (Modal side is already live).

## Round 3b: the crash — libnut native SIGBUS in screen capture

The user's post-restart runs died SILENTLY at step 1 (clean shell
prompt, no stack). macOS crash reports
(`~/Library/Logs/DiagnosticReports/Electron-2026-06-10-{143712,145058}.ips`)
show the smoking gun, identical in both:

    EXC_BAD_ACCESS (SIGBUS) — KERN_PROTECTION_FAILURE
    libsystem_platform.dylib  _platform_memmove
    libnut.node               copyMMBitmapFromDisplayInRect
    libnut.node               _captureScreen(Napi::CallbackInfo const&)

**nut-js's native screen capture bus-faults inside the Electron
process.** A native fault is uncatchable from JS; the whole agent dies
with no trace (electron-vite exits cleanly, so the shell shows
nothing). This is the "crashes every time I ask it to do something."

Fix: `screen.screenshot()` is now **screencapture-first** — the
`/usr/sbin/screencapture` binary runs OUT of process, so the worst
case is a catchable exec failure, never a crash. Native-Retina PNG,
scaleFactor measured from IHDR, logical size from the winlist helper
(cached 10s) → nut-js `size()` → 2x assumption. Measured ~280-320ms
warm (vs ~1100ms libnut!). nut-js capture remains only as the last
fallback, loudly labeled "in-process, crash-prone". The multi-monitor
desktopCapturer path (Electron API, not libnut) is unchanged.

When debugging future silent exits: check DiagnosticReports FIRST.

## Round 4: the "braindead" marketplace loop

The crash-free run exposed the next layer (user log, marketplace task):

1. **Context overflow killed the brain on content-heavy pages**:
   `request (8379 tokens) exceeds the available context size (8192)` —
   the per-slot ctx is 8192 and a 12.6KB AX snapshot
   (basketball-reference) + ~4k-token screenshot blew it; every
   plan/step call 500'd from then on. Fixed BOTH sides: brain.ts
   SNAPSHOT_LIMIT 20,000 → 8,000 chars, and modal_app gained
   `_shrink_for_ctx` — on an overflow 400, drop the `[CHROME ACTIVE…]`
   block and retry once.
2. **Router failure-loop**: the 0.8B router re-emitted
   `browser.type e7 …` EIGHT times; every attempt failed ("Element is
   not an <input>"), each failure SPA-bounced Facebook to a random reel
   (the "messing up Chrome"), and the brain never got a turn because
   the router runs first. Fixed: router circuit breaker — a suggestion
   whose normalized action already carries ≥2 `[note: failed…]` history
   entries is VETOED; the brain takes the step with the failure context
   as its hint.
3. **Router few-shot leakage**: it searched the public marketplace for
   "slow moving" in Marietta GA (its own example text) when the task
   was the user's OWN listings. Added a Facebook URL map to the brain's
   Chrome context: own listings = `facebook.com/marketplace/you/selling`,
   never public search.

Also worth noting from the same log: kickstart, downscale (19-27s →
~2-10s plan calls), router-driven browser path, and the
transient-error resilience all behaved as designed; run 1 actually
REACHED the basketball-reference box score with the answer before the
ctx overflow killed comprehension.

## Round 5: composite mode — smart hosted planner + Holo3 grounder

The architectural shift (user's call, and H Company's own published
Surfer-2 design): a frontier-class CHEAP hosted model plans each step;
Holo3 only grounds descriptions → coordinates. Every remaining failure
class in the live traces was a small model planning badly — none were
grounding.

Implementation (`src/agent/providers/planner.ts` + factory wrap):
- `createCompositeProvider(executor, cfg)` — `plan()` → any
  OpenAI-compatible endpoint (default Gemini 2.5 Flash-Lite via
  `GEMINI_API_KEY`; or `PLANNER_API_BASE`+`PLANNER_API_KEY`+
  `PLANNER_MODEL`); `ground()`/`groundBatch()` → the wrapped executor;
  `step()` deliberately absent so the loop takes the split path.
- Everything calling provider.plan upgrades free: brain, verifier,
  completion probe, decompose.
- Loop detects `name === "composite"` → bypasses the local Ollama
  router and hierarchical planner (live traces showed them actively
  harming runs) and runs the flat per-step loop.
- Self-healing: planner failure (rate limit / network / empty reply)
  falls back to the executor's own plan() for that step.
- Planner history capped at last 30 entries. Context note: the loop
  already "cycles context" — only the CURRENT screenshot is ever sent,
  and the Modal server slices history to the last 3; with a 1M-ctx
  planner the text history is pennies, so no model-summarization layer
  was added.
- Convex persistence + preferences only know the 3 executors —
  `executorNameFor()` maps composite to its underlying backend.

Validated: end-to-end smoke via Ollama as a stand-in OpenAI-compat
endpoint (composite constructed, planner planned a correct action,
split path forced, groundBatch forwarded). Live Gemini validation
needs the user to add `GEMINI_API_KEY` (aistudio.google.com/apikey)
to `.env` and restart the app.

## Round 6: first composite live run — promoting it to complex tasks

The user's first Gemini-planned run was the best trace yet: Spotlight →
Chrome → marketplace → self-corrected to `/you/selling` in 5 steps at
~1.6-2.4s planner calls. Two legacy crutches then betrayed it:

1. **Auto-DONE on navigate-to-current-URL** ended a 50-step
   "edit every listing" task at step 5 — OVERRIDING a completion probe
   that had just said RETRY. That heuristic existed because the weak
   brain couldn't say DONE; the planner can. In composite mode a
   redundant navigate is now skipped with a
   `[note: already at … continue with the NEXT part]` instead of
   ending the subtask. (Legacy providers keep the auto-DONE.)
2. **The extractor answered with 3 bytes** — it prefers local
   qwen3.5:0.8b. In composite mode the transport order flips:
   the hosted planner (multimodal — reads the final frame) writes the
   post-mortem; Ollama is the offline fallback.

Plus two composite-mode capabilities:
- **Meta-prompt passthrough**: verifier (VERIFIED/RETRY), decompose
  (JSON array), and extractor (post-mortem) prompts ride through
  provider.plan with their own output contracts — the planner now
  detects their markers and switches to a neutral system prompt +
  whole-text reply instead of forcing the one-action-line contract.
- **Decompose by default for UI tasks**: tasks arriving on the
  hierarchical path (Electron UI) auto-route through decompose() in
  composite mode (PONDER_DECOMPOSE=off still disables) — the hosted
  planner writes the plan, verify-to-advance owns sequencing.

## Round 7: local-first retired + dexterity sweep + long-task memory

Strategic shift (user's call): Gemini Flash-Lite + Holo3 ARE the stack;
local models are offline fallbacks only. In composite mode nothing
local remains on the hot path: router/hierarchical-planner bypassed,
extractor planner-first, verifier/probe/decompose on the planner, and
now the narrator's Ollama intro is skipped too (instant start).

**New action vocabulary** (planner prompt → brain validators → executor
→ screen primitives → recipe render/replay, end-to-end):
- `hover <target>` — pointer move without click (hover menus, tooltips,
  reveal-on-hover controls — previously UNREACHABLE)
- `scroll up|down at <target>` — grounded, aimed wheel (nested panes/
  sidebars — previously scrolled whatever was under the cursor)
- `cmd|shift|alt|ctrl click <target>` — modifier-held clicks
  (multi-select, range select, open-in-new-tab); cliclick kd:/ku: wrap
  + nut-js fallback
- `click precisely <target>` — planner-requested 1px refine grounding
  for tiny/dense targets
- `press KEY N times` — capped at 20, 120ms gaps; form-tabbing in one
  model call instead of N
- `note "text"` — the planner's WORKING MEMORY: a no-op action whose
  text persists in history verbatim. The planner prompt instructs
  per-item progress notes on long tasks ("edited 2 of 5: …; next: …")
  — durable multi-item state instead of re-deriving from lossy history.

**{step, expect} decompose**: plans are now
`[{"step": "click 7", "expect": "display shows 47"}, …]` (legacy
string arrays still parse). Each sub-step's task carries its OWN
expected outcome, so the verifier judges the step against its local
success condition — and the framing explicitly tells the brain to FIX
contradicting state (clear + re-enter) before re-attempting. This is
the {step,expect} upgrade specced in round 2c, closing the "verifier
judged 'click the 7' against 'shows 376'" failure.

Parser unit-tested (5/5: object form, legacy strings, empty expects,
wrong shapes, mixed arrays). Typecheck clean. Restart the Electron app
to pick it all up.

## Round 8: the scroll-loop trace — closing the no-feedback gaps

User trace ("scrolls over and over doesn't do anything"): on
facebook.com/marketplace/you/selling the listing list is a NESTED
scroll container — `browser.scroll page down` (window.scrollBy)
executed in 4-18ms with the DOM snapshot byte-frozen at 16617b for ~27
straight steps. The loop KNEW (snapshotUnchanged) and said nothing, so
the planner scrolled 15+ times, then looped the SAME note 6×, while
the stall detector sprayed false "NATIVE OS dialog!" hints on almost
every step (scrolls/notes armed it; lazy-load pixel noise triggered it).

Fixes:
- **Action-effect feedback**: prev action was a scroll and the DOM
  didn't change → `[note: that scroll changed NOTHING … use scroll
  down at <the list> or STOP scrolling and act]`. Same for a
  browser.click that changed nothing (non-interactive ref).
- **Stall detector** now requires the previous action to be a CLICK
  (only clicks can open native dialogs).
- **Duplicate-note suppression**: an identical note within the last 6
  history entries is not executed; the planner gets "a note is NOT
  progress — take a SCREEN ACTION now".
- **`[note: …]` bracket-form salvage** in the planner client (it ran
  to the token cap and parsed as invalid).
- **Prompt steering**: planner gains `browser.scroll e<N> down`
  (DOM-native nested-container scrolling) + anti-stall discipline
  (never repeat a note; stop scrolling after two no-ops; act on
  visible items before revealing more); the brain's CHROME-ACTIVE
  block now explains the nested-scroll-container escape hatch instead
  of unconditionally recommending page scroll.

## Round 9: the self-screen plan + the unkillable bad action

User trace: decompose screenshotted the AGENT'S OWN window (the
Electron app — its "Modal" provider button, "Sessions"/"Automations"
tabs) and planned to click them; the sub-step contract ("Do ONLY this
single step") then LOCKED the planner onto a button that doesn't exist
on the actual Facebook page; the verifier said exactly that 8 times,
and nothing had authority to change the plan. Meanwhile
`browser.click "Modal"` (a NAME instead of an e<N> ref) crashed the
Playwright locator with the same SyntaxError 9 times.

Fixes:
- **Plan revision (one-shot)**: a decompose step that ends `exhausted`
  twice OR `infeasible` triggers ONE re-decompose from the live screen
  with the failure as context, then restarts at the revised plan's
  first step. Bad plans now self-correct instead of aborting the task.
- **Ref validation**: `parseBrowserAction` rejects non-`e<N>` refs for
  click/type/scroll_element; the no-executor path emits a teaching
  note ("browser.click takes ONLY an e<N> ref … or use a vision
  click") instead of a cryptic selector SyntaxError.
- **Failed-action circuit breaker (brain-side)**: any action with ≥2
  `[note: failed …]` history entries is BANNED — not executed, not
  grounded — with a "do something STRUCTURALLY different" note. (The
  router already had its own breaker; this covers planner actions.)
- **Self-app awareness**: decompose and the planner system prompt now
  describe the agent's own control window and forbid interacting with
  it; if the task's target isn't on screen, step 1 must REACH it.

## Round 10: the goal outran the plan + the invisible controlled tab

User trace ("it didn't switch to the tab it was controlling and then
stalled out, yet that tab had the info"): the web kickstart loaded the
Google results — the ANSWER — at sub-step 2/6 of a launch-Chrome plan.
Three structural gaps then burned 30+ steps:

1. **Nothing checked the overall goal anymore.** In decompose mode the
   completion probe verified the current STEP ("type chrome"), so a
   plan made moot by reality could never end. Fixed: the probe now
   verifies the OVERALL GOAL whenever one exists; a verified goal
   returns the new internal `goal_done` outcome, which ends the WHOLE
   task from any sub-step (mapped to "done" before leaving runTask).
2. **The controlled tab wasn't the visible tab** — the relay's
   bringToFront can't reliably switch Chrome's visible tab, so
   screenshots showed playwriter.dev while the snapshot (and the
   answer) lived in the Google tab. The verifier judged browser state
   from unrelated pixels ("the page is about Playwright"). Fixed:
   `BrowserClient.isActive()` (visibilityState probe); when the
   controlled tab is hidden the planner gets a one-time note (browser.*
   still works; read without switching, or vision-click the tab strip)
   and EVERY verifier call gets `tabHidden` → "judge browser state ONLY
   from the URL/snapshot; the screenshot pixels are unrelated".
3. **cmd+space toggle loop** — pixels change on every press, so the
   "screen IS changing = progress" exemption never bailed. Fixed:
   futile-toggle ban — a keyboard-only action executed 4+ times in the
   recent window is banned with a "likely TOGGLING something" note
   (coordinate actions stay exempt; honest repetition has
   "press KEY N times").

Also observed working: verify-to-advance (step 1 hotkey → DONE →
VERIFIED → advance), the failed-action ban (browser.type refless form
banned after 2), and plan revision triggered exactly as designed —
its revised plan was still wrong because it, too, couldn't see that
the goal was already met, which is what fix 1 closes.

## Round 11: browser.read was write-only + modality arbitration

User: "can it not scrape all the data of the page using playwriter?
…it needs to tell the difference between stuff with vision as well as
text data whenever one isn't working for the other."

It COULD scrape — `browser.read` runs Playwriter's text extraction and
the full page text landed in the recorded trace payload — but the
history entry the planner sees was just the literal string
`browser.read`. The one tool that turns "find X on a page" into a
single step was a black hole from the planner's point of view: it
could never read the answer it had just scraped, so it kept clicking
and scrolling instead.

1. **browser.read content inlined into history** (loop.ts): when the
   executed action is `browser_read` with text, the history entry
   becomes `browser.read  [page content: …]` — whitespace-collapsed,
   capped at 3000 chars with a truncation marker. Same principle as
   every other Round-N fix: knowledge the harness has but the planner
   can't see is wasted on a stateless step loop.
2. **MODALITY ARBITRATION block** (planner.ts PLANNER_SYSTEM): explicit
   doctrine for the planner —
   - extraction tasks (read/find/copy/compare text) → `browser.read`
     FIRST, answer from `[page content: …]`; don't scroll-and-squint.
   - two modalities, two failure modes: `browser.*` works on the
     controlled tab even when HIDDEN but only inside that tab; vision
     (click/type/hotkey) works on anything VISIBLE but needs the
     target on the physical screen. If one modality fails twice on
     the same target, SWITCH — don't retry a third time.
   - disagreement rule: snapshot/page-content is truth for the
     controlled tab; the screenshot is truth for the physical screen.
     If they disagree, the controlled tab is probably hidden — act
     accordingly (read via browser.*, or vision-click the tab strip).

## Round 12: the Raycast trap — browser-first planning

User trace ("it keeps opening raycast, regressing in capability and
speed"): decompose planned `hotkey cmd+space → type facebook
marketplace → press enter` for a WEB task while Playwriter was already
connected to a Chrome tab — and on this machine cmd+space opens
RAYCAST, so the step's expect ("Spotlight search is open") could never
verify. The launcher toggled for 8 steps × 2 attempts; plan revision
then produced the SAME cmd+space plan; a second task burned 50 steps
the same way. Note: the `browser.click "Modal"` selector crashes in the
same log came from a mid-session build — current source already rejects
name-form refs (the final build shows the guard working).

Six fixes:

1. **Browser-aware decompose** (decompose.ts, loop.ts): the plan call
   now receives live relay state (`DecomposeBrowserContext`, probed via
   browser.available()+snapshot()). Connected → every web step MUST be
   browser.*; launcher/app-opening steps are forbidden; web INFORMATION
   LOOKUPS return a single-element plan (→ oneShot → the flat loop's
   kickstart + browser.read solve them directly). Not connected → plan
   `open app "Name"`, launcher only as fallback.
2. **`open app "Name"` primitive** (loop.ts executeAction →
   screen.raiseMacApp, brain.ts validators, planner vocab, recorder
   renderStep, sdk ScreenHandle.openApp + replay): deterministic
   launch/foreground via AppleScript activate — one step, no launcher,
   no Spotlight-vs-Raycast roulette. Gets the same 2.5s post-launch
   settle as the cmd+space sequence.
3. **Launcher brand-agnosticism**: planner prompt notes cmd+space may
   open Spotlight OR Raycast; decompose expects must describe OUTCOMES
   ("an app launcher overlay with a search field is open"), never
   brands; verifier gained an EQUIVALENCE RULE (judge the function,
   not the brand, for launcher overlays).
4. **Plan revision with failure evidence** (loop.ts): [note: failed/
   BANNED/skipped] lines from failed sub-steps are harvested and
   injected into the revision prompt with "take a STRUCTURALLY
   DIFFERENT route — do NOT include the failed step or near-variants";
   revision also re-probes browser state.
5. **Consecutive-ban early bail** (loop.ts runOneSubtask): when a
   decomposed step's PRESCRIBED action is itself banned, the planner
   has no move — 3 consecutive ban-skips now return "exhausted"
   immediately (was: note-spam through the whole budget, twice).
6. **Tab-hidden blind spot closed** (loop.ts): document.visibilityState
   stays "visible" when Chrome's WINDOW is covered by another app, so
   the verifier judged web goals from unrelated editor pixels. When
   isActive() claims visible, we now cross-check the frontmost layer-0
   window via the Swift winlist helper — non-browser frontmost app →
   controlledTabHidden=true (verifier judges by URL/snapshot only).

Also: planner vocab now states browser.type's e<N> ref is REQUIRED
(rejected without it; use plain `type` for OS fields), and the
[CHROME ACTIVE] rule says web goals NEVER need cmd+space/launching
Chrome — browser.navigate directly.

**Round 12b (first live run after 12):** the plan WAS browser-first
(`browser.navigate /marketplace` step 1) — but the controlled tab was
ALREADY at that URL, and Round 6's "no auto-DONE on redundant navigate
in composite" met the decompose step contract head-on: the navigate
no-ops forever, the skip-note says "continue with the NEXT part" while
the contract says "do ONLY this single step" — 16 redundant navigates
across two budgets. Fixed: the FIRST redundant navigate per URL per
subtask is treated as a claimed DONE and the VERIFIER arbitrates
against the current task (step contract + expect → VERIFIED → advance;
flat-mode whole-goal check → RETRY → note path, preserving the Round 6
protection). The note now also explicitly licenses DONE when the
current step was exactly that navigate. Plus: decompose's
browser-connected block now demands the MOST SPECIFIC URL (the live
plan went to the /marketplace homepage and budgeted 3 click-steps to
reach /marketplace/you/selling, which is directly navigable).

## Round 13: validate BOTH horizons (look → guess → validate → resteer)

User trace + framing ("it can't tell when something went too well or
too bad… same as our anorha match pipeline: look, guess, validate,
resteer"): three validate-layer gaps, all visible in one run.

1. **The step-level validate had silently disappeared.** Round 10 made
   the completion probe verify the OVERALL goal whenever one exists —
   which fixed goal-overshoot but removed the only proactive check of
   the CURRENT STEP's expect. Live: sub-step "click 'Your Items'" was
   sitting ON /marketplace/you/selling (its expect satisfied as a side
   effect of a "failed" click) for 6 more steps, re-clicking a link to
   the page it was already on, while the only probe in flight asked
   about slow-moving listings. Fixed: **two-tier probe** — goal tier
   and step tier run CONCURRENTLY (Promise.all, same frozen
   screenshot). Goal verified → goal_done ends everything; else step
   verified → "done" advances the plan; else continue. First fire is
   internal step 2 (minStep 2, every 2), so a landed step advances at
   most ~1 step late. hcompany stays goal-only (rate limits).
2. **The verifier judged pixels it was told to ignore.** With the
   controlled tab hidden, verify() passed tabHidden and the prompt said
   "judge ONLY from URL/snapshot" — and the model answered "the URL
   matches the goal, HOWEVER the screenshot shows a file explorer" →
   RETRY. Telling a model to ignore an image it can see does not work.
   Fixed: composite-mode verification with tabHidden now WITHHOLDS the
   screenshot entirely (planner.plan sends text-only content when
   screenshotB64 is empty) and the prompt says why. Modal /plan keeps
   the image + instruction (the endpoint requires one).
3. **The browser-stall hint asserted a false story.** "A NATIVE OS
   dialog opened" fired after no-op clicks on pages whose pixels move
   by themselves (lazy thumbnails) — three times in one run. Reworded
   as a conditional: check the screenshot; (a) dialog visible → drive
   it with vision; (b) no dialog → the click had no effect, do
   something different or emit DONE if the step already landed.

## Round 14: the act-layer — echo trap, dead-ref escape, starved snapshots

The Round 12/13 fixes carried the run TO the right page in 4 steps
(browser-first throughout, /you/selling directly, early-bail at step
15 with a correct postmortem). What failed was acting ON the page:

1. **Echo trap**: the planner emitted the harness's own skip-note back
   VERBATIM as `note "already at …/you/selling — the navigate was
   skipped…"` — 3 wasted steps. Fixed both sides: loop-side echo
   suppression (a note action whose first 60 chars appear inside any
   recent [note: …] history entry is suppressed with a pointed nudge)
   + planner rule ("[note: …] entries are SYSTEM observations addressed
   to YOU — never repeat/quote/paraphrase one as your action").
2. **Dead-ref dead-end → mechanical modality swap**: browser.click e20
   executed cleanly 5× while the DOM stayed byte-identical (menu
   toggling or portal-rendered content the AX walker can't see). The
   MODALITY ARBITRATION prompt said "switch to vision" — the planner
   re-emitted e20 through the ban 3 more times instead. Now the harness
   performs the switch itself: `trySwapBannedClick()` looks up the
   ref's snapshot line (`[e20] button "More options"`), rewrites the
   action to `click button "More options"`, and lets the normal vision
   grounding path execute it. One swap per ref per subtask. Trigger
   ladder: 2 clean-execute-no-DOM-effect clicks on a ref (new per-ref
   `noEffectClickRefs` counter — review caught that such clicks never
   write [note: failed], so the 2-failure ban couldn't see them) OR 2
   exec failures OR the 4-repeat futile ban.
3. **Snapshot caps were Modal-sized for a Gemini planner**: 8,000-char
   cap (set for llama.cpp's 8192 ctx) truncated the /you/selling
   snapshot whose tail held the per-listing controls. Caps are now
   provider-aware: composite planner 24KB (brain) / 20KB (verifier),
   Modal paths keep 8KB. With tabHidden the snapshot is the verifier's
   ONLY evidence, so truncation there was double-poison.

Also: TASK_PRIORITY preamble now prefers `open app "Name"` over the
cmd+space sequence (the last stale launcher advice in a prompt).

## Round 15: thrash guards + the per-item iteration engine

Best run yet reached /you/selling browser-first and a step-6
browser.read returned the ENTIRE answer (every listing + "0 clicks" +
direct edit URLs). Then it thrashed. User: "had to manually swap to
Chrome and it took forever to recognize, then it kept struggling with
scrolling." Six fixes — the first five are thrash guards, the sixth is
the structural one the review forced.

1. **Active Chrome-raise** (loop.ts): when the frontmost window is a
   non-browser app, the harness now RAISES the browser itself (once per
   hidden episode) and re-screenshots, instead of just noting it — so
   the user no longer has to swap manually and vision actions ground
   against the real tab. Success confirmed via the frontmost-window
   re-check (NOT isActive(), which has the covered-window blind spot).
2. **Scroll circuit breaker** (loop.ts): 2 consecutive scrolls that
   move neither DOM nor pixels → scrolling BANNED for the subtask;
   further scrolls intercepted before paying the 3–7s grounding cost,
   redirected to browser.read + act. (Live: 14 fruitless scrolls.)
3. **Redundant-navigate escalation** (loop.ts): the soft "continue"
   note didn't stop 5 re-navigates to the current URL; after 2 it now
   hard-escalates to "STOP, OPEN a specific item via its URL/ref."
4. **Duplicate-read suppression** (loop.ts): re-reading a page whose
   text is already in history is intercepted (lastReadContent) with a
   nudge to act on what was read. (Live: browser.read ×3 identical.)
5. **Provider-aware caps** were already Round 14; here the snapshot at
   /you/selling (8.3KB) fit fully under the 24KB composite cap.

6. **The per-item iteration engine** (the review's CRITICAL finding):
   Round 15's first decompose draft told the planner "plan ONE item,
   the loop repeats them" — but NO such loop exists. The composite
   decompose loop runs its steps ONCE and returns "done", so a "change
   EACH description" task would edit one listing and FALSELY report
   success. Fixed by routing it to the engine that DOES iterate:
   - decompose.ts: MULTI-ITEM ACTION tasks (do X to each/all) now
     return a SINGLE element → run FLAT, where the planner's
     working-memory notes drive item-by-item iteration across the
     50-step budget. SINGLE-TARGET actions still decompose; pure
     lookups still collapse.
   - planner.ts: new "WORKING THROUGH A LIST" block — read the list
     ONCE (the [page content:] IS the worklist, often with direct edit
     URLs), then for each item OPEN it (prefer its own URL) → change →
     SAVE → note "done N of M" → next; DONE only when notes show ALL
     handled. All the thrash guards now point at this same concrete
     next move ("OPEN a specific item"), so they speak one voice.

## Round 16: headless planner-decision bench + first-shot efficiency

Every recent failure was a PLANNER DECISION in a given state (echo a
note, re-navigate to the current URL, re-read an already-read page,
scroll a nested list, edit one item and stop). Those decisions go
through `think()` → composite `provider.plan()`, which runs HEADLESS —
no live screen. Built `bench/planner-decisions.ts` (npm run
bench:decisions): replays each trace's exact (task, history, snapshot)
through the real planner and asserts the right ACTION CLASS. This is
the first harness that tests the loop's BRAIN without the user's
machine, and a permanent regression gate across all round-N fixes.

The bench is also a tuning loop. The runtime guards CATCH a wrong call
(redundant-nav skip, dup-read suppression) but each costs a step — on
the live trace, 8 wasted steps before real work. Goal: make the
planner decide right FIRST-SHOT. Iterating prompt + guards through the
bench:
- Prompt: "DON'T RE-GATHER WHAT YOU HAVE" rule (page-content-in-history
  ⇒ open an item, never re-read; snapshot-URL-matches ⇒ don't
  re-navigate); note redefined as COMPLETED-progress-only, never
  narration ("the task is…/I will…" ⇒ do the action instead);
  WORKING-THROUGH-A-LIST made history-aware (skip step-1 read if
  already read).
- Runtime guards made page-aware & single-instruction (a weak planner
  freezes on a fork): redundant-nav escalation picks read-vs-open from
  `lastReadContent`; echo-suppression and the NEW consecutive-note
  (narration) guard likewise. The narration guard catches the 2nd
  distinct note duplicate-suppression misses (each narration is fresh
  prose).
Result: 10 decision cases, 9 deterministic at 100%, the 1 genuinely
hard one (narrate-vs-act, flash-lite's weakest) at ~0.5 first-shot and
fully backstopped to ~100% over 2-3 steps. Honest thresholds +
per-case sampling keep the gate stable, not flappy.

Also confirmed headless: decompose now routes multi-item ACTION tasks
to FLAT (oneShot) — the review's "edit one item, falsely report done"
regression is closed.

LIMIT: the actual end-to-end run (vision + clicking the user's real
Chrome) needs the user's screen and a Playwriter-connected tab — it
can't be driven headless. The decision bench is the autonomous proxy;
live validation is the user's `pnpm dev` + re-run.

## Round 17: headless INTEGRATION test → caught a long-horizon bug

"Can you run it yourself?" — yes, headless. `runTask` takes `browser`
as an injectable dep; only `screen` is hardwired, and it can be stubbed
via a require hook (blank screenshots, no-op mouse). So
`bench/integration-flat-edit.ts` (npm run bench:integration) drives the
REAL loop — decompose, guards, composite planner, working-memory
iteration — against a FAKE BrowserClient modelling a 3-listing FB
selling page as a state machine, and checks the SEQUENCE the decision
bench can't: does "change the description on EACH listing" actually
iterate all items?

First runs: 3/3 sometimes, 0/3 others. The failing traces exposed a
REAL long-horizon bug no live trace had reached (they never got past
item 1): on the 2nd+ item's edit page the planner clicked Save (the
ref it "learned" from item 1's history) WITHOUT first typing the new
description — conflating steps across items. Item 1 only worked because
it happened to do `browser.type … and press enter` (fill+submit in one
action).

Fix (planner.ts, both live-relevant):
- "TO FILL A FORM FIELD, use browser.type <its eN> DIRECTLY — don't
  click it first, don't vision-click it" (the 0/3 runs strayed to a
  vision click that then mis-fired).
- WORKING-THROUGH-A-LIST step 3 rewritten: make the change AND submit
  in ONE action (`browser.type <field> "…" and press enter`); typing is
  REQUIRED before any Save; "you start fresh on every item — having
  typed a PREVIOUS item does not mean this one is done."

Result: ~2/3-variable → 10/10 runs at 3/3, clean DONE in ~8s (was
~42s/exhausted). The integration test is now a permanent gate that
exercises the full per-item iteration without the user's screen.

NOTE on what's still test-vs-real: blank stub screenshots break the
vision /ground path and keep the verifier from confirming via pixels —
so the test specifically validates the browser.*-only (DOM) path, which
is the right path for this task class anyway. Live, real screenshots
restore vision + verifier confirmation.

## Round 18: the real FB-menu structure — reproduced & fixed headless

Live trace ("still shit"): on the REAL selling page the planner got
stuck clicking "More options" via VISION (4–7s per ground × 7) and
edited NOTHING — sold listings have no direct edit URL, you must click
the "…" menu → "Edit listing". The flat-edit fixture (direct URLs only)
was too simple to catch this. New `bench/integration-fb-menu.ts`
(npm run bench:menu) models it faithfully (2 sold→menu, 2 drafts→URL)
and reproduced 0/4.

Six fixes (prompt + two guards), all from the headless repro:
1. ref-not-vision (prompt): use browser.click <eN> from the snapshot,
   NOT a slow vision "click <desc>" — vision is the last-resort fallback.
2. menu navigation (prompt): a "More options"/"…" click opens a MENU;
   next click the "Edit listing" MENUITEM — do NOT re-click More options
   (that just closes it). Killed the toggle loop.
3. URL-first opening (prompt): prefer browser.navigate to a direct
   edit/Continue URL from the read text over clicking through.
4. enumerate-all (prompt): count M = EVERY item in the read (incl. sold
   / menu-only) — the planner was dropping the harder items and
   declaring "done 2 of 2."
5. SAVE-BEFORE-TYPE guard (loop.ts): the planner reached an edit form
   and clicked Save without typing (saving an unchanged form = no-op →
   thrash). Block a Save click on an edit form when no type happened
   this visit. NARROWED after the review workflow caught 4 real
   false-positives: scoped to actual edit forms (URL "/edit" or title
   "Edit"), strict save verb (save/publish/"post changes" — NOT
   apply/done/update/submit, which are filter/search verbs), capped at
   2 blocks/subtask. Unit-tested vs the FB "Apply" location-filter flow,
   post-search redirects, "Apply for a loan", "Done".
6. FABRICATED-DONE guard (loop.ts): flash-lite writes FICTIONAL progress
   ("done 4 of 4: all processed") and emits DONE having edited nothing.
   Reject DONE once when the goal is multi-item (each/every/all) AND has
   an edit verb AND zero edits were actually committed. Counts BOTH
   browser.type and vision screen.type (review caught the vision-only
   omission).

Result: 0/4 → consistent 2–3/4 on the HARD realistic-read headless test
(some runs now edit a sold item via the menu). Existing gates
unregressed (flat-edit 3/3, decisions 10/10).

HONEST limits surfaced by the repro: flash-lite (a) FABRICATES progress
notes, (b) under-counts the worklist, (c) strays to vision. Prompt
tuning has hit the weak-planner ceiling; the headless fixture is a
PESSIMISTIC blind proxy (no vision, blind verifier) so live should do
better, and it's too noisy to gate CI on (kept as a repro tool). The
biggest remaining lever is a STRONGER PLANNER for complex tasks
(PLANNER_MODEL=gemini-2.5-flash) — A/B was inconclusive headless
because blind conditions handicap every model equally; worth a live
A/B.

## Round 19: THE root cause — controlled tab ≠ visible tab (title match)

gemini-2.5-flash run finally exposed what was under everything. The
verifier said it ~15× and the planner re-navigated 17×: the SCREENSHOT
showed the user's OWN "Owner dashboard" at `mbg-web-inira.vercel.app/
admin` — NOT Facebook. But `browser.read` returned EVERY FB listing +
edit URLs. So the controlled FB tab was a BACKGROUND tab while the
visible Chrome window showed an unrelated app tab. browser.* operated
on FB (correct); the screenshot/verifier/planner all saw vercel →
verifier looped "not Facebook Marketplace", planner re-navigated to a
page it was already on, nothing got edited.

Why every prior tab-hidden guard missed it:
- visibilityState reported "visible" (the FB tab IS the active tab in
  ITS window — the blind spot).
- The Round-12 "is a browser the frontmost window?" check passed (the
  frontmost window WAS Chrome — the vercel one).
- Round-15's active-raise then CLEARED controlledTabHidden on "a browser
  is frontmost", so the verifier got the wrong screenshot with no
  withholding. The raise made it worse.

Fix — detect by TITLE, recover by tab-switch:
- The frontmost browser window's title (= the VISIBLE tab) is compared
  to the controlled tab's title (browserSnapshot.title), truncation-
  tolerant. If they don't agree → the controlled tab is NOT visible →
  controlledTabHidden = true. Conservative: can't-confirm ⇒ hidden
  (browser.* still works, so erring hidden is safe).
- ACTIVE RECOVERY now calls browser.bringToFront() (NEW BrowserClient
  method — page.bringToFront() activates the controlled tab AND raises
  its window, fixing the foreign-tab/foreign-window case) plus
  raiseMacApp for a covering app, then re-confirms by title.
- When still hidden, a STRONG note: "IGNORE THE SCREENSHOT — it's a
  DIFFERENT tab. You ARE on <url>. Don't navigate there again. Work
  ENTIRELY via browser.* (read / open via edit URL or [eN] ref or
  More-options→Edit menuitem / type)." And the Round-13 verifier
  screenshot-withholding now actually fires (detection no longer
  wrongly clears the flag), so the verifier judges by URL+snapshot.

Validated: title logic unit-tested (vercel-vs-FB→hidden, real-visible→
not, truncation→ok); flat-edit 3/3 even in forced hidden-mode (proves
browser.*-only multi-item editing works with the tab hidden — the
COMMON live case); menu fixture back to 2–3/4 once its stub reports a
matching window title. Decision bench is think()-only (unaffected);
its 8/10 is flash-vs-flash-lite threshold noise, not a regression.

## Round 20: reason over the scrape (native) + the flash trade-off

Round-19 tab fix WORKED live ("recovery succeeded — controlled tab is
now frontmost"). The next gap (user's insight): browser.read scrapes
the WHOLE page in one shot — every item's status / date / click-count —
but the planner didn't REASON over that data to identify the slow
movers; it clicked "View listing" (a dead-end PUBLIC item page,
/marketplace/item/…) and navigate-looped. "I'd rather it discover how
to do this natively."

Two minimal, safe prompt additions:
- CRITERION FILTERING: when the task filters by a criterion
  (slow-moving / unsold / older-than / low-engagement), derive the
  signal from the scraped per-item attributes and act on the qualifying
  items — no hardcoded FB signal. Validated: a new decision-bench case
  (reason-over-scrape) where the planner must NOT re-read / re-navigate
  / click "View listing" — flash produces a correct slow-mover
  worklist 12/12.
- "VIEW LISTING IS A DEAD END": don't open the public item page; use
  the Edit path (edit URL / More-options→"Edit listing"). This pushed
  the menu fixture UP — it now edits SOLD items via the menu (2–3/4,
  was 0–2/4).

AVOIDED OVERFITTING: a first draft made the planner WRITE a worklist
note and "skip Sold" hard — that backfired (premature "done 0 of N"
notes, INFEASIBLE on all-sold pages, regressions on the simple cases).
Reverted to "reason in head, then OPEN"; kept only the two minimal
lines above.

THE FLASH TRADE-OFF (user set PLANNER_MODEL=gemini-2.5-flash):
- flash REASONS better — it named the tab bug ("Owner dashboard, not
  FB") and derives slow-movers from data. This is why the user
  switched, and it's the right call for "discover natively".
- flash is LESS action-decisive than flash-lite on trivial cases: it
  notes instead of acting after a nudge, and is slower to emit DONE on
  a pure lookup. Decision bench is 8/11 under flash vs 10/10 under
  flash-lite — and the 3 failing cases (dupread / echo / lookup) fail
  IDENTICALLY on the clean Round-19 prompt, so it's the MODEL, not the
  prompt. All three are runtime-backstopped (consecutive-note +
  dup-read guards, verifier re-check) so the live loop still converges,
  just a step or two slower at those junctures.
- Net for the user's edit-each task: flash + the Round-18/19/20 fixes
  gets the menu fixture to 2–3/4 (editing sold-via-menu), flat-edit
  3/3. Keep flash for the reasoning; the decision-bench thresholds were
  tuned for flash-lite and read ~8/11 under flash (a known offset, not
  a regression).

ENV REMINDER: the controlled Chrome tab keeps getting buried behind the
user's other work (the vercel-admin trap). The harness now compensates,
but a DEDICATED Chrome window / leaving the FB tab frontmost makes
vision + verifier work directly and is much faster.

## MCP restart matrix (answering "who needs the kill?")

The agent loop runs in ELECTRON, not the MCP server: `agent_do` is
forwarded from the MCP over the :7900 bridge into Electron
(electron/main.ts imports runTask directly). So:
- Changed `src/agent/**` or a prompt → restart `pnpm dev` ONLY. The MCP
  is untouched; Claude Code keeps running. (This covers ~all of rounds
  11-17.)
- Changed `src/mcp/**` → then restart the MCP (scoped kill script +
  Claude Code restart).
`scripts/kill-stale-mcp.sh` is now SCOPED (lsof cwd check) so it only
ever kills this repo's MCP server, never another session's.

## Still open / next

1. **MCP child is stale** — restart Claude Code (or
   `bash scripts/kill-stale-mcp.sh`) so the long-lived tsx server picks
   up these changes; verify with `holo3_version`.
2. Validate decompose live: `PONDER_DECOMPOSE=on` + one
   `calculator-mouse-math` run with `multistep`/`decompose:true`
   (expect a 5-step plan, verified advances, DONE with 376 shown).
3. Click-through occlusion: grounding is occluder-proof but clicks
   aren't — consider auto-moving the occluder or click-time re-check
   when `occluders.length > 0`.
4. The 0-1000-heuristic (`rx <= 1000` treated as normalized) can
   misread legit pixel answers on small crops — worth a contract field
   from the server instead of a heuristic.
5. Surfer-2-style split (strong planner emits element descriptions,
   Holo grounds only) — H's own ablations say the grounder choice is
   worth ~5 pts; our plan calls could move to a stronger model while
   keeping Holo3 for grounding.
