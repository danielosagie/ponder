import { createHash } from "node:crypto";
import {
  think,
  needsCoordinates,
  isDone,
  isInfeasible,
  infeasibleReason,
  isValidAction,
  parseDragAction,
  parseBrowserAction,
} from "./brain";
import {
  decompose,
  decomposeEnabled,
  type DecomposeBrowserContext,
} from "./decompose";
import { findCoordinates } from "./eyes";
import { cropAndScalePng, pngDimensions } from "./imageops";
import { createOllamaPlanner } from "./planner";
import { canonicalizeUrl, type RouterClient } from "./router";
import type { AgentEvents, ProviderClient } from "./types";
import type { BrowserClient, BrowserSnapshot } from "./browser/types";
import { verify, verifyInfeasible, verifierEnabled } from "./verifier";

/** Terminal outcomes of a task / subtask run. `infeasible` is a
 *  CORRECT answer for trap tasks (the goal genuinely can't be done),
 *  distinct from `exhausted` (ran out of steps) and `cancelled`
 *  (stopped mid-flight). Kept as a string union to match the existing
 *  call-site style — every `=== "exhausted"` branch was audited when
 *  this was added. */
type TaskOutcome = "done" | "cancelled" | "exhausted" | "infeasible";
// Internal-only extension: "goal_done" = the OVERALL goal verified mid-
// subtask (the world advanced past the plan — e.g. the web kickstart did
// five steps' work in one navigate). Distinct from "done" (= this STEP
// finished) so the decompose loop can end the WHOLE task instead of
// advancing to now-moot steps. Never escapes runTask: mapped to "done".
type SubtaskOutcome = TaskOutcome | "goal_done";
import * as screen from "../screen";

// Per-subtask cap. With hierarchical planning the inner loop only needs to
// carry ONE focused phase to completion ("open Chrome", "search Google for
// X"), so ~20 steps is plenty for a normal sub-goal — long enough to handle
// autocomplete dropdowns, retry a click that needed a prerequisite, etc.
// Override with HOLO3_MAX_STEPS_SUBTASK.
const MAX_STEPS_PER_SUBTASK = Number(
  process.env.HOLO3_MAX_STEPS_SUBTASK ?? 20,
);
// Hard ceiling across all subtasks combined. Even with a 6-subtask plan we
// never want more than this total. Override with HOLO3_MAX_STEPS_TOTAL.
const MAX_STEPS_TOTAL = Number(process.env.HOLO3_MAX_STEPS_TOTAL ?? 90);
// Cap for non-hierarchical (planner unavailable / single-subtask) runs —
// the most common path right now. Bumped from 30 → 50 because Marketplace
// flows easily need 20+ steps just for the location-pick dance, and 30 was
// running out before reaching the third listing on multi-result tasks.
// Override with HOLO3_MAX_STEPS.
const MAX_STEPS = Number(process.env.HOLO3_MAX_STEPS ?? 50);
// Default inter-step pause. The hosted H Company API has a 10 RPM default-tier
// limit; with plan + ground per step we issue ~2 reqs/step, so 6.5s keeps us
// safely under (≈9 RPM steady-state). Modal/local don't rate-limit so we use
// a much smaller pause.
// Inter-step pause for the non-rate-limited providers (Modal/local).
// Was 1200ms — sized for an era when steps took 20-30s and the pause
// was noise. With native-res crops a step is ~2-4s, so 1200ms became
// 30-50% overhead. UI settle is already handled separately (settleMs:
// 250ms base, 1400ms post-type, 2500ms post-Spotlight-launch); this
// pause is purely an inter-step breather. Override per-call via
// opts.stepPause or globally via PONDER_STEP_PAUSE_MS.
const STEP_PAUSE_MS_DEFAULT = Number(
  process.env.PONDER_STEP_PAUSE_MS ?? 400,
);
const STEP_PAUSE_MS_HCOMPANY = 6500;
// How long to let the OS settle (focus changes, animations, page repaints)
// after our action lands before we kick off the prefetch screenshot. Too short
// and the prefetched frame still shows the pre-action UI; too long and we
// shrink the parallel-with-pause window. 250ms matches POST_MOVE_HOVER_MS+
// nut-js autoDelayMs in screen.ts and is enough for menu pops / focus rings.
const PREFETCH_SETTLE_MS = 250;
// Extra settle for actions that fire async UI: typing into a search /
// combobox / location field triggers an autocomplete dropdown that arrives
// from the network ~600–1200ms later (Facebook Marketplace location filter,
// Google search-as-you-type, Amazon search). Without this, the next
// snapshot is taken while the dropdown is still empty, the planner clicks
// the disabled Apply button, and Playwright burns 5s on the locator
// timeout. We pay the wait once on the typing step and recoup it many
// times over by avoiding a wrong-action retry loop.
const POST_TYPE_SETTLE_MS = 1400;
// Spotlight launch sequence: cmd+space (step N) → type+enter (step N+1)
// to open an app via Spotlight. The launched app's window can take 2-3s
// to draw (Excel ~3s, most native apps ~1s). Without extra settle, the
// next screenshot still shows the PREVIOUS frontmost app, and the brain
// interprets that as a failed launch. Observed in
// t4-honda-crv-spreadsheet-research Run 3 (brain abandoned the launch
// and started clicking in Chrome) and Run 4 (brain emitted cmd+tab × 7
// trying to "find" Excel that hadn't drawn yet, bailed by same-action
// guard). 2500ms covers Excel reliably; only fires once per launch.
// Override with HOLO3_SPOTLIGHT_LAUNCH_SETTLE_MS.
const SPOTLIGHT_LAUNCH_SETTLE_MS = Number(
  process.env.HOLO3_SPOTLIGHT_LAUNCH_SETTLE_MS ?? 2500,
);

// Proactive completion probe.
//
// Holo3 is a grounding-first model: handed a multi-step task in flat
// mode (no planner) it executes atomic clicks accurately but has NO
// notion of "the goal is now met — stop". It simply never emits DONE,
// so the existing Ralph verifier (which only fires ON a DONE claim)
// never engages, and the loop grinds to maxSteps / errors out. Seen
// 2026-05-18 on calculator-mouse-math: perfect grounding of 4,7,×,8
// then an endless 8,=,8,= oscillation, never terminating.
//
// Fix: every N steps, run the SAME skeptical verifier proactively —
// "is the original goal already satisfied on screen?" The verifier
// defaults to RETRY and only says VERIFIED with concrete proof, so
// probing mid-task when NOT done is safe (costs one call, returns
// RETRY, loop continues). When the goal IS done but the brain didn't
// notice, the probe terminates the run instead of looping to 50.
//
// Cost profile: healthy short runs finish (or the brain emits DONE)
// before step PROBE_MIN, so the probe never fires — ~zero overhead on
// the common path. On the failure mode it targets, it converts "loop
// to exhaustion" into "stop when actually done" — a net time SAVING.
// Disable with PONDER_COMPLETION_PROBE=off.
const COMPLETION_PROBE_ENABLED =
  process.env.PONDER_COMPLETION_PROBE !== "off";
const COMPLETION_PROBE_EVERY = Math.max(
  2,
  Number(process.env.PONDER_COMPLETION_PROBE_EVERY ?? 4),
);
const COMPLETION_PROBE_MIN_STEP = Math.max(
  2,
  Number(process.env.PONDER_COMPLETION_PROBE_MIN ?? 4),
);

export interface RunOptions {
  task: string;
  provider: ProviderClient;
  events: AgentEvents;
  shouldCancel?: () => boolean;
  /**
   * Optional Chrome control via an agent-managed Chrome instance launched
   * automatically by playwright-core. When present AND `available()`
   * returns true (Chrome was launchable), the loop will:
   *   1. Pull an accessibility snapshot at the start of each step and
   *      include it in the planner prompt so the model can pick browser.*
   *      actions instead of guessing pixel coordinates.
   *   2. Route browser.click/type/scroll/read through this client instead
   *      of nut-js cursor automation.
   * When the client is null or unavailable (Chrome not installed, launch
   * failed, etc.), the loop runs the legacy vision-only flow with zero
   * behavioral change.
   */
  browser?: BrowserClient | null;
  /**
   * Optional CLI fast-path. When provided AND a browser snapshot is
   * captured this step, the router runs FIRST — a small local Ollama
   * model that picks browser.* actions directly from the snapshot in
   * ~500ms. If it succeeds, we execute and skip plan/ground entirely
   * (saving ~10s on hcompany). If the router escalates, the loop falls
   * through to Holo3 with the router's reason spliced into the prompt.
   * Null → vision path runs every step, identical to pre-router behavior.
   */
  router?: RouterClient | null;
  /**
   * Called whenever the loop captures a fresh accessibility snapshot. The
   * orchestrator (electron/main.ts) latches the most recent value and
   * passes it to the extractor at end-of-run so the report-back step can
   * read structured DOM text instead of just the final screenshot pixels.
   * Optional — null when no caller cares about snapshots.
   */
  onBrowserSnapshot?: (snap: BrowserSnapshot) => void;
  /**
   * Called every time the loop appends to its action history. Used by the
   * orchestrator to retain the per-action transcript for the extractor
   * (the existing `events.onAction` carries the executed shape, not the
   * raw action string the planner emitted, so we surface that separately).
   */
  onHistory?: (action: string) => void;
  /**
   * Called whenever a new screenshot is captured. The orchestrator caches
   * the latest PNG bytes so the extractor has a "final frame" to send to
   * the model when no Chrome snapshot is available.
   */
  onScreenshotBuffer?: (png: Buffer) => void;
  /**
   * Skip hierarchical planning entirely. agent_do passes this because its
   * contract is "ONE atomic OS-level mouse step" — running the Ollama
   * planner on a one-step task produces wrong subtasks ("Open Chrome"
   * when Chrome is already open, "Navigate to file picker" when the
   * picker is already visible) that the brain can't reconcile with the
   * actual screen, leading to dock-icon spin loops until anti-loop guard
   * #1 bails. With flat=true we bypass planner.plan() entirely and run
   * the original task verbatim against runOneSubtask. The plannerContext
   * URL hint is also moot in this path because agent_do is vision-only
   * (browser=null).
   */
  flat?: boolean;
  /**
   * Opt-in one-shot decomposition for DECLARED multi-step flat tasks
   * (NEXT-WORK Item 2). Only honored when the PONDER_DECOMPOSE env gate
   * is also on — both must be set, so the default path is byte-identical
   * to today's flat behavior. The bridge passes decompose:true from the
   * /agent_do body; the bench passes it for multistep-tier cases. ONE
   * strong-model plan call splits the task into atomic steps, then each
   * step runs as its own runOneSubtask with a small budget, advancing
   * only on a verified "done" (the in-subtask verifier/completion probe
   * is the advance gate). Fixes the 8,=,8,= mis-sequencing class: the
   * brain re-planning from scratch each step has no notion of "which
   * sub-step am I on".
   */
  decompose?: boolean;
  /**
   * Higher-level goal this run is part of. Threaded into the brain's
   * per-step prompt so the model stays oriented when the immediate task
   * is just the next mechanical step. Previously hardcoded to undefined
   * in flat mode — agent_do tasks therefore lost framing context the
   * moment the loop started, which made it harder for the inner brain
   * to recognize completion mid-flight (e.g., file picker closes →
   * brain doesn't know it was a file-upload run → keeps emitting dock
   * clicks until anti-loop fires).
   */
  overallGoal?: string;
  /**
   * Per-call cap on inner steps. Defaults to MAX_STEPS (50) for
   * Electron-app runs. agent_do passes a much smaller cap (8) because
   * its contract is "ONE atomic OS-level step" — if it can't finish in
   * a handful of steps the orchestrator should re-plan with fresh state
   * rather than burn 50 retries on a stuck inner loop.
   */
  maxSteps?: number;
  /**
   * Per-call inter-step pause (ms). Defaults to the provider-aware
   * legacy values: 6500ms for hcompany (rate-limit safety), 1200ms
   * otherwise. agent_do overrides to 1500ms — at 8 inner steps the
   * total runtime stays inside the MCP client's typical 30-60s request
   * timeout even on the slow rate-limited path. Atomic OS-level steps
   * don't benefit from long settles between actions either.
   */
  stepPause?: number;
  /**
   * Per-call completion-probe cadence override. The module defaults
   * (min step 4, every 4) are sized for open-ended agent_do tasks;
   * decompose sub-steps are 1-2 actions, so waiting until step 4 to
   * check "is this single click done?" burns 3 redundant model steps.
   * The decompose loop passes { minStep: 2, every: 2 }.
   */
  completionProbe?: { minStep: number; every: number };
  /**
   * OS surface declared by the caller (agent_do passes file-picker /
   * finder / spotlight / dock / menu-bar / native-dialog / drag-drop /
   * other). Used to seed step 1's routerHint so the router doesn't
   * hijack a file-picker call by emitting `browser.click eN` against
   * the Chrome page sitting behind the OS overlay. From step 2 onward
   * the existing browserStalled detector takes over (DOM unchanged but
   * pixels moved → OS dialog on top → force vision).
   *
   * Undefined = chrome-page surface or no declaration; router runs
   * normally on step 1.
   */
  surface?: string;
  /**
   * macOS-only optimization: when set, every screenshot captured by
   * this loop is cropped to the front window of `targetApp` before
   * being sent to the planner and grounder. Defends against the
   * embedded-screenshot decoy AND drops `prompt_tokens` from ~4100
   * (full 1512×982 display) to ~175 (typical 230×408 app window) —
   * empirically a ~6× wall-time reduction on /ground/batch and a
   * comparable reduction on /plan. Uses the existing
   * screen.getMacWindowBounds() (which proxies through the Holo3
   * bridge's /window/bounds endpoint so the bridge's Accessibility
   * grant is used, not this process's). Falls through to uncropped
   * grounding on any error (process not running, bounds-query timeout,
   * crop math invalid).
   */
  targetApp?: string;
}

/**
 * Short SHA-256 of the screenshot bytes. Used as a cheap "did the screen
 * actually change?" fingerprint. Two identical hashes mean the rendered pixels
 * are byte-equal — the page didn't react to whatever we just did. We slice to
 * 16 hex chars (64 bits) because we're using this for collision detection
 * across <30 frames per run, not for cryptographic guarantees, and shorter
 * hashes keep the log lines readable.
 */
function hashScreen(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

/**
 * Crop a screenshot to the front window of the given macOS process and
 * return a new Screenshot with adjusted offsets so the existing click-
 * translation code (`coords = r.x + shot.offsetX, r.y + shot.offsetY`)
 * resolves into screen-space coords correctly without any other changes.
 *
 * Returns the original shot unmodified on any failure path:
 *   - non-darwin
 *   - process not running / no front window
 *   - bounds query timeout (osascript / bridge perms denied)
 *   - Electron module unavailable (no nativeImage to crop with)
 *   - computed crop rect doesn't fit inside the screenshot
 *
 * Logged in either case so the run transcript shows whether the crop
 * fired and the resulting savings.
 *
 * Exported for offline probing (bench/probe-crop.ts) — validate crop
 * geometry without a live 20-30s/step agent run.
 */
export async function maybeCropToTargetApp(
  shot: screen.Screenshot,
  targetApp: string | undefined,
): Promise<screen.Screenshot> {
  if (!targetApp || process.platform !== "darwin") return shot;
  // CRITICAL: bring the target app to the front before grounding.
  // getMacWindowBounds returns the target's logical position
  // regardless of Z-order, but the screenshot captures whatever is
  // RENDERED there. Without raising, a buried target gets cropped to
  // its OCCLUDER's pixels (May-11 incident: Ponder's session list
  // was where Calculator should have been; brain emitted 6 clicks at
  // Ponder UI thinking they were Calculator buttons; verifier false-
  // VERIFIED on session-title text containing "47×8"). Skipping when
  // raiseMacApp fails is acceptable — uncropped is still better than
  // occluded.
  const tRaise = Date.now();
  const raised = await screen.raiseMacApp(targetApp);
  if (raised) {
    // Give WindowServer a tick to actually flip Z-order before we
    // re-query bounds + re-screenshot. 60ms is empirically enough
    // for the front-window swap to land in the screenshot pipeline.
    await screen.sleep(60);
  }

  // ── Preferred path: direct window capture (occlusion-proof) ─────────
  // `screencapture -l<windowId>` grabs the window's OWN backing store at
  // native resolution — no full-screen capture, no crop math, and immune
  // to occlusion. The raise above still matters for CLICKS (they land on
  // whatever is physically on top), but grounding is now correct even
  // when a floating window (iOS Simulator pins at CGWindowLevel 8 —
  // unbeatable by a layer-0 raise) sits over the target. Observed live
  // 2026-06-10: the screen-crop returned the Simulator's pixels at
  // Calculator's coords and the model grounded "the 7 button" onto the
  // Simulator. Falls back to the legacy recapture+crop path when the
  // window-list helper is unavailable (no Swift toolchain).
  try {
    const tDirect = Date.now();
    const direct = await screen.captureWindowDirect(targetApp);
    // Same scale-aware sanity floor as the crop path below: a 2x direct
    // capture is native-res so only a tiny floor is needed; a 1x source
    // (non-Retina external display) is the genuinely-degraded small-crop
    // case the legacy 300px floor exists for. Shares the
    // PONDER_MIN_CROP_DIM_PX override.
    const directEnvFloor = Number(process.env.PONDER_MIN_CROP_DIM_PX);
    const directFloor =
      Number.isFinite(directEnvFloor) && directEnvFloor > 0
        ? directEnvFloor
        : direct && direct.scaleFactor > 1
          ? 80
          : 300;
    if (direct && Math.min(direct.width, direct.height) < directFloor) {
      console.log(
        `[loop] 🪟 window-direct capture skipped: ${targetApp} window ${direct.width}×${direct.height} below ${directFloor}px min-dim — falling back.`,
      );
    } else if (direct) {
      if (direct.occluders.length > 0) {
        console.log(
          `[loop] ⚠️ ${targetApp}'s window is OVERLAPPED by: ${direct.occluders.join("; ")}. ` +
            `Grounding uses the window's own pixels (correct), but clicks land on whatever is on top — ` +
            `if clicks misfire, move/close the overlapping window.`,
        );
      }
      console.log(
        `[loop] 🪟 window-direct capture of ${targetApp} (${direct.width}×${direct.height} logical @ ${direct.offsetX},${direct.offsetY}; ` +
          `scaleFactor=${direct.scaleFactor}, native ${Math.round(direct.width * direct.scaleFactor)}×${Math.round(direct.height * direct.scaleFactor)}px, ` +
          `windowId=${direct.windowId}): raise=${tDirect - tRaise}ms, capture=${Date.now() - tDirect}ms, ${direct.png.length} bytes` +
          (direct.occluders.length > 0 ? ` — ⚠️ occluded` : ""),
      );
      return direct;
    }
  } catch (e) {
    console.log(
      `[loop] 🪟 window-direct capture failed (${e instanceof Error ? e.message : String(e)}) — falling back to screen-crop path.`,
    );
  }

  if (raised) {
    // Critical: re-capture the screenshot AFTER the raise. The shot
    // we received was taken BEFORE we raised; cropping it would still
    // show the previous Z-order (the occluder, not the target). The
    // raise→sleep→recapture cycle is the difference between "crop
    // captures Calculator's keypad" and "crop captures Ponder's UI
    // at Calculator's coords because Calculator was buried" — the
    // May-11 false-VERIFIED run.
    try {
      shot = await screen.screenshot();
      console.log(
        `[loop] 🪟 raised ${targetApp} to front and re-captured ${shot.width}×${shot.height} in ${Date.now() - tRaise}ms (overrides the pre-raise shot which would have cropped the occluder's pixels at the target's coords).`,
      );
    } catch (e) {
      console.log(
        `[loop] 🪟 raise OK but recapture failed (${e instanceof Error ? e.message : String(e)}) — proceeding with original (possibly occluded) shot.`,
      );
    }
  } else {
    console.log(
      `[loop] 🪟 raise failed for "${targetApp}" — proceeding without Z-order swap (target may still be occluded; crop may capture wrong pixels).`,
    );
  }
  const tBounds = Date.now();
  const bounds = await screen.getMacWindowBounds(targetApp);
  if (!bounds) {
    console.log(
      `[loop] 🪟 crop skipped: getMacWindowBounds("${targetApp}") returned null in ${Date.now() - tBounds}ms — running uncropped this step.`,
    );
    return shot;
  }
  // SIZE THRESHOLD — scale-aware (2026-06-10).
  //
  // History: the floor was 300px because the live crop used to emit a
  // logical-res (degraded) image that small windows grounded badly on.
  // Root cause found 2026-06-10: screen.screenshot()'s nut-js path
  // returned NATIVE pixels mislabeled scaleFactor:1, so the crop sliced
  // logical coords out of a native PNG — wrong region, half size. With
  // scaleFactor now derived from the PNG's true dimensions, the crop is
  // native-res (the exact image bench/vision-precision.ts grounds at
  // 8/8 ~5px), so only a tiny sanity floor is needed. A scaleFactor=1
  // source (no Retina detail to preserve) keeps the conservative 300px
  // floor — that's the genuinely-degraded case the old comment feared.
  // `let` (not const) — the multi-monitor recapture below can swap in a
  // shot from a DIFFERENT display whose scaleFactor differs (2x built-in
  // vs 1x external); the crop math must use the recaptured shot's scale.
  let sf = shot.scaleFactor || 1;
  const envFloor = Number(process.env.PONDER_MIN_CROP_DIM_PX);
  const MIN_CROP_DIM_PX =
    Number.isFinite(envFloor) && envFloor > 0 ? envFloor : sf > 1 ? 80 : 300;
  if (Math.min(bounds.width, bounds.height) < MIN_CROP_DIM_PX) {
    console.log(
      `[loop] 🪟 crop skipped: ${targetApp} window ${bounds.width}×${bounds.height} below ${MIN_CROP_DIM_PX}px min-dim (scaleFactor=${sf}) — running uncropped.`,
    );
    return shot;
  }
  // Translate screen-space window bounds into screenshot-pixel space. On
  // a single-display setup both offsets are 0; on multi-monitor where
  // the cursor sits on the secondary display, shot.offsetX/Y carry that
  // display's screen-space origin and we subtract to get a rect inside
  // the captured PNG.
  let cropX = bounds.x - shot.offsetX;
  let cropY = bounds.y - shot.offsetY;
  const fitsInCurrentShot =
    cropX >= 0 &&
    cropY >= 0 &&
    cropX + bounds.width <= shot.width &&
    cropY + bounds.height <= shot.height;
  if (!fitsInCurrentShot) {
    // Multi-monitor recovery: the cursor was on a different display
    // than `targetApp`'s window, so screen.screenshot() captured the
    // wrong frame and the target isn't in our pixels at all. Without
    // recapture, the brain would ground hallucinations against the
    // wrong display's UI (this is what produced the mathway.com
    // 11-click disaster). Recapture on the display containing the
    // target window.
    const tRecapture = Date.now();
    const targetDisplay = screen.findDisplayForRect({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    });
    if (
      targetDisplay &&
      (targetDisplay.bounds.x !== shot.offsetX ||
        targetDisplay.bounds.y !== shot.offsetY)
    ) {
      const newShot = await screen.captureViaDesktopCapturer(targetDisplay);
      if (newShot) {
        console.log(
          `[loop] 🪟 multi-monitor recapture: target on display @(${targetDisplay.bounds.x},${targetDisplay.bounds.y}) ${targetDisplay.bounds.width}×${targetDisplay.bounds.height}, captured frame was @(${shot.offsetX},${shot.offsetY}) ${shot.width}×${shot.height} — re-captured in ${Date.now() - tRecapture}ms.`,
        );
        shot = newShot;
        // Refresh the scale factor — the recaptured display's DPI can
        // differ from the original shot's (stale sf here doubles or
        // halves the crop rect: the 2026-05-13 regression class).
        sf = shot.scaleFactor || 1;
        cropX = bounds.x - shot.offsetX;
        cropY = bounds.y - shot.offsetY;
      } else {
        console.log(
          `[loop] 🪟 crop skipped: multi-monitor recapture failed (desktopCapturer returned null) — running uncropped this step.`,
        );
        return shot;
      }
    } else {
      console.log(
        `[loop] 🪟 crop skipped: window rect ${bounds.width}×${bounds.height}@(${cropX},${cropY}) doesn't fit inside captured frame ${shot.width}×${shot.height} (window may be partially off-screen, or the target display isn't capturable).`,
      );
      return shot;
    }
  }
  // After possible recapture: bail if the window STILL doesn't fit
  // (e.g. partially off-screen even on its own display).
  if (
    cropX < 0 ||
    cropY < 0 ||
    cropX + bounds.width > shot.width ||
    cropY + bounds.height > shot.height
  ) {
    console.log(
      `[loop] 🪟 crop skipped after recapture: window rect ${bounds.width}×${bounds.height}@(${cropX},${cropY}) still doesn't fit ${shot.width}×${shot.height}.`,
    );
    return shot;
  }

  // Crop via sips (imageops.cropAndScalePng) — the exact code path
  // bench/vision-precision.ts validated at 8/8 ~5px. Unlike Electron's
  // nativeImage (the previous primitive), sips works in BOTH contexts
  // the loop runs in: the Electron main process AND a bare tsx process
  // (the MCP server). The nativeImage path silently skipped cropping
  // under tsx, which forced every MCP-driven step to ship the full
  // native frame (~1.6 MB → ~10 s/call on Modal).
  const tCrop = Date.now();
  try {
    // Scale logical bounds → physical pixels for the actual PNG slice.
    // On Retina the captured PNG is `width*sf × height*sf` even though
    // `shot.width/height` are logical. cropAndScalePng slices in PNG-
    // pixel space, so translate before slicing or we get the top-left
    // ¼ of the intended region — the 2026-05-13 vision-quality
    // regression. scale=1 keeps native pixels (no resample).
    const croppedPng = await cropAndScalePng(
      shot.png,
      {
        x: cropX * sf,
        y: cropY * sf,
        w: bounds.width * sf,
        h: bounds.height * sf,
      },
      1,
    );
    console.log(
      `[loop] 🪟 cropped to ${targetApp} (${bounds.width}×${bounds.height} logical @ ${cropX},${cropY}; scaleFactor=${sf}, native ${Math.round(bounds.width * sf)}×${Math.round(bounds.height * sf)}px): ` +
        `bounds=${Date.now() - tBounds}ms, crop=${Date.now() - tCrop}ms, ` +
        `${shot.png.length}→${croppedPng.length} bytes ` +
        `(~${Math.round(((shot.width * shot.height) / (bounds.width * bounds.height)) * 10) / 10}× fewer pixels)`,
    );
    return {
      png: croppedPng,
      width: bounds.width,
      height: bounds.height,
      // Add the crop offset to the existing display offset so the
      // click-translation site (`r.x + shot.offsetX`) still resolves
      // into screen-space coords. Caller doesn't have to know about
      // cropping — it's transparent to the rest of the loop.
      offsetX: shot.offsetX + cropX,
      offsetY: shot.offsetY + cropY,
      // Cropped PNG keeps the original scale factor — its physical
      // dimensions are bounds.width*sf × bounds.height*sf.
      scaleFactor: sf,
    };
  } catch (e) {
    console.log(
      `[loop] 🪟 crop failed: ${e instanceof Error ? e.message : String(e)} — using uncropped`,
    );
    return shot;
  }
}

/**
 * Normalize an action string so trivial drift doesn't fool the anti-loop.
 * Holo3 sometimes appends a period or extra whitespace ("click on the search
 * bar." vs "click on the search bar"); without this, the 3-of-4 check resets
 * because the strings aren't byte-equal even though the intent is identical.
 */
function normalizeAction(a: string): string {
  return a
    .trim()
    .toLowerCase()
    .replace(/[.?!]+$/, "")
    .replace(/\s+/g, " ");
}

/**
 * Heuristic: detect references to specific macOS native apps in the
 * task text. When the user says "calculate X on the calculator", they
 * mean Calculator.app — NOT "open Chrome and find a web calculator".
 * The hierarchical planner has historically picked the wrong path on
 * exactly these prompts (the May-10 mathway.com debacle:
 *   task: "calculate 12345/21412 x 12 on the calculator"
 *   plan: ["Open Chrome", "Navigate to the calculator page", ...]
 *   result: 20 hallucinated clicks on mathway.com, never reaches
 *           Calculator.app).
 *
 * When we detect a known native-app reference AND the caller hasn't
 * explicitly set targetApp / flat, we:
 *   1. Auto-set targetApp so screenshots get cropped to that app's
 *      window (~6× speedup on plan + ground).
 *   2. Force flat mode so the planner doesn't decompose into wrong
 *      subtasks — runOneSubtask handles the whole task with framing
 *      via the original task text.
 *
 * Patterns are intentionally narrow to avoid false positives — e.g.
 * "notes" alone is too generic (could mean any kind of note); we
 * require "Notes app". A user who genuinely wants the web flow can
 * pass flat:false explicitly, or pass targetApp:"" to opt out.
 */
const NATIVE_APP_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // Calculator: the failing example. Anchor on the word so "calculate"
  // (the verb) doesn't false-positive — only matches "calculator".
  { name: "Calculator", re: /\bcalculator\b/i },
  // Finder: very strong signal. "in Finder", "the Finder window".
  { name: "Finder", re: /\bfinder\b/i },
  // Calendar.app — the macOS native one. "calendar app", "in Calendar"
  // (capitalized), or "macOS Calendar".
  { name: "Calendar", re: /\bcalendar app\b|\bin Calendar\b|\bmacos calendar\b/i },
  // Native apps with disambiguating words.
  { name: "Notes", re: /\bnotes app\b|\bin Notes\b/i },
  { name: "Preview", re: /\bpreview app\b|\bin Preview\b/i },
  { name: "Reminders", re: /\breminders app\b|\bin Reminders\b/i },
  // Settings UIs (macOS calls it "System Settings" since Ventura).
  {
    name: "System Settings",
    re: /\bsystem settings\b|\bsystem preferences\b/i,
  },
  { name: "Terminal", re: /\bterminal app\b|\bin Terminal\b/i },
  // Browsers: matches when the task explicitly names the app. We
  // require the word "Chrome" / "Safari" / "Firefox" as a noun (so
  // generic verbs like "browse" don't false-positive). Validated
  // on the May-11 FB Marketplace bench: cropping Chrome's 1053×893
  // window vs the full 1512×982 screen dropped per-step latency
  // from 32s → 6s (~5×) AND removed adjacent-window distractors
  // (Cursor IDE chat to the right of Chrome) that had been pulling
  // the model's grounding off-target.
  { name: "Google Chrome", re: /\bchrome\b|\bgoogle chrome\b/i },
  { name: "Safari", re: /\bsafari\b/i },
  { name: "Firefox", re: /\bfirefox\b/i },
];

function inferTargetApp(task: string): string | null {
  for (const { name, re } of NATIVE_APP_PATTERNS) {
    if (re.test(task)) return name;
  }
  return null;
}

/**
 * Public entry point. Decomposes the task with the small local planner
 * (qwen3 via Ollama by default), then runs the existing per-step Holo3 loop
 * once per subtask, feeding the OVERALL goal back into each subtask's prompt
 * so the lower-level model stays oriented.
 *
 * If the planner is unavailable, returns a single-subtask plan and we run
 * exactly the old flat behavior — no regression for users who don't have
 * Ollama installed.
 *
 * Auto-targetApp detection: when the task text mentions a known native
 * macOS app (Calculator, Finder, etc.) AND the caller hasn't set
 * targetApp / flat explicitly, we (1) set targetApp to crop screenshots
 * to that app's window for the ~6× plan/ground speedup, and (2) force
 * flat mode so the planner doesn't decompose into wrong subtasks
 * ("Open Chrome → web calculator…"). See NATIVE_APP_PATTERNS above.
 */
export async function runTask(
  opts: RunOptions,
): Promise<TaskOutcome> {
  // Destructure events early — task is left mutable because the
  // auto-targetApp detection below may prepend a framing line.
  const { events } = opts;
  let task = opts.task;

  // Composite mode (smart hosted planner + Holo3 grounder — the
  // Surfer-2 split): the local Ollama router and hierarchical planner
  // are SUBSUMED — the hosted planner is both smarter and nearly as
  // fast, and live traces showed the 0.8B router/planner actively
  // harming runs (failure loops, few-shot leakage, 8-9s timeouts).
  // Force the flat per-step loop; sequencing intelligence lives in the
  // planner itself (and in decompose, which also runs through it).
  if (opts.provider.name === "composite" && (opts.router || !opts.flat)) {
    // Tasks that arrived on the HIERARCHICAL path (Electron UI "do a
    // task") were declared multi-step by their caller — route them
    // through decompose() so the hosted planner produces the plan and
    // verify-to-advance owns sequencing. agent_do calls (already flat)
    // keep their explicit decompose/multistep flag.
    const wasHierarchical = !opts.flat;
    console.log(
      `[loop] 🧠 composite mode: hosted planner active — bypassing local router and hierarchical planner${wasHierarchical ? " (decompose enabled for this multi-step task)" : ""}`,
    );
    opts = {
      ...opts,
      router: null,
      flat: true,
      decompose: opts.decompose ?? wasHierarchical,
    };
  }

  // Auto-targetApp: detect native-app intent in the task text. Fires
  // whenever targetApp isn't already explicitly set — INDEPENDENT of
  // flat-mode, because the bridge's /agent_do handler always sets
  // flat:true (see electron/main.ts runAgentTaskForBridge), so the
  // previous `!opts.flat` gate locked auto-detect out of every MCP-
  // forwarded call. Bug caught in the May-11 RUN 4 trace where a
  // task containing "Calculator's keypad" ran uncropped at 1512×982
  // for 26+ steps at ~20s/step because inferTargetApp never ran.
  //
  // ALSO forces flat:true. For non-flat paths (Electron UI invocation
  // with hierarchical planning), flipping flat ensures the planner
  // doesn't get a shot at decomposing "calculate on the calculator"
  // into "Open Chrome → web calculator". For already-flat paths, this
  // is a no-op.
  // Tri-state for opts.targetApp:
  //   undefined/null    → run inference (default behavior)
  //   "" (explicit)     → opt out (no inference, no cropping) — used by
  //                       multi-app tasks like t4-honda-crv where Chrome
  //                       AND Excel must both be visible across the run.
  //                       maybeCropToTargetApp's `if (!targetApp)` guard
  //                       (line 223) skips cropping for "" automatically.
  //   "AppName"         → use that app explicitly, skip inference.
  // Previously `!opts.targetApp` treated "" as falsy and triggered
  // inference anyway, locking the run to whichever app matched first
  // (e.g. Chrome). The line 452 comment promised "" was the opt-out,
  // but the implementation never honored it until 2026-05-11 Run 7.
  const inferredApp =
    opts.targetApp === undefined || opts.targetApp === null
      ? inferTargetApp(task)
      : null;
  if (inferredApp) {
    console.log(
      `[loop] 🪟 inferred targetApp="${inferredApp}" from task text → enabling crop${opts.flat ? "" : " and forcing flat mode (skips the hierarchical planner that would otherwise decompose into wrong subtasks)"}`,
    );
    // Prepend a framing line so the small Holo3 brain understands
    // it's looking at a CROPPED view of the app's window, not the
    // desktop. Empirically (May-11 RUN 3 trace), the brain on a
    // 458×408 cropped Calculator image said "click on the calculator
    // app icon" 6 times before the anti-loop bailed — it interpreted
    // the cropped window as an icon. The framing line below tells
    // the brain explicitly: this image IS the app's UI, click the
    // labeled buttons in it. Cheap (~30 tokens) and only fires for
    // auto-detected runs (explicit targetApp callers know the shape).
    const framedTask =
      `[You are looking at a cropped screenshot showing ONLY ${inferredApp}.app's window — the app is open and frontmost. The image you see IS the app's UI. Click the labeled buttons you see in the image. DO NOT click any 'app icon' — there are no icons in this view, just the app's own buttons/controls.]\n\n` +
      task;
    opts = {
      ...opts,
      task: framedTask,
      targetApp: inferredApp,
      flat: true,
    };
    // Also update the local `task` so the flat-mode branch below
    // (which forwards `task` explicitly, not `opts.task`) picks up
    // the framing line.
    task = framedTask;
  }

  // Flat mode (agent_do) — skip the hierarchical planner entirely.
  //
  // agent_do is contractually "ONE atomic OS-level mouse step", but the
  // Ollama planner doesn't know that and routinely over-decomposes one-
  // step inputs into 3-6 subtasks. Examples seen in the wild:
  //   • "Select the most recent screenshot in the file picker" →
  //     [Open Chrome, Navigate to file picker, ..., Click Open]
  //   • "Open Marketplace and search for bulbasaur" → the planner's own
  //     few-shot example about Marietta GA $3000 verbatim.
  // The brain then runs against a misframed first subtask ("Open Chrome"
  // while Chrome is already in front), can't recognize completion, and
  // falls back to its most-recently-successful action — which is what
  // produced the dock-icon spin until anti-loop guard #1 fired.
  //
  // In flat mode we hand the original task straight to runOneSubtask
  // with the standard MAX_STEPS budget. No subtask banner, no plan
  // context probe (agent_do is vision-only — browser is always null
  // here so the probe would no-op anyway).
  if (opts.flat) {
    // Forward overallGoal so the brain has framing context, and let the
    // caller cap maxSteps short (agent_do passes 8 — atomic steps don't
    // need 50 retries; the orchestrator re-plans with fresh state if 8
    // wasn't enough). Falls back to MAX_STEPS for legacy callers that
    // don't supply a cap.
    const flatBudget = opts.maxSteps ?? MAX_STEPS;

    // One-shot decomposition (NEXT-WORK Item 2). Double-gated: the
    // caller must declare the task multi-step (opts.decompose) AND the
    // operator must enable PONDER_DECOMPOSE — except in composite mode,
    // where the hosted planner produces reliable plans and the gate
    // defaults ON (PONDER_DECOMPOSE=off still wins via decomposeEnabled
    // returning false only when explicitly off — see below).
    const decomposeAllowed =
      decomposeEnabled() ||
      (opts.provider.name === "composite" &&
        (process.env.PONDER_DECOMPOSE ?? "").toLowerCase() !== "off");
    if (opts.decompose && decomposeAllowed) {
      let firstShot: screen.Screenshot | null = null;
      try {
        firstShot = await maybeCropToTargetApp(
          await screen.screenshot(),
          opts.targetApp,
        );
      } catch (e) {
        console.log(
          `[loop] 📋 decompose: first screenshot failed (${e instanceof Error ? e.message : String(e)}) — running flat`,
        );
      }
      if (firstShot) {
        // Browser-relay state for the plan. When Playwriter is connected,
        // the plan MUST be browser-first — without this, decompose planned
        // OS-launcher steps ("hotkey cmd+space → type facebook
        // marketplace") for a goal that was one browser.navigate away,
        // and cmd+space opened Raycast on the user's machine, so the
        // "Spotlight is open" expect could never verify.
        const probeBrowserCtx = async (): Promise<DecomposeBrowserContext> => {
          if (!opts.browser) return { connected: false, url: null };
          try {
            if (!(await opts.browser.available()))
              return { connected: false, url: null };
            const snap = await opts.browser.snapshot();
            return { connected: true, url: snap.url };
          } catch {
            return { connected: false, url: null };
          }
        };
        const browserCtx = await probeBrowserCtx();
        // Make the strong-model decompose call cancellable: poll the
        // caller's shouldCancel and abort the in-flight HTTP request so
        // Stop doesn't have to wait out a full plan call.
        const decomposeCtrl = new AbortController();
        const cancelPoll = opts.shouldCancel
          ? setInterval(() => {
              if (opts.shouldCancel!()) decomposeCtrl.abort();
            }, 150)
          : null;
        let plan: Awaited<ReturnType<typeof decompose>>;
        try {
          plan = await decompose(
            task,
            firstShot.png.toString("base64"),
            [firstShot.width, firstShot.height],
            opts.provider,
            decomposeCtrl.signal,
            browserCtx,
          );
        } finally {
          if (cancelPoll) clearInterval(cancelPoll);
        }
        if (opts.shouldCancel?.()) return "cancelled";
        if (!plan.oneShot) {
          console.log(
            `[loop] 📋 decomposed into ${plan.steps.length} steps:\n` +
              plan.steps.map((s, i) => `   ${i + 1}. ${s}`).join("\n"),
          );
          await events.onStatus(
            `Plan: ${plan.steps.map((s, i) => `${i + 1}) ${s}`).join("  ")}`,
          );
          // Per-step budget is small by design: each step is atomic, so
          // if it can't land in a handful of iterations the precondition
          // is broken and grinding later steps against it wastes minutes.
          const perStepBudget = Math.max(
            2,
            Number(process.env.PONDER_DECOMPOSE_STEP_MAXSTEPS ?? 8),
          );
          let totalSteps = 0;
          // ONE plan revision allowed per task. Live failure: decompose
          // planned from a screenshot of the AGENT'S OWN window ("click
          // the Modal button" = our provider toggle), the sub-step
          // contract locked the planner onto a target that doesn't
          // exist, the verifier said so 8 times, and nothing had the
          // authority to change the plan. Now a step that fails
          // (exhausted twice OR infeasible) triggers a re-decompose
          // from the LIVE screen with the failure as context.
          let planRevised = false;
          // Failure evidence collected across sub-step attempts, fed to
          // the plan revision so it can avoid the failed route. Without
          // it, revision reproduced the SAME plan verbatim (live: the
          // cmd+space plan failed on Raycast, revision re-planned
          // cmd+space, failed identically).
          const failureEvidence: string[] = [];
          for (let i = 0; i < plan.steps.length; i++) {
            if (opts.shouldCancel?.()) return "cancelled";
            if (totalSteps >= MAX_STEPS_TOTAL) {
              console.log(
                `[loop] 📋 decompose: total step budget ${MAX_STEPS_TOTAL} exhausted at item ${i + 1}/${plan.steps.length}`,
              );
              return "exhausted";
            }
            await events.onStatus(
              `Step ${i + 1}/${plan.steps.length}: ${plan.steps[i]}`,
            );
            // Advance contract: runOneSubtask's own DONE verification /
            // completion probe is the verify-to-advance gate — it only
            // returns "done" on a verified (or re-asserted) completion.
            // "exhausted" gets ONE retry (transient UI states resolve);
            // a second exhausted aborts the whole task rather than
            // grinding later steps against a broken precondition.
            let outcome: SubtaskOutcome = "exhausted";
            for (let attempt = 0; attempt < 2; attempt++) {
              outcome = await runOneSubtask({
                ...opts,
                // Make the assigned step UNMISSABLE. Live failure mode:
                // with task = the bare step text + "(this is part of:
                // <goal>)", the brain chased the overall goal and
                // free-ran the whole sequence inside step 1's budget.
                // The brain must do exactly ONE thing here — the
                // verify-to-advance gate handles sequencing.
                task:
                  `CURRENT STEP (${i + 1} of ${plan.steps.length}): ${plan.steps[i]}\n` +
                  (plan.expects[i]
                    ? `EXPECTED RESULT when this step is done: ${plan.expects[i]}\n`
                    : "") +
                  `Do ONLY this single step, then emit DONE. Do NOT continue ` +
                  `to later steps — each step is verified before advancing` +
                  (plan.expects[i]
                    ? ` against the EXPECTED RESULT above. If the screen contradicts it (a wrong value, a stray entry), FIX that first (e.g. clear and re-enter) before re-attempting the step.`
                    : `.`),
                // Atomic steps finish in 1-2 actions — probe early and
                // often so a completed step advances instead of burning
                // its whole budget re-doing itself.
                completionProbe: { minStep: 2, every: 2 },
                overallGoal: opts.overallGoal ?? opts.task,
                // Clamp to the remaining global budget so the LAST item
                // can't blow past MAX_STEPS_TOTAL mid-subtask.
                maxSteps: Math.max(
                  1,
                  Math.min(perStepBudget, MAX_STEPS_TOTAL - totalSteps),
                ),
                onStep: () => {
                  totalSteps++;
                },
                onHistory: (line) => {
                  // Harvest failure/ban notes as revision evidence.
                  if (/\[note: (failed|BANNED|skipped)/i.test(line)) {
                    failureEvidence.push(line.slice(0, 200));
                    if (failureEvidence.length > 6) failureEvidence.shift();
                  }
                  opts.onHistory?.(line);
                },
              });
              if (outcome !== "exhausted") break;
              console.log(
                `[loop] 📋 decompose: step ${i + 1} exhausted (attempt ${attempt + 1}/2)`,
              );
            }
            if (outcome === "goal_done") {
              // The OVERALL goal verified mid-step — the world advanced
              // past the plan (kickstart, redirect, user help). Every
              // remaining step is moot; finish the whole task.
              console.log(
                `[loop] 📋 overall goal verified during step ${i + 1} — finishing (skipping ${plan.steps.length - i - 1} remaining steps)`,
              );
              return "done";
            }
            if (outcome === "cancelled") return outcome;
            if (outcome === "infeasible" || outcome === "exhausted") {
              if (!planRevised) {
                planRevised = true;
                console.log(
                  `[loop] 📋 step ${i + 1} ${outcome} — revising the plan from the live screen (one-shot)`,
                );
                await events.onStatus(
                  "Plan isn't working — revising from the current screen…",
                );
                try {
                  const freshShot = await maybeCropToTargetApp(
                    await screen.screenshot(),
                    opts.targetApp,
                  );
                  const evidenceBlock = failureEvidence.length
                    ? `\nEvidence from the failed attempts:\n${failureEvidence
                        .map((l) => `  - ${l}`)
                        .join("\n")}`
                    : "";
                  const revised = await decompose(
                    `${task}\n[PLAN REVISION: the previous plan failed at step "${plan.steps[i]}" (${outcome}).${evidenceBlock}\nYour new plan must take a STRUCTURALLY DIFFERENT route — do NOT include the failed step or near-variants of it. Plan ONLY from what is actually on the CURRENT screenshot. If the screen shows an unrelated app or window, the first step must REACH the task's target (browser.navigate <url> for websites, open app "Name" for native apps) — never interact with unrelated windows.]`,
                    freshShot.png.toString("base64"),
                    [freshShot.width, freshShot.height],
                    opts.provider,
                    undefined,
                    await probeBrowserCtx(),
                  );
                  if (opts.shouldCancel?.()) return "cancelled";
                  if (!revised.oneShot) {
                    plan = revised;
                    console.log(
                      `[loop] 📋 revised plan (${plan.steps.length} steps):\n` +
                        plan.steps
                          .map((s, n) => `   ${n + 1}. ${s}`)
                          .join("\n"),
                    );
                    await events.onStatus(
                      `Revised plan: ${plan.steps.map((s, n) => `${n + 1}) ${s}`).join("  ")}`,
                    );
                    i = -1; // restart at the revised plan's first step
                    continue;
                  }
                  console.log(
                    "[loop] 📋 revision came back single-step — keeping the failure outcome",
                  );
                } catch (e) {
                  console.log(
                    `[loop] 📋 plan revision failed (${e instanceof Error ? e.message : String(e)})`,
                  );
                }
              }
              if (outcome === "infeasible") return "infeasible";
              console.log(
                `[loop] 📋 decompose: step ${i + 1}/${plan.steps.length} exhausted twice — aborting remaining steps`,
              );
              return "exhausted";
            }
          }
          return "done";
        }
      }
      // oneShot fallback (or screenshot failure): fall through to the
      // plain flat path below.
    }

    console.log(
      `[loop] 📋 flat mode (agent_do): skipping planner (maxSteps=${flatBudget}` +
        (opts.overallGoal ? `, goal="${opts.overallGoal.slice(0, 60)}"` : "") +
        `)`,
    );
    const result = await runOneSubtask({
      ...opts,
      task,
      overallGoal: opts.overallGoal,
      maxSteps: flatBudget,
      onStep: () => {},
    });
    return result === "cancelled" ||
      result === "exhausted" ||
      result === "infeasible"
      ? result
      : "done";
  }

  const planner = createOllamaPlanner();
  const t0 = Date.now();

  // Best-effort grab of the current Chrome URL/title so the planner can
  // skip already-completed setup subtasks (don't decompose "Open Chrome"
  // when Chrome is already on the right URL). Falls through silently
  // when no browser is wired or it's unavailable.
  let plannerContext: { browserUrl?: string; browserTitle?: string } = {};
  if (opts.browser) {
    try {
      if (await opts.browser.available().catch(() => false)) {
        const snap = await opts.browser.snapshot();
        plannerContext = { browserUrl: snap.url, browserTitle: snap.title };
      }
    } catch {
      // Don't block planning on a flaky browser probe.
    }
  }

  const plan = await planner.plan(task, plannerContext);
  console.log(
    `[loop] 📋 plan (${Date.now() - t0}ms): ${plan.note}\n` +
      plan.subtasks.map((s, i) => `   ${i + 1}. ${s}`).join("\n"),
  );
  // Surface the plan to the UI so the user can see what's about to happen.
  // Status (not error) so it shows as a normal narration line.
  if (plan.decomposed) {
    await events.onStatus(
      `Plan: ${plan.subtasks.map((s, i) => `${i + 1}) ${s}`).join("  ")}`,
    );
  }

  let totalSteps = 0;
  for (let i = 0; i < plan.subtasks.length; i++) {
    if (opts.shouldCancel?.()) return "cancelled";
    const subtask = plan.subtasks[i];

    // Compute this subtask's step budget. Flat mode (1 subtask) keeps the
    // historic 30-step cap. Hierarchical splits MAX_STEPS_TOTAL evenly with
    // a per-subtask floor/ceiling.
    const remaining = MAX_STEPS_TOTAL - totalSteps;
    const subBudget = plan.decomposed
      ? Math.min(remaining, MAX_STEPS_PER_SUBTASK)
      : MAX_STEPS;
    if (subBudget <= 0) {
      console.warn("[loop] 🛑 step budget exhausted across subtasks");
      await events.onError("Step budget exhausted before all subtasks finished.");
      return "exhausted";
    }

    if (plan.decomposed) {
      await events.onStatus(`Subtask ${i + 1}/${plan.subtasks.length}: ${subtask}`);
      console.log(
        `\n[loop] ── subtask ${i + 1}/${plan.subtasks.length} (budget=${subBudget}) — ${subtask} ──`,
      );
    }

    // Spread opts directly so onBrowserSnapshot / onHistory /
    // onScreenshotBuffer pass straight through to runOneSubtask. We only
    // override the per-subtask fields (task, overallGoal, maxSteps, onStep)
    // — the orchestrator's callbacks survive across all subtasks.
    const result = await runOneSubtask({
      ...opts,
      task: subtask,
      overallGoal: plan.decomposed ? task : undefined,
      maxSteps: subBudget,
      onStep: () => {
        totalSteps++;
      },
    });

    if (result === "goal_done") {
      console.log(
        `[loop] ✅ overall goal verified during subtask ${i + 1} — finishing early`,
      );
      return "done";
    }
    if (result === "cancelled") return "cancelled";
    // A subtask the inner loop proved impossible makes the whole task
    // impossible — propagate immediately, don't grind the rest.
    if (result === "infeasible") {
      console.warn(
        `[loop] 🚫 subtask ${i + 1} infeasible — aborting remaining ${plan.subtasks.length - i - 1} subtasks`,
      );
      return "infeasible";
    }
    // If a subtask exhausts its budget without emitting DONE, the planner
    // either decomposed wrong or the lower-level model got stuck. Either
    // way, continuing into the next subtask is unlikely to help — abort.
    if (result === "exhausted") {
      console.warn(
        `[loop] 🛑 subtask ${i + 1} exhausted — aborting remaining ${plan.subtasks.length - i - 1} subtasks`,
      );
      return "exhausted";
    }
    // result === "done" → carry on to next subtask
  }
  console.log(
    `[loop] 🏁 all ${plan.subtasks.length} subtask(s) completed (${totalSteps} steps total)`,
  );
  return "done";
}

interface SubtaskOpts extends RunOptions {
  /** The overall task this subtask is part of, threaded into each plan
   *  prompt so Holo3 doesn't lose sight of the goal. Undefined in flat mode. */
  overallGoal?: string;
  /** Step cap for this subtask only. */
  maxSteps: number;
  /** Called every time the inner loop completes a step, so the orchestrator
   *  can enforce the cross-subtask total budget. */
  onStep?: () => void;
  /** Called whenever a fresh browser snapshot is captured. The orchestrator
   *  uses this to remember the most recent snapshot across subtasks so the
   *  end-of-run extractor can use it instead of re-fetching. */
  onBrowserSnapshot?: (snap: BrowserSnapshot) => void;
}

async function runOneSubtask(
  opts: SubtaskOpts,
): Promise<SubtaskOutcome> {
  const { task, provider, events, overallGoal, maxSteps, onStep } = opts;
  const browser = opts.browser ?? null;
  const router = opts.router ?? null;
  // Hash of the previous step's snapshot AX text. Used to tell the router
  // "your last action didn't change the page" — a strong signal to either
  // DONE or escalate. Resets to undefined when a step had no snapshot.
  let prevSnapshotHash: string | undefined;
  // Hash of the previous step's SCREENSHOT pixels. Combined with the
  // browser snapshot hash to detect "an OS-level overlay opened" (file
  // picker, system dialog, native menu) — when the browser snapshot is
  // byte-equal but the screenshot pixels changed, Chrome's DOM didn't
  // move but something visually did. The router would otherwise re-emit
  // the same browser action (since IT only sees the unchanged snapshot)
  // and burn 4 steps until anti-loop kills the run. Detecting it here
  // lets us skip the router for ONE step and force vision, so Holo3 can
  // see the file picker and switch to mouse-grounded actions.
  let prevScreenHash: string | undefined;
  // The router's reason from the immediately-prior CLI escalation. Spliced
  // into the next think() call so Holo3 inherits context. Cleared after
  // each vision step lands.
  let pendingRouterHint: string | undefined;
  // Tandem-mode safety: when the orchestrator declared an OS-level surface
  // (file-picker / finder / spotlight / etc.), the router would otherwise
  // run on step 1 against the Chrome AX snapshot UNDERNEATH the OS overlay
  // and might emit `browser.click eN` against the page behind the dialog.
  // Seed step 1's routerHint with a surface-specific note so the brain
  // knows the AX tree is informational only this step. From step 2 onward
  // the existing browserStalled detector takes over.
  if (
    opts.surface &&
    opts.surface !== "chrome-page" &&
    opts.surface.length > 0
  ) {
    pendingRouterHint =
      `Caller declared OS surface "${opts.surface}" — an OS overlay (file ` +
      `picker / Finder / native dialog / etc.) is in front of Chrome. The ` +
      `Chrome accessibility tree this step is the page UNDERNEATH; treat ` +
      `it as informational only. Emit a vision-grounded mouse action ` +
      `(click / double click / drag / etc.) targeting the OS surface. ` +
      `browser.* refs are NOT applicable until the OS overlay is dismissed.`;
  }
  const history: string[] = [];
  // Parallel array to history: the screen hash AT THE MOMENT each action
  // was emitted. Used by the screen-aware anti-loop check — if the same
  // action repeats 3/4 times AND the screen was identical on each repeat,
  // we're truly stuck. If the screen WAS changing across repeats, the
  // agent is making progress (file picker is selecting items, list is
  // filtering, dropdown is updating) and the action-repeat is a false
  // positive. The Bulbasaur upload trace had this shape: three "click
  // on the Screenshot…PM.png file" emissions while the file was actually
  // being selected — the legacy guard killed a working flow.
  const actionScreenHashes: string[] = [];
  // Sliding window of the last few (action-text, ground-coord) pairs
  // captured from successful click grounds. Used by the anti-loop
  // guard's coord-scatter check: when the same action text repeats
  // 3+ times in this window AND its grounds are >SCATTER_THRESHOLD
  // apart spatially, the brain is hallucinating (vision model
  // returning random coords because the target isn't on screen).
  // Bail even if pixels are changing — mathway.com / facebook /
  // many websites have animated ads that produce pixel churn
  // without any progress being made.
  //
  // We only push on SUCCESSFUL grounds (not browser.*, not type,
  // not DONE) — the anti-loop is already paired with the existing
  // history-based check that fires on any repeat. This array's job
  // is to disambiguate "screen IS changing" cases.
  const recentClickGrounds: Array<{ action: string; x: number; y: number }> =
    [];
  const SCATTER_THRESHOLD_PX = 250;
  const SCATTER_WINDOW = 6;
  // Ralph verifier: when the brain emits DONE we ask the same model
  // (different prompt) "did the goal actually land?". If RETRY, we
  // push a [note: …] to history and run one more iteration so the
  // brain can course-correct. Capped at one verify per subtask — we'd
  // rather trust the second DONE than enter an infinite verify loop.
  let verificationAttempted = false;
  // One-shot, separate from verificationAttempted so a DONE-verify and
  // an INFEASIBLE-verify in the same subtask don't cannibalize each
  // other's single allowed check.
  let infeasibilityAttempted = false;
  // Hierarchical retry: when anti-loop guard #1 would bail (same
  // action 3/4 times AND screen unchanged), give the brain ONE
  // chance to recover by force-resnapshotting + pushing a strong
  // "you are stuck — change strategy" note. If the next iteration
  // ALSO emits the same action, we bail for real. This converts the
  // hard cliff at the anti-loop boundary into a single graceful
  // recovery step. Tracked once per subtask.
  let hardRetryAttempted = false;
  // Transient provider/network failures (Modal cold endpoint, dropped
  // socket, brief Wi-Fi blip) must not kill a multi-step run — observed
  // live: ONE `fetch failed` on a ground call aborted an otherwise-
  // healthy 5-step decompose run. Each failure burns a step with a
  // [note: …] and a pause; three CONSECUTIVE failures = a real outage,
  // propagate it. Reset on any successful provider call.
  let consecutiveProviderErrors = 0;
  // One hidden-tab note per stretch of hiddenness (re-arms when the
  // controlled tab becomes visible again). See the visibility check in
  // the step body.
  let tabHiddenNoted = false;
  // One active "raise Chrome above the covering app" attempt per hidden
  // episode. Live (2026-06-10): the user had to MANUALLY bring Chrome
  // forward and the run thrashed (vision scrolls grounded against the
  // Ponder window, not the listings) until they did. The harness now
  // raises the browser itself the first time it detects a non-browser
  // app is frontmost — so vision actions ground against the real tab.
  let tabRaiseAttempted = false;
  // Consecutive browser scrolls (page or grounded) that changed nothing.
  // After a threshold we BAN scrolling for the rest of the subtask and
  // point the planner at the page text it can read via browser.read —
  // live: 14 fruitless scrolls on a list whose full content was already
  // returned by a step-6 browser.read.
  let scrollNoEffectStreak = 0;
  let scrollBanned = false;
  // Last browser.read text + how many times the planner re-read identical
  // content. Re-reading the same page is a no-op; the content is already
  // in history. Caught to redirect toward acting on what was read.
  let lastReadContent: string | null = null;
  // URL of the page we most recently browser.type'd into. The
  // save-before-type guard compares it to the current snapshot URL to
  // know whether THIS form has received input yet — a weak planner
  // reaches an edit form and clicks Save without typing (live + headless:
  // the menu flow More-options→Edit→Save-without-type, editing nothing).
  let lastTypedUrl: string | null = null;
  // Count of actual content-changing edits committed (browser.type
  // executions). Feeds the fabricated-completion guard — a planner that
  // claims DONE on an each/all task with editActions===0 has done no
  // work, however confident its notes are. One-shot rejection.
  let editActions = 0;
  let fabricatedDoneRejected = false;
  let saveBeforeTypeBlocks = 0;
  // For each typed text we've ever attempted in this run, the set of screen
  // hashes the screen had right before we tried it. Re-typing the SAME text
  // from a screen we've already typed it on is the search-engine loop pattern
  // (planner sees the input box, types the query, page updates, planner
  // re-emits "type the query" because it doesn't realize results are already
  // showing). Catching this saves ~10 wasted steps per failure.
  const typedTextScreens = new Map<string, Set<string>>();
  // Anti-loop guard #0: counts how many times we've rejected a click on a
  // (disabled) ref this run, keyed by ref. Two strikes and we bail — the
  // model is structurally confused about prerequisites and re-snapshotting
  // hasn't unstuck it. Reset implicitly per subtask (whole map is fresh).
  const disabledRejectCount = new Map<string, number>();
  // Anti-loop guard #0c: canonical URLs the agent navigated to that the
  // site rewrote to a different URL. Re-navigating to any of these is
  // guaranteed to redirect again — kills runs in 3 steps via guard #1
  // (saw this on /marketplace/marietta/search → /marketplace/category/
  // search loops). Detected on the next-step snapshot by comparing the
  // requested URL to the actual URL; persisted across the whole subtask
  // so an alternating "marietta → category → marietta" pattern still
  // gets caught even when the IMMEDIATE last action looks fine.
  const rejectedNavigateUrls = new Set<string>();
  // Canonical URLs whose redundant navigate already went through the
  // verify-gated DONE check (composite mode). One verifier call per URL
  // per subtask — afterwards redundant navigates take the cheap
  // note-and-continue path so a stubborn planner can't farm verifier
  // calls at ~2s each.
  const verifyGatedNavUrls = new Set<string>();
  // Count of redundant navigates per canonical URL (the planner emitting
  // browser.navigate to the page it is already on). Live: 5 in a row
  // before any other action — the soft "continue" note didn't dislodge
  // it. After 2 the note escalates to a hard "STOP navigating, INSPECT
  // or ACT" directive.
  const redundantNavCounts = new Map<string, number>();
  // Refs whose banned browser.click already got the one-shot modality
  // swap to a vision click (see trySwapBannedClick). Second ban of the
  // same ref takes the plain ban path — if pixels couldn't move the
  // page either, repeating the swap is just a slower loop.
  const swappedClickRefs = new Set<string>();
  // Per-ref count of browser.clicks that executed cleanly but left the
  // DOM byte-identical (cleared when a click on the ref DOES change it).
  // Feeds the modality swap: 2 no-effect clicks on a ref = clicking it
  // again via the DOM is pointless.
  const noEffectClickRefs = new Map<string, number>();
  // Consecutive ban-skips (failed-action ban + futile-toggle ban). When a
  // decomposed step's PRESCRIBED action is itself banned, the planner has
  // nowhere to go — live trace: it note-spammed and re-emitted the banned
  // hotkey for the rest of an 8-step budget, twice. Three consecutive
  // banned steps = this sub-task cannot proceed; bail to "exhausted" so
  // the decompose layer's retry/revision machinery takes over early.
  let consecutiveBans = 0;
  // Prefetched next screenshot. We kick this off ~250ms after each action so
  // it overlaps with the inter-step pause; by the time the next iteration
  // starts, the bytes are already in memory and we skip a 50-200ms grab+encode.
  let prefetched: Promise<screen.Screenshot> | null = null;
  // Remembers the previous step's executed action so we can detect
  // multi-step compound sequences. Currently used only for Spotlight
  // launch detection (cmd+space → type+enter): the trailing step needs
  // extra settle for the launched app's window to draw before the next
  // snapshot. Updated only on successful execute so a failed/skipped
  // step doesn't poison the next iteration's compound check.
  let prevExecuted: Awaited<ReturnType<typeof executeAction>> = null;
  // Caller can override (agent_do passes 1500ms to keep total runtime
  // inside the MCP client's request timeout). Falls back to the
  // provider-aware default: 6500ms for hcompany rate-limit safety,
  // 1200ms otherwise.
  const stepPause =
    opts.stepPause ??
    (provider.name === "hcompany"
      ? STEP_PAUSE_MS_HCOMPANY
      : STEP_PAUSE_MS_DEFAULT);

  // Per-task AbortController. We feed its signal to provider HTTP calls and
  // tick `abort()` the moment cancelFlag flips, which makes Stop near-instant
  // (kills in-flight fetch instead of waiting for the slow path to finish).
  const ctrl = new AbortController();
  const cancelled = (): boolean => {
    if (opts.shouldCancel?.() && !ctrl.signal.aborted) {
      ctrl.abort();
      return true;
    }
    return ctrl.signal.aborted;
  };

  // Top-of-loop banner so it's obvious in the dev console which run is firing
  // and which provider is wired in. The reference demo (PromptEngineer48/holo3-demo
  // main.py) prints similar emoji-prefixed lines for every step.
  console.log(
    `\n[loop] ▶ task="${task}"${overallGoal ? ` goal="${overallGoal}"` : ""} provider=${provider.name} maxSteps=${maxSteps} stepPause=${stepPause}ms`,
  );

  // When we're inside a subtask of a larger plan, append the overall goal to
  // the per-step task description. Holo3 then sees BOTH the focused subtask
  // ("search Google for 'X'") AND the original user intent ("find a good
  // dual-monitor mount for SE2719HR"), which keeps it from chasing related-
  // but-wrong UI elements. We only do this when overallGoal differs from the
  // subtask itself — flat mode passes them as the same string.
  const taskForPlanner =
    overallGoal && overallGoal !== task
      ? `${task}\n(this is part of: ${overallGoal})`
      : task;

  for (let step = 0; step < maxSteps; step++) {
    if (cancelled()) {
      console.log("[loop] ⏹  cancelled by user");
      return "cancelled";
    }

    console.log(`\n[loop] ── step ${step + 1}/${maxSteps} ──`);

    const t0 = Date.now();
    // Use the prefetched screenshot if the previous step kicked one off during
    // its pause — saves the grab+PNG-encode latency on every step after the
    // first. If prefetch failed (e.g. transient nut-js error), fall back to a
    // fresh capture so a single bad frame doesn't kill the whole run.
    let shot: screen.Screenshot;
    let prefetchUsed = false;
    if (prefetched) {
      try {
        shot = await prefetched;
        prefetchUsed = true;
      } catch (e) {
        console.warn(
          `[loop] prefetch failed (${e instanceof Error ? e.message : String(e)}) — falling back to fresh screenshot`,
        );
        shot = await screen.screenshot();
      }
      prefetched = null;
    } else {
      shot = await screen.screenshot();
    }
    // Crop to targetApp's front window if the caller requested it.
    // Cheap — the bridge proxy resolves bounds in ~50ms when perms are
    // granted, and Electron's nativeImage crop is sub-10ms. The savings
    // downstream are large: ~6× faster /plan and /ground calls because
    // image-patch tokens scale with pixel count and a typical app
    // window is ~16× smaller than the full display.
    shot = await maybeCropToTargetApp(shot, opts.targetApp);
    // Full-frame downscale (2026-06-10): uncropped native Retina frames
    // are ~6MP / ~1.4MB and get uploaded 1-3× per step, yet the model's
    // own preprocessor caps the pixel budget and downscales them anyway
    // — native upload buys ~nothing but several seconds of bandwidth +
    // encode per call (observed 19-27s full-frame /step calls). Resample
    // big frames to logical via sips (~100ms once, saves seconds per
    // model call). Crops (width < 1024) keep native detail.
    // PONDER_FULLFRAME_DOWNSCALE=off restores native upload.
    if (
      (process.env.PONDER_FULLFRAME_DOWNSCALE ?? "on").toLowerCase() !==
        "off" &&
      (shot.scaleFactor || 1) > 1 &&
      shot.width >= 1024
    ) {
      try {
        const tDown = Date.now();
        const dims = pngDimensions(shot.png);
        if (dims && dims.width > shot.width) {
          const down = await cropAndScalePng(
            shot.png,
            { x: 0, y: 0, w: dims.width, h: dims.height },
            shot.width / dims.width,
          );
          console.log(
            `[loop] 📉 full-frame downscale ${dims.width}×${dims.height}→${shot.width}×${shot.height} (${shot.png.length}→${down.length} bytes, ${Date.now() - tDown}ms)`,
          );
          shot = { ...shot, png: down, scaleFactor: 1 };
        }
      } catch (e) {
        console.log(
          `[loop] 📉 downscale failed (${e instanceof Error ? e.message.split("\n")[0] : String(e)}) — sending native`,
        );
      }
    }
    // Surface occlusion to the BRAIN, not just the console: a window-
    // direct capture grounds correctly through an overlapping window,
    // but clicks land on whatever is physically on top — without this
    // note the model re-emits the same correct-looking click forever
    // (the out-of-bounds guard passes; the coords ARE inside the
    // target's bounds). Deduped so the note lands once per occluder set.
    const occluders = (shot as screen.Screenshot & { occluders?: string[] })
      .occluders;
    if (occluders && occluders.length > 0) {
      const note = `[note: ${opts.targetApp}'s window is partially covered by ${occluders.join(" and ")} — clicks in the covered area will hit that window instead. If clicks have no effect, the overlapping window must be moved or closed first.]`;
      if (history[history.length - 1] !== note && !history.includes(note)) {
        history.push(note);
        opts.onHistory?.(note);
      }
    }
    // Probe the current browser URL whenever targetApp is a browser
    // we support (Chrome, Safari). Cheap (~30-80ms via the bridge),
    // and a critical state signal for the brain — without it the
    // brain doesn't know "did my click navigate?". The May-11 false-
    // positive DONE happened because the brain emitted DONE after a
    // misclicked sidebar nav landed on facebook.com/marketplace/you;
    // the verifier had no way to compare that URL against the goal's
    // expected "search results" URL pattern.
    //
    // Fetched AFTER maybeCropToTargetApp's raise+recapture so the
    // browser is guaranteed frontmost and AppleScript "front window"
    // returns the real Chrome window (not whatever was occluding it).
    let currentUrl: { url: string; title: string } | undefined;
    if (
      opts.targetApp &&
      /^(Google Chrome|Safari)$/i.test(opts.targetApp)
    ) {
      currentUrl =
        (await screen.getBrowserUrl(opts.targetApp)) ?? undefined;
      if (currentUrl) {
        console.log(
          `[loop] 🌐 browser url (${opts.targetApp}): ${currentUrl.url} — "${currentUrl.title.slice(0, 60)}${currentUrl.title.length > 60 ? "..." : ""}"`,
        );
      }
    }
    // let (not const): the tab-hidden active-raise recovery below may
    // re-screenshot after bringing the browser forward and must update
    // this so the step plans/grounds against the now-visible tab.
    let screenHash = hashScreen(shot.png);
    console.log(
      `[loop] 📸 screenshot ${shot.width}x${shot.height} (${shot.png.length} bytes, ${Date.now() - t0}ms${prefetchUsed ? " prefetched" : ""}) hash=${screenHash}`,
    );
    // Click-delivery check (2026-06-10): if the PREVIOUS action was a
    // mouse click and the screen is byte-identical, the click almost
    // certainly never reached the target — most commonly another window
    // came back on top during the model-time gap between capture and
    // dispatch (capture-time raising can't hold Z-order for 2s+ of
    // think time), so the CGEvent landed on the intruder. Without this
    // note the brain assumes the click worked and plows ahead, silently
    // corrupting multi-step sequences (live-observed: Calculator
    // accumulated "8,788" from partial 4,7,×,8 entries). The note makes
    // the brain re-emit the action — which also triggers the
    // refine-on-retry re-ground.
    if (
      prevExecuted &&
      /^(click|double_click|triple_click|right_click)$/i.test(
        prevExecuted.type,
      ) &&
      screenHash === prevScreenHash
    ) {
      const note =
        "[note: the previous click changed NOTHING on screen — it likely never reached the target (another window may have intercepted it). Re-emit the action for the same target.]";
      if (history[history.length - 1] !== note) {
        history.push(note);
        opts.onHistory?.(note);
        console.log(
          `[loop] ⚠ previous ${prevExecuted.type} produced no screen change — flagged to the brain`,
        );
      }
    }
    await events.onScreenshot(shot.png);
    // Cache the latest frame for the extractor at end-of-run. The events
    // path uploads to Convex / pings the buddy; this side-channel keeps a
    // local Buffer reference so we never have to re-fetch from storage.
    opts.onScreenshotBuffer?.(shot.png);
    if (cancelled()) return "cancelled";
    const screenSize: [number, number] = [shot.width, shot.height];

    // Best-effort browser snapshot. Done in parallel with… nothing: it's
    // ~50-150ms when the extension is connected, runs sequentially before
    // plan(). When the extension is offline or no tab is green, available()
    // returns false within ~1.5s and we fall through to vision-only. The
    // snapshot flows out through opts.onBrowserSnapshot so the orchestrator
    // can latch the most recent value for the extractor at end-of-run.
    let browserSnapshot: BrowserSnapshot | undefined;
    if (browser) {
      try {
        if (await browser.available()) {
          const tSnap = Date.now();
          browserSnapshot = await browser.snapshot();
          console.log(
            `[loop] 🌐 snapshot (${Date.now() - tSnap}ms): ${browserSnapshot.url} (${browserSnapshot.ax.length}b)`,
          );
          opts.onBrowserSnapshot?.(browserSnapshot);
        }
      } catch (e) {
        console.warn(
          `[loop] snapshot failed (${e instanceof Error ? e.message : String(e)}) — vision-only this step`,
        );
      }
    }

    // Controlled-tab visibility (2026-06-10): the relay's bringToFront
    // cannot reliably switch Chrome's visible tab, so the SCREENSHOT can
    // show a different tab than browser_* actions operate on. Without
    // surfacing this, the verifier judges browser state from unrelated
    // pixels ("the page is about Playwright" while the snapshot URL was
    // the Google results with the answer) and the planner chases
    // ghosts. Detect it, tell the planner once, and tell the verifier
    // on every call this step.
    let controlledTabHidden = false;
    if (browserSnapshot && browser?.isActive) {
      // RELIABLE detection via TITLE COMPARISON. The previous heuristics
      // (visibilityState; "is a browser the frontmost window") both have
      // a fatal blind spot exposed live 2026-06-11: the controlled FB tab
      // was a BACKGROUND tab while the visible Chrome window showed the
      // user's OWN vercel admin dashboard. visibilityState reported
      // "visible" (it's the active tab in ITS window) and a browser WAS
      // frontmost (the vercel window) — so both said "not hidden", the
      // verifier judged from the vercel pixels ("not Facebook Marketplace"
      // ×15), and the planner re-navigated 17 times. The truth: the
      // frontmost browser window's TITLE (the visible tab) ≠ the
      // controlled tab's title. Compare them.
      const norm = (s: string) =>
        (s || "")
          .toLowerCase()
          .replace(
            /\s*[-–—|]\s*(google chrome|chromium|brave|microsoft edge|arc)\s*$/i,
            "",
          )
          .replace(/\s+/g, " ")
          .trim();
      const titlesAgree = (winTitle: string, tabTitle: string): boolean => {
        const w = norm(winTitle);
        const t = norm(tabTitle);
        if (!w || !t) return false; // can't confirm → treat as hidden (safe)
        if (w === t) return true;
        const shorter = w.length <= t.length ? w : t;
        const longer = w.length <= t.length ? t : w;
        // truncation-tolerant: titles in the window list can be cut off
        return shorter.length >= 10 && longer.startsWith(shorter.slice(0, 30));
      };

      controlledTabHidden = !(await browser.isActive().catch(() => false));
      let coveringApp: string | null = null;
      let frontIsForeignTab = false;
      try {
        const wins = await screen.listMacWindows();
        const front = wins?.find(
          (w) => w.layer === 0 && w.width > 200 && w.height > 200,
        );
        if (front) {
          const frontIsBrowser = /chrome|chromium|arc|brave|edge/i.test(
            front.owner,
          );
          if (!frontIsBrowser) {
            // A non-browser app covers Chrome entirely.
            controlledTabHidden = true;
            coveringApp =
              wins?.find((w) =>
                /chrome|chromium|arc|brave|edge/i.test(w.owner),
              )?.owner ?? null;
          } else if (!titlesAgree(front.name, browserSnapshot.title)) {
            // A browser is frontmost but it's showing a DIFFERENT tab/
            // window than the one we control (the vercel-admin trap).
            controlledTabHidden = true;
            frontIsForeignTab = true;
          } else {
            // Frontmost browser window title matches the controlled tab —
            // it really is visible; override the visibilityState verdict.
            controlledTabHidden = false;
          }
        }
      } catch {
        /* best-effort — keep the visibilityState verdict */
      }

      // ACTIVE RECOVERY (once per hidden episode): bring the CONTROLLED
      // tab to the foreground. Two moves: switch Chrome to the controlled
      // tab (browser.bringToFront — fixes the foreign-tab case), and raise
      // the browser app above a covering app. Then re-screenshot and
      // re-confirm by title.
      if (controlledTabHidden && !tabRaiseAttempted) {
        tabRaiseAttempted = true;
        console.log(
          `[loop] 🪟 controlled tab hidden (${frontIsForeignTab ? "a different Chrome tab/window is in front" : `covered by ${coveringApp ?? "another app"}`}) — switching to it`,
        );
        try {
          if (browser.bringToFront) await browser.bringToFront();
          if (coveringApp) await screen.raiseMacApp(coveringApp);
          await screen.sleep(300);
          shot = await maybeCropToTargetApp(
            await screen.screenshot(),
            opts.targetApp,
          );
          screenHash = hashScreen(shot.png);
          const winsAfter = await screen.listMacWindows();
          const frontAfter = winsAfter?.find(
            (w) => w.layer === 0 && w.width > 200 && w.height > 200,
          );
          if (
            frontAfter &&
            /chrome|chromium|arc|brave|edge/i.test(frontAfter.owner) &&
            titlesAgree(frontAfter.name, browserSnapshot.title)
          ) {
            controlledTabHidden = false;
            console.log(
              `[loop] 🪟 recovery succeeded — controlled tab is now frontmost`,
            );
          } else {
            console.log(
              `[loop] 🪟 recovery did not surface the controlled tab — staying browser.*-only this episode`,
            );
          }
        } catch {
          /* best-effort — fall through with the note below */
        }
      }
      if (controlledTabHidden && !tabHiddenNoted) {
        tabHiddenNoted = true;
        const note = `[note: IGNORE THE SCREENSHOT — it shows a DIFFERENT tab/app, NOT the page you control. You ARE on ${browserSnapshot.url} (the snapshot + browser.read are the TRUTH). Do NOT navigate there again (you're already there), and do NOT trust the screenshot's apparent page. Work ENTIRELY via browser.* (which act on the controlled tab regardless of what's visible): browser.read to see it; OPEN an item by browser.navigate to its edit URL, or browser.click its [eN] ref, or browser.click its "More options" ref then the "Edit listing" menuitem; browser.type to change it. NO vision clicks/scrolls until the page is actually visible.]`;
        history.push(note);
        opts.onHistory?.(note);
        console.log(
          `[loop] ⚠ controlled tab still hidden after recovery — strong note to planner`,
        );
      }
      if (!controlledTabHidden) {
        tabHiddenNoted = false;
        tabRaiseAttempted = false;
      }
    }

    // ── Proactive completion probe ───────────────────────────────────────
    // Catch "goal already met but the brain won't emit DONE" (the flat-
    // mode grounding-model failure). Cadence-gated so healthy short runs
    // never pay for it; the skeptical verifier makes a mid-task probe
    // safe (RETRY unless concrete proof).
    //
    // Latency (2026-06-10): the probe used to block the step ~10s on the
    // Modal path BEFORE the step's own plan call. It now STARTS here and
    // is awaited right after the plan call returns — probe and plan run
    // concurrently against the same frozen screenshot, so a probe step
    // costs ~max(probe, plan) instead of probe + plan. Exception:
    // hcompany stays sequential (its ~10 RPM tier would eat the burst as
    // 429 retries). Rejections are captured immediately so a probe
    // failure during think() can't fire unhandledRejection.
    let pendingProbe: Promise<
      | {
          ok: true;
          goal: { verified: boolean; reason?: string };
          step: { verified: boolean; reason?: string } | null;
        }
      | { ok: false; err: unknown }
    > | null = null;
    const probeMinStep = Math.max(
      1,
      opts.completionProbe?.minStep ?? COMPLETION_PROBE_MIN_STEP,
    );
    const probeEvery = Math.max(
      1,
      opts.completionProbe?.every ?? COMPLETION_PROBE_EVERY,
    );
    // The probe checks the OVERALL GOAL when one exists, not the current
    // sub-step. Live failure (2026-06-10): the web kickstart loaded the
    // answer at sub-step 2 of a 6-step launch-Chrome plan, but the probe
    // only ever verified "type chrome" — the run ground through moot
    // steps for 40+ iterations with the goal sitting on screen. A
    // verified overall goal ends the WHOLE task ("goal_done"), however
    // wrong the plan has become.
    const probeGoal =
      overallGoal && overallGoal.trim() !== task.trim() ? overallGoal : null;
    if (
      COMPLETION_PROBE_ENABLED &&
      verifierEnabled() &&
      step >= probeMinStep &&
      step % probeEvery === 0
    ) {
      // TWO-TIER probe (2026-06-10 round 13). The goal tier catches
      // "the world advanced past the plan" (goal_done ends everything).
      // The step tier catches the opposite blind spot the goal tier
      // CREATED: in decompose mode nothing re-checked the CURRENT
      // STEP's expect, so a step that landed as a side effect was
      // invisible — live trace: sub-step "click Your Items" sat ON
      // /you/selling (its expect satisfied) for 6 more steps,
      // re-clicking a link to the page it was already on, because the
      // only probe in flight asked about slow-moving listings. This is
      // the look→guess→VALIDATE→resteer loop: validate BOTH horizons,
      // act on whichever verdict lands.
      const stepTier = probeGoal !== null && provider.name !== "hcompany";
      console.log(
        `[loop] 🔎 completion probe (step ${step + 1}) — checking ${probeGoal ? (stepTier ? "OVERALL GOAL + CURRENT STEP" : "the OVERALL GOAL") : "the goal"}…`,
      );
      const mkVerify = (vtask: string) =>
        verify(provider, {
          task: vtask,
          screenshotB64: shot.png.toString("base64"),
          screen: screenSize,
          browserSnapshot,
          currentUrl,
          tabHidden: controlledTabHidden,
          signal: ctrl.signal,
          // Fail-closed: nobody claimed DONE here — a provider error or
          // ambiguous reply must not terminate the run (under decompose
          // it would falsely advance the plan).
          errorDefault: false,
        });
      pendingProbe = (async () => {
        try {
          const [goal, step_] = await Promise.all([
            mkVerify(probeGoal ?? taskForPlanner),
            stepTier ? mkVerify(taskForPlanner) : Promise.resolve(null),
          ]);
          return { ok: true as const, goal, step: step_ };
        } catch (err) {
          return { ok: false as const, err };
        }
      })();
      if (provider.name === "hcompany") {
        const settled = await pendingProbe;
        pendingProbe = null;
        if (cancelled()) return "cancelled";
        if (!settled.ok) throw settled.err;
        if (settled.goal.verified) {
          console.log(
            "[loop] ✅ completion probe: goal already achieved — the brain " +
              "didn't recognize completion; terminating as DONE",
          );
          await events.onStatus("Goal already met — finishing.");
          return probeGoal ? "goal_done" : "done";
        }
        console.log(
          `[loop] 🔁 completion probe: not done yet (${settled.goal.reason ?? "no proof"}) — continuing`,
        );
        if (cancelled()) return "cancelled";
      }
    }

    // ── Post-navigate redirect detection ─────────────────────────────────
    //
    // If the IMMEDIATELY-PREVIOUS action was browser.navigate <X> AND the
    // snapshot we just captured shows we're at <Y> ≠ <X>, the site rewrote
    // our URL. Two things happen:
    //   1. canonical(X) joins `rejectedNavigateUrls` so guard #0c (below,
    //      after the action is generated) can refuse a future attempt to
    //      re-navigate to it.
    //   2. The previous history entry is rewritten to
    //      `browser.navigate <X>  → redirected to <Y>` so the brain/router
    //      sees the redirect on EVERY subsequent step, not only when the
    //      most recent action was the navigate. Without this annotation
    //      the agent alternated marietta/search ⇄ category/search until
    //      guard #1 killed the run after 3 attempts.
    //
    // Only fires when we have a browserSnapshot this step — pure vision
    // steps don't carry a URL to compare against.
    if (browserSnapshot && history.length > 0) {
      const prev = history[history.length - 1]!;
      const m = prev.match(/^browser\.navigate\s+(\S+)/i);
      if (m && !/→ redirected to/.test(prev)) {
        const requested = canonicalizeUrl(m[1]!);
        const actual = canonicalizeUrl(browserSnapshot.url);
        if (requested && actual && requested !== actual) {
          rejectedNavigateUrls.add(requested);
          const annotated = `${prev}  → redirected to ${browserSnapshot.url}`;
          history[history.length - 1] = annotated;
          console.warn(
            `[loop] 🔁 navigate redirected: ${m[1]} → ${browserSnapshot.url} (added to rejected set)`,
          );
        }
      }
    }

    // ── WEB KICKSTART (deterministic, no model) ──────────────────────────
    // A blank tab gives the grounding-first brain NOTHING to ground on —
    // live-observed: it hallucinated a "search icon" on about:blank, the
    // router escalated wrongly, and the run died in 3 steps at 19-27s of
    // full-frame model time each. When the attached tab is blank and the
    // task isn't pinned to a native app, the right first move is always
    // the same: put real content on screen. If the task names a URL,
    // navigate to it; otherwise navigate to a web search FOR the task.
    // One Playwright call (~1s), zero model time. PONDER_WEB_KICKSTART=off
    // to disable.
    if (
      step === 0 &&
      browser &&
      browserSnapshot &&
      (process.env.PONDER_WEB_KICKSTART ?? "on").toLowerCase() !== "off" &&
      /^(about:blank|chrome:\/\/newtab\/?|chrome:\/\/new-tab-page\/?)?$/i.test(
        browserSnapshot.url.trim(),
      ) &&
      (!opts.targetApp || /chrome|safari|firefox/i.test(opts.targetApp))
    ) {
      const rawQuery = (opts.overallGoal ?? opts.task)
        .replace(/\[[^\]]*\]/g, " ") // strip framing blocks
        .replace(/^CURRENT STEP[^:]*:\s*/i, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
      const urlInTask = rawQuery.match(
        /(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?/i,
      );
      const kickUrl = urlInTask
        ? urlInTask[0].startsWith("http")
          ? urlInTask[0]
          : `https://${urlInTask[0]}`
        : `https://www.google.com/search?q=${encodeURIComponent(rawQuery)}`;
      try {
        console.log(
          `[loop] 🚀 web kickstart: blank tab + web task → browser.navigate ${kickUrl}`,
        );
        await browser.navigate(kickUrl);
        const entry = `browser.navigate ${kickUrl}  [deterministic kickstart: blank tab]`;
        history.push(entry);
        opts.onHistory?.(entry);
        await events.onAction({
          type: "browser_navigate",
          payload: { url: kickUrl },
        });
        await events.onStatus(`Opened ${kickUrl}`);
        prevExecuted = { type: "browser_navigate", payload: { url: kickUrl } };
        prevScreenHash = screenHash;
        prevSnapshotHash = browserSnapshot
          ? hashScreen(Buffer.from(browserSnapshot.ax))
          : prevSnapshotHash;
        if (await interruptiblePause(stepPause, cancelled)) return "cancelled";
        continue;
      } catch (e) {
        console.log(
          `[loop] 🚀 web kickstart failed (${e instanceof Error ? e.message.split("\n")[0] : String(e)}) — falling through to the normal loop`,
        );
      }
    }

    // ── ROUTER (CLI fast path) ───────────────────────────────────────────
    // When Chrome is active AND a router is wired, ask it FIRST — typically
    // 500–1000ms via local Ollama vs ~10s for the hcompany plan + ground
    // round trip. The router emits one of:
    //   • action      → exec directly, skip plan/ground
    //   • done        → end the subtask
    //   • vision_needed → fall through to Holo3 with the reason as a hint
    //   • skip        → fall through silently (router unavailable / errored)
    //
    // BROWSER-STALL ESCALATION: when the previous browser action didn't
    // change the DOM (snapshotUnchanged) BUT the screen pixels DID change
    // (different screenHash), an OS-level overlay just appeared on top
    // of Chrome — typically a file picker, system dialog, or native
    // menu triggered by a click. The router would just see the
    // unchanged snapshot and re-emit the same browser action (clicking
    // BEHIND the dialog, no effect). We pre-empt: skip the router this
    // step entirely, force vision (Holo3 looks at the screenshot,
    // sees the file picker, switches to mouse-grounded actions). This
    // is the file-picker-stuck case in user logs:
    //   step N: browser.click e15 (Add photo) → file picker opens
    //   step N+1: snapshot byte-equal to step N, screenHash differs
    //             → router would re-emit "browser.click e15"
    //   step N+1 (with this guard): force vision, Holo3 picks up the
    //             file picker UI and emits a mouse click on a file.
    let routerAction: string | undefined;
    let usedRouter = false;
    const snapHash = browserSnapshot
      ? hashScreen(Buffer.from(browserSnapshot.ax))
      : undefined;
    const snapshotUnchanged =
      prevSnapshotHash !== undefined && snapHash === prevSnapshotHash;
    const screenChanged =
      prevScreenHash !== undefined && prevScreenHash !== screenHash;
    // Stall = OS overlay on top of Chrome (canonical case: browser.click
    // "Add photo" → native file picker). Only plausible when the PREVIOUS
    // step was a CLICK — scrolls, notes, and types cannot open native
    // dialogs, yet they armed this check and fired a false "native
    // dialog is open!" hint on nearly EVERY step of a 50-step run
    // (lazy-loading thumbnails change pixels while the DOM stays
    // byte-identical), poisoning the planner's context with a story
    // that never happened.
    const prevType = prevExecuted?.type ?? "";
    const prevWasClickLike =
      /^(browser_click|click|double_click|triple_click|right_click)$/.test(
        prevType,
      );
    const browserStalled =
      snapshotUnchanged && screenChanged && prevWasClickLike;

    // Per-ref no-effect bookkeeping. A browser.click that EXECUTES fine
    // but leaves the DOM byte-identical never writes a [note: failed]
    // entry, so the 2-failure ban can't see it — the only backstop was
    // the futile-toggle ban at 4 repeats (live: e20 clicked 5×). Count
    // DOM-no-effect outcomes per ref so the modality swap can fire on
    // the ref's THIRD emission instead.
    if (browserSnapshot && prevType === "browser_click") {
      const prevRef = String(prevExecuted?.payload?.ref ?? "");
      if (/^e\d+$/i.test(prevRef)) {
        if (snapshotUnchanged) {
          noEffectClickRefs.set(
            prevRef,
            (noEffectClickRefs.get(prevRef) ?? 0) + 1,
          );
        } else {
          noEffectClickRefs.delete(prevRef);
        }
      }
    }

    // Scroll circuit breaker. A scroll is "effective" if it moved EITHER
    // the DOM (lazy-load) or the screen pixels. Count consecutive
    // ineffective scrolls (page or grounded); after the threshold, BAN
    // scrolling for the rest of the subtask and point the planner at the
    // page text. Live (2026-06-10): 14 fruitless scrolls — half because
    // the list was a nested container window-scroll can't reach, half
    // because the grounded scroll aimed at a screenshot of the WRONG tab
    // — on a page whose full content browser.read had already returned.
    const prevWasScroll = /^(browser_scroll_page|scroll|browser_scroll_element)$/.test(
      prevType,
    );
    if (browserSnapshot && prevWasScroll) {
      const scrollMovedSomething = !snapshotUnchanged || screenChanged;
      if (scrollMovedSomething) {
        scrollNoEffectStreak = 0;
      } else {
        scrollNoEffectStreak += 1;
        if (scrollNoEffectStreak >= 2 && !scrollBanned) {
          scrollBanned = true;
          const ban =
            "[note: SCROLLING IS DISABLED for this page — it moved nothing twice (the list is a nested container window-scroll can't reach, and/or the screenshot shows a different tab). STOP scrolling. Use browser.read to get the FULL page text in one shot (it returns ALL items, even off-screen ones), then ACT on a specific item — open it with browser.click <its ref> or browser.navigate to its edit URL.]";
          if (history[history.length - 1] !== ban) {
            history.push(ban);
            opts.onHistory?.(ban);
          }
          console.log(
            `[loop] ⛔ scroll banned for this subtask (${scrollNoEffectStreak} no-effect scrolls)`,
          );
        }
      }
    }

    // Action-effect feedback (2026-06-10): the loop KNOWS when the last
    // action changed nothing in the page DOM — say so, instead of letting
    // the planner repeat it forever (live: 15+ no-op window scrolls on a
    // page whose listing list is a NESTED scroll container).
    if (browserSnapshot && snapshotUnchanged && prevExecuted) {
      let effectNote: string | null = null;
      if (/^(browser_scroll_page|scroll)$/.test(prevType)) {
        // The scroll circuit breaker above owns the escalation; only emit
        // the soft hint while still under the ban threshold.
        effectNote = scrollBanned
          ? null
          : "[note: that scroll changed NOTHING in the page DOM. The list may be a nested scroll container (try: scroll down at <description of the list>) — but if the content is already loaded, STOP scrolling: use browser.read to capture the whole page, then ACT on a specific item.]";
      } else if (prevType === "browser_click" && !browserStalled) {
        effectNote =
          "[note: that browser.click changed nothing in the page DOM — the ref may be non-interactive or not the element you meant. Pick a DIFFERENT element, or use a vision click on what you can SEE in the screenshot.]";
      }
      if (
        effectNote &&
        history[history.length - 1] !== effectNote
      ) {
        history.push(effectNote);
        opts.onHistory?.(effectNote);
        console.log(`[loop] ⚠ no-effect feedback → planner (${prevType})`);
      }
    }
    if (browserStalled) {
      console.log(
        "[loop] 🪟 browser-stall: DOM unchanged but screen pixels moved — OS overlay likely (file picker / native dialog). Skipping router this step, going vision.",
      );
      // Phrased as a CONDITIONAL, not an assertion. The signal (DOM
      // frozen + pixels moved after a click) fires for real native
      // dialogs AND for no-op clicks on pages with animations /
      // lazy-loading thumbnails — asserting "a dialog IS open" poisoned
      // whole runs with a story that never happened (the planner kept
      // "driving" a dialog that didn't exist).
      pendingRouterHint =
        "The previous click changed screen pixels but NOT the page DOM. Two possibilities — check the SCREENSHOT to tell them apart: (a) a native OS dialog opened on top of Chrome (file picker / save dialog / system prompt) — if you SEE one, drive it with vision-grounded clicks ('click the Open button'), browser.* can't reach it; (b) no dialog visible — the click simply had no effect (the pixel change was animation/lazy-loading); do something DIFFERENT: a different element, a more specific URL, or check whether the step is already satisfied and emit DONE.";
    }
    // Skip the router on step 1 of an OS-level agent_do call. The
    // pendingRouterHint was seeded with the surface declaration before
    // the loop started; it'll get folded into the brain's prompt this
    // step. From step 2 onward the existing browserStalled detector
    // owns OS-overlay handling.
    const osSurfaceFirstStep =
      step === 0 &&
      opts.surface !== undefined &&
      opts.surface !== "chrome-page" &&
      opts.surface.length > 0;
    if (router && browserSnapshot && !browserStalled && !osSurfaceFirstStep) {
      const tRouter = Date.now();
      try {
        const decision = await router.decide({
          task: taskForPlanner,
          history,
          snapshot: browserSnapshot,
          snapshotUnchanged,
          signal: ctrl.signal,
        });
        const dt = Date.now() - tRouter;
        switch (decision.kind) {
          case "action": {
            console.log(`[router] (${dt}ms) → ${decision.action}`);
            // Circuit breaker (2026-06-10): the 0.8B router happily
            // re-emits an action that already FAILED — live-observed:
            // `browser.type e7 …` failed with "Element is not an
            // <input>" EIGHT times in a row, each failure SPA-bouncing
            // Facebook to a random reel, and the brain never got a
            // turn because the router runs first. If this normalized
            // action already failed ≥2 times in history, veto the
            // router for this step and hand the failure context to the
            // brain instead.
            const normalized = normalizeAction(decision.action);
            let priorFailures = 0;
            let lastFailure = "";
            for (const entry of history) {
              if (!entry.includes("[note: failed")) continue;
              const entryAction = entry.split("  [note:")[0] ?? "";
              if (normalizeAction(entryAction) === normalized) {
                priorFailures += 1;
                lastFailure = entry.slice(entry.indexOf("[note:"));
              }
            }
            if (priorFailures >= 2) {
              console.log(
                `[router] ⛔ vetoed — "${decision.action}" already failed ${priorFailures}× (${lastFailure.slice(0, 80)}). Forcing the brain this step.`,
              );
              pendingRouterHint =
                `The router keeps suggesting "${decision.action}" but it has FAILED ${priorFailures} times already ` +
                `(${lastFailure.slice(0, 140)}). Do something DIFFERENT: pick another element, navigate to a more ` +
                `specific URL, or use a keyboard path.`;
              break;
            }
            routerAction = decision.action;
            usedRouter = true;
            break;
          }
          case "done":
            console.log(`[router] (${dt}ms) → DONE`);
            await events.onThought("DONE (router)");
            // Same Ralph verifier path as brain DONE — the router's
            // judgement is based on the AX snapshot only (no screenshot),
            // so it's MORE likely than the brain to false-DONE on a UI
            // that visually contradicts the snapshot (animations, OS
            // overlays, race conditions). Skip when verifier disabled or
            // already attempted.
            if (!verificationAttempted && verifierEnabled()) {
              verificationAttempted = true;
              console.log("[loop] 🔍 verifying router DONE...");
              await events.onStatus("Verifying that the goal landed…");
              const verifyResult = await verify(provider, {
                task: taskForPlanner,
                screenshotB64: shot.png.toString("base64"),
                screen: screenSize,
                browserSnapshot,
                currentUrl,
                tabHidden: controlledTabHidden,
                signal: ctrl.signal,
              });
              if (cancelled()) return "cancelled";
              if (verifyResult.verified) {
                console.log("[loop] ✅ DONE (router, verified)");
                return "done";
              }
              const reason = verifyResult.reason ?? "no reason given";
              console.log(`[loop] ❌ verifier said retry — ${reason}`);
              const note = `[note: verifier said router DONE was wrong — ${reason}; reconsider state and continue]`;
              history.push(note);
              actionScreenHashes.push(screenHash);
              opts.onHistory?.(note);
              await events.onError(
                `Verifier rejected router DONE — ${reason}. Retrying once.`,
              );
              if (await interruptiblePause(stepPause, cancelled))
                return "cancelled";
              // Update prevSnapshotHash/prevScreenHash before continuing
              // so the next iteration's stall-detect compares against
              // current state.
              prevSnapshotHash = snapHash;
              prevScreenHash = screenHash;
              continue;
            }
            return "done";
          case "vision_needed":
            console.log(`[router] (${dt}ms) → VISION_NEEDED: ${decision.reason}`);
            pendingRouterHint = decision.reason;
            break;
          case "skip":
            console.log(`[router] (${dt}ms) → skip: ${decision.reason}`);
            // No hint — the reason is internal (timeout, model not pulled),
            // not useful for Holo3.
            break;
        }
      } catch (e) {
        console.warn(
          `[loop] router error (${e instanceof Error ? e.message : String(e)}) — falling through to vision`,
        );
      }
    }
    // Update the per-step hashes for the NEXT iteration's stall check.
    // Always update both: even if a snapshot wasn't captured this step,
    // the screenshot still moves the screen-hash forward.
    prevSnapshotHash = snapHash;
    prevScreenHash = screenHash;

    let action: string;
    // Pre-grounded click point from the combined plan+ground path
    // (think() → provider.step). When present for a mouse-aimed verb,
    // the dedicated ground call below is skipped entirely.
    let preGroundedCoords: { x: number; y: number } | null = null;
    if (routerAction) {
      // Fast path: the router gave us a usable action. Skip plan + ground.
      action = routerAction;
      await events.onThought(`(router) ${action}`);
      if (cancelled()) return "cancelled";
    } else {
      // Vision path: full Holo3 plan, optionally with the router's
      // escalation reason as context.
      const tPlan = Date.now();
      try {
        const thought = await think(provider, {
          task: taskForPlanner,
          history,
          screenshotB64: shot.png.toString("base64"),
          screen: screenSize,
          signal: ctrl.signal,
          browserSnapshot,
          routerHint: pendingRouterHint,
          currentUrl,
        });
        action = thought.action;
        preGroundedCoords = thought.coords;
        consecutiveProviderErrors = 0;
      } catch (e: unknown) {
        if (cancelled()) return "cancelled";
        consecutiveProviderErrors += 1;
        if (consecutiveProviderErrors >= 3) throw e;
        const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
        console.warn(
          `[loop] ⚠ plan call failed (${msg}) — transient ${consecutiveProviderErrors}/3, retrying next step`,
        );
        const note = `[note: the planning call failed with a transient error (${msg}) — nothing was executed; continue from the current screen state]`;
        history.push(note);
        opts.onHistory?.(note);
        if (await interruptiblePause(Math.max(stepPause, 1000), cancelled))
          return "cancelled";
        continue;
      }
      // Hint consumed — clear so it doesn't leak into the next step if the
      // router has nothing further to say.
      pendingRouterHint = undefined;
      console.log(`[loop] 🧠 plan (${Date.now() - tPlan}ms): ${action}`);
      await events.onThought(action);
      if (cancelled()) return "cancelled";
    }

    // Collect the overlapped completion probe (started before the plan
    // call above). A verified probe wins over whatever the brain planned
    // — the goal is already met, so the planned action would be a
    // post-success no-op (the exact failure mode the probe exists for).
    if (pendingProbe) {
      const settled = await pendingProbe;
      pendingProbe = null;
      if (cancelled()) return "cancelled";
      if (!settled.ok) throw settled.err;
      if (settled.goal.verified) {
        console.log(
          "[loop] ✅ completion probe: goal already achieved — the brain " +
            "didn't recognize completion; terminating as DONE (discarding " +
            "this step's planned action)",
        );
        await events.onStatus("Goal already met — finishing.");
        return probeGoal ? "goal_done" : "done";
      }
      if (settled.step?.verified) {
        console.log(
          "[loop] ✅ step probe: the CURRENT STEP's expected result is " +
            "already on screen — advancing (discarding this step's " +
            "planned action)",
        );
        await events.onStatus("Step already landed — advancing.");
        return "done";
      }
      console.log(
        `[loop] 🔁 completion probe: not done yet (${settled.goal.reason ?? "no proof"}) — continuing`,
      );
    }

    // Duplicate-note suppression (2026-06-10): notes are working memory,
    // not progress — but the planner can mistake emitting one for doing
    // Scroll-ban enforcement: once the circuit breaker fired (2 no-effect
    // scrolls), intercept any further scroll BEFORE it burns a step (a
    // grounded "scroll down at …" costs a 3–7s ground call to do nothing).
    // Redirect to browser.read / acting on a specific item.
    if (
      scrollBanned &&
      /^(scroll\b|browser\.scroll\b)/i.test(action.trim())
    ) {
      const ban =
        "[note: scrolling is DISABLED for this page (it moved nothing twice). Do NOT scroll. Use browser.read to capture the full page text, then ACT on a specific item (browser.click its ref, or browser.navigate to its edit URL).]";
      console.log(`[loop] ⛔ blocked banned scroll: ${action.slice(0, 50)}`);
      if (history[history.length - 1] !== ban) {
        history.push(ban);
        opts.onHistory?.(ban);
      }
      if (await interruptiblePause(stepPause, cancelled)) return "cancelled";
      continue;
    }

    // Duplicate-read suppression: re-reading a page whose text is already
    // in history is a no-op. Live (2026-06-10): browser.read fired 3× in a
    // row returning byte-identical content while the answer (every listing
    // + "0 clicks") sat unused. Catch the 2nd identical read and push the
    // planner toward acting on what it already has.
    if (/^browser\.read\b/i.test(action.trim()) && lastReadContent) {
      const nudge = `[note: you ALREADY read this page — its full text is in your history above (it lists every item, including ones off-screen). Re-reading returns the same bytes. ACT on it now: pick a specific item and open it (browser.click its ref, or browser.navigate to its edit URL).]`;
      console.log(`[loop] ⚠ duplicate browser.read suppressed`);
      if (history[history.length - 1] !== nudge) {
        history.push(nudge);
        opts.onHistory?.(nudge);
      }
      if (await interruptiblePause(stepPause, cancelled)) return "cancelled";
      continue;
    }

    // something and loop on it (live: the SAME note 6× in 13 steps while
    // zero screen actions happened). An identical note in the recent
    // history is suppressed with a pointed nudge instead of executed.
    if (/^note\s/i.test(action.trim())) {
      // Echo trap: the planner can mistake a SYSTEM [note: …] history
      // entry for text it should repeat — live trace: it emitted
      // note "already at …/you/selling — the navigate was skipped…"
      // VERBATIM from the harness's own skip-note, three steps in a
      // row. A note that quotes recent system notes is suppressed
      // before the regular duplicate check (the FIRST echo isn't a
      // duplicate of any prior note ACTION, so that check misses it).
      const noteText = action
        .trim()
        .replace(/^note\s+["“']?/i, "")
        .replace(/["”']\s*$/, "")
        .toLowerCase();
      const probe = noteText.slice(0, 60);
      const echoed =
        probe.length >= 20 &&
        history
          .slice(-8)
          .some(
            (h) => h.startsWith("[note:") && h.toLowerCase().includes(probe),
          );
      if (echoed) {
        // Page-aware: if the page is already read, the one right move is
        // to OPEN an item — say so explicitly, else a weak planner falls
        // back to another browser.read (converges eventually via the
        // dup-read guard, but a step slower).
        const nudge = lastReadContent
          ? "[note: you ECHOED a system note back — never repeat [note: …] history entries. You already read this page; do NOT read again. Your NEXT action MUST open a specific item: browser.click <eN> from the snapshot, or browser.navigate to an item's edit URL.]"
          : "[note: you ECHOED a system note back — [note: …] entries in history are observations addressed to YOU, never text to repeat. Take a SCREEN ACTION now (browser.read to see the page, then act), or emit DONE if the state already satisfies the step.]";
        console.log(`[loop] ⚠ echoed system note suppressed`);
        if (history[history.length - 1] !== nudge) {
          history.push(nudge);
          opts.onHistory?.(nudge);
        }
        if (await interruptiblePause(stepPause, cancelled)) return "cancelled";
        continue;
      }
      const normalizedNote = normalizeAction(action);
      const recentDup = history
        .slice(-6)
        .some((h) => normalizeAction(h.split("  [note:")[0] ?? "") === normalizedNote);
      if (recentDup) {
        const nudge =
          "[note: duplicate note suppressed — you already recorded exactly this. A note is NOT progress. Take a SCREEN ACTION now: click/open the next item, or if you are stuck, do the FIRST concrete sub-action of your own note.]";
        console.log(`[loop] ⚠ duplicate note suppressed`);
        if (history[history.length - 1] !== nudge) {
          history.push(nudge);
          opts.onHistory?.(nudge);
        }
        if (await interruptiblePause(stepPause, cancelled)) return "cancelled";
        continue;
      }
      // Consecutive-note (narration) guard. Duplicate-suppression only
      // catches IDENTICAL notes; a weak planner narrates its plan as a
      // FRESH note each step ("the task is…", "I need to…") and spins
      // without ever acting. If the planner's OWN previous action was
      // also a note (planner notes land in history as `note "…"`; system
      // notes as `[note: …]`) and THIS note records no completed progress,
      // it's thinking-out-loud — suppress with a hard act-directive.
      const prevWasPlannerNote = /^note\s/i.test(
        (history[history.length - 1] ?? "").trim(),
      );
      const recordsProgress =
        /\b(done|edited|saved|completed|finished|updated|\d+\s*(of|\/)\s*\d+)\b/i.test(
          normalizedNote,
        );
      if (prevWasPlannerNote && !recordsProgress) {
        const nudge = lastReadContent
          ? "[note: TWO notes in a row with no action — you are narrating, not working. You already read this page; do NOT read again and do NOT note. This turn MUST open the next item: browser.click <eN> from the snapshot, or browser.navigate to its edit URL — or emit DONE if every item is handled.]"
          : "[note: TWO notes in a row with no action — you are narrating, not working. STOP. This turn MUST be a concrete action (browser.read to see the page, then act on a specific item).]";
        console.log(`[loop] ⚠ consecutive narration-note suppressed`);
        if (history[history.length - 1] !== nudge) {
          history.push(nudge);
          opts.onHistory?.(nudge);
        }
        if (await interruptiblePause(stepPause, cancelled)) return "cancelled";
        continue;
      }
    }

    if (isDone(action)) {
      // Fabricated-completion guard. A weak planner writes fictional
      // progress notes ("done 4 of 4: all processed") and emits DONE
      // having actually changed NOTHING — live + headless: it claimed
      // all listings edited after 0 browser.type actions. For a task
      // that asks to modify EACH/EVERY/ALL items, DONE with zero
      // committed edits is provably false; reject it once and point at
      // the real work. (overallGoal carries the user's phrasing even
      // inside a decomposed sub-step.)
      // Require BOTH a multi-item scope (each/every/all) AND an explicit
      // EDIT verb in the goal — otherwise a pure multi-item LOOKUP ("find
      // all my listings", "check each price") has no edits to commit and
      // would be wrongly blocked (review 2026-06-11).
      const goalText = opts.overallGoal ?? opts.task ?? "";
      const multiItemGoal = /\b(each|every|all)\b/i.test(goalText);
      const editGoal =
        /\b(change|edit|update|modify|set|replace|rename|rewrite|adjust|fix|add|remove|delete|append|reword|revise)\b/i.test(
          goalText,
        );
      if (
        multiItemGoal &&
        editGoal &&
        editActions === 0 &&
        !fabricatedDoneRejected
      ) {
        fabricatedDoneRejected = true;
        const note = `[note: you claimed DONE but have made ZERO actual changes — you have not typed into a single item's form yet (a progress note is not an edit). The task is to change EACH item. OPEN the first item (browser.navigate to its edit URL, or browser.click its ref / its More-options→"Edit listing"), browser.type the change, and save. Do NOT emit DONE again until you have actually edited items.]`;
        console.warn(
          `[loop] ⛔ fabricated DONE rejected — 0 edits committed on an each/all task`,
        );
        history.push(note);
        actionScreenHashes.push(screenHash);
        opts.onHistory?.(note);
        if (await interruptiblePause(stepPause, cancelled)) return "cancelled";
        continue;
      }
      // Ralph verifier — confirm the goal actually landed before
      // returning. Skipped if disabled (PONDER_VERIFIER=off) or if
      // we already gave the brain one chance to correct itself.
      if (!verificationAttempted && verifierEnabled()) {
        verificationAttempted = true;
        console.log("[loop] 🔍 verifying claimed DONE...");
        await events.onStatus("Verifying that the goal landed…");
        const verifyResult = await verify(provider, {
          task: taskForPlanner,
          screenshotB64: shot.png.toString("base64"),
          screen: screenSize,
          browserSnapshot,
          currentUrl,
          tabHidden: controlledTabHidden,
          signal: ctrl.signal,
        });
        if (cancelled()) return "cancelled";
        if (verifyResult.verified) {
          console.log("[loop] ✅ DONE (verified)");
          return "done";
        }
        // Verifier rejected DONE — push a [note: …] and run one more
        // iteration so the brain can react. Don't push a "DONE" history
        // entry; the brain should produce a fresh action.
        const reason = verifyResult.reason ?? "no reason given";
        console.log(`[loop] ❌ verifier said retry — ${reason}`);
        const note = `[note: verifier said the goal is NOT yet achieved — ${reason}; reconsider state and continue]`;
        history.push(note);
        actionScreenHashes.push(screenHash);
        opts.onHistory?.(note);
        await events.onError(
          `Verifier rejected the claimed DONE — ${reason}. Retrying once.`,
        );
        if (await interruptiblePause(stepPause, cancelled)) return "cancelled";
        continue;
      }
      console.log("[loop] ✅ DONE");
      return "done";
    }

    // INFEASIBLE — the mirror of DONE. The brain claims the task can't
    // be done. Gate it on verifyInfeasible() so a premature / loose
    // claim (small model dropped rule 3's "only if" and gave up early)
    // doesn't strand a doable task. Same one-verify-then-trust shape as
    // DONE: a second INFEASIBLE after a rejection is trusted, so the
    // brain can't be argued with forever.
    if (isInfeasible(action)) {
      const claimed = infeasibleReason(action);
      if (!infeasibilityAttempted && verifierEnabled()) {
        infeasibilityAttempted = true;
        console.log(`[loop] 🚫 brain claims INFEASIBLE — verifying: ${claimed}`);
        await events.onStatus("Double-checking the task is truly impossible…");
        const check = await verifyInfeasible(provider, {
          task: taskForPlanner,
          claimedReason: claimed,
          screenshotB64: shot.png.toString("base64"),
          screen: screenSize,
          browserSnapshot,
          currentUrl,
          signal: ctrl.signal,
        });
        if (cancelled()) return "cancelled";
        if (check.confirmed) {
          const why = check.reason ?? claimed;
          console.log(`[loop] 🚫 INFEASIBLE confirmed — ${why}`);
          await events.onError(`INFEASIBLE: ${why}`);
          return "infeasible";
        }
        const note = `[note: that is NOT impossible — no concrete blocker is visible on screen; do NOT give up, try a different approach]`;
        console.log(`[loop] ↩ infeasible rejected — ${note}`);
        history.push(note);
        actionScreenHashes.push(screenHash);
        opts.onHistory?.(note);
        await events.onError(
          "Claimed the task is impossible but no concrete blocker is visible — continuing.",
        );
        if (await interruptiblePause(stepPause, cancelled)) return "cancelled";
        continue;
      }
      // Verifier disabled, or the one check was already spent and the
      // brain re-asserted INFEASIBLE — trust it (mirrors DONE).
      console.log(`[loop] 🚫 INFEASIBLE — ${claimed}`);
      await events.onError(`INFEASIBLE: ${claimed}`);
      return "infeasible";
    }

    // Empty plan → don't waste a ground/exec round-trip (and don't tick the
    // rate limit needlessly). This previously cascaded into a failed ground +
    // a "no executor matched" warn; now we surface it loudly and skip ahead.
    if (!action.trim()) {
      console.warn("[loop] ⚠ empty plan — skipping step (provider returned no action)");
      await events.onError(
        "Provider returned an empty action. " +
          (provider.name === "hcompany"
            ? "The model may have been mid-reasoning when truncated; check chat_template_kwargs.enable_thinking and max_tokens."
            : "Check the provider response."),
      );
      history.push("[note: empty action emitted]");
      actionScreenHashes.push(screenHash);
      // Two empty plans in a row = the model is stuck. Bail rather than
      // burn through 30 steps doing nothing.
      if (
        history.length >= 2 &&
        history.at(-2) === "[note: empty action emitted]"
      ) {
        console.warn("[loop] 🛑 two consecutive empty plans — stopping");
        await events.onError("Model returned empty actions twice in a row — stopping.");
        return "exhausted";
      }
      if (await interruptiblePause(stepPause, cancelled)) return "cancelled";
      continue;
    }

    // Brain-output validator. The Holo3 brain occasionally regurgitates
    // prompt boilerplate as if it were an action ("The last step was
    // incorrect. The current step is:" — observed in the Bulbasaur
    // trace). Without a validator, the loop tries to vision-ground that
    // prose, burning ~1s on a wrong ground and emitting a click at a
    // random coordinate. The allow-list (click / type / press / hotkey
    // / drag / scroll / wait / done / browser.*) is the same set the
    // executor knows how to dispatch; if the brain emits anything else
    // we record a [note: …] and re-prompt rather than execute.
    if (!isValidAction(action)) {
      console.warn(
        `[loop] ⚠ invalid brain output: ${action.slice(0, 100)}`,
      );
      await events.onError(
        `Brain emitted unparseable action: "${action.slice(0, 100)}". ` +
          "Treating as no-op and re-prompting.",
      );
      const note = `[note: brain emitted unparseable action — ${action.slice(0, 80)}]`;
      history.push(note);
      actionScreenHashes.push(screenHash);
      opts.onHistory?.(note);
      // Two consecutive invalid outputs = the model is structurally
      // confused (likely stuck mid-reasoning, or system prompt drift).
      // Bail cleanly rather than spin.
      const prev = history.at(-2);
      if (prev?.startsWith("[note: brain emitted unparseable action")) {
        console.warn(
          "[loop] 🛑 two consecutive invalid brain outputs — stopping",
        );
        await events.onError(
          "Brain returned unparseable output twice in a row — stopping.",
        );
        return "exhausted";
      }
      if (await interruptiblePause(stepPause, cancelled)) return "cancelled";
      continue;
    }

    // Failed-action circuit breaker (2026-06-10): the SAME action that
    // already FAILED twice does not get a third execution — live trace:
    // `browser.click "Modal"` crashed the locator 9 times across two
    // attempts because failure notes alone didn't deter the planner.
    // (The router has its own breaker; this one covers brain/planner
    // actions, and fires BEFORE grounding so a banned action costs
    // nothing.)
    {
      const normalizedAct = normalizeAction(action);
      // Modality swap: a banned browser.click is the ONE ban with a
      // mechanical escape — the snapshot line carries the element's
      // role+name, so the same intent can be re-expressed as a VISION
      // click and grounded from pixels. The MODALITY ARBITRATION prompt
      // told the planner to switch when DOM clicks change nothing; live
      // trace: it re-emitted browser.click e20 through the ban three
      // times instead. Now the harness performs the switch itself. One
      // swap per ref per subtask — if vision ALSO can't move the page,
      // the normal failure machinery takes over.
      const trySwapBannedClick = (): boolean => {
        const ref = action.match(/^browser\.click\s+(e\d+)\s*$/i)?.[1];
        if (!ref || !browserSnapshot || swappedClickRefs.has(ref))
          return false;
        const line = browserSnapshot.ax
          .split("\n")
          .find((l) => l.trimStart().startsWith(`[${ref}]`));
        const desc = line
          ?.replace(/^\s*\[e\d+\]\s*/, "")
          .replace(/\s+/g, " ")
          .trim();
        if (!desc) return false;
        swappedClickRefs.add(ref);
        const swap = `[note: browser.click ${ref} keeps having no effect — switching modality: VISION click on ${desc.slice(0, 120)}]`;
        if (history[history.length - 1] !== swap) {
          history.push(swap);
          opts.onHistory?.(swap);
        }
        console.log(
          `[loop] 🔁 modality swap: banned browser.click ${ref} → click ${desc.slice(0, 80)}`,
        );
        action = `click ${desc.slice(0, 120)}`;
        return true;
      };
      let failCount = 0;
      let lastFail = "";
      for (const entry of history) {
        if (!entry.includes("[note: failed")) continue;
        if (
          normalizeAction(entry.split("  [note:")[0] ?? "") === normalizedAct
        ) {
          failCount += 1;
          lastFail = entry.slice(entry.indexOf("[note:")).slice(0, 160);
        }
      }
      // A click can be "failing" two ways: throwing on execution
      // ([note: failed] entries → failCount) or executing cleanly with
      // zero DOM effect (noEffectClickRefs). Both mean the DOM path to
      // this element is dead — same ban, same modality swap.
      const banRef = action.match(/^browser\.click\s+(e\d+)\s*$/i)?.[1];
      const noFxCount = banRef ? (noEffectClickRefs.get(banRef) ?? 0) : 0;
      if ((failCount >= 2 || noFxCount >= 2) && !trySwapBannedClick()) {
        const why = lastFail || `clicking it changed NOTHING in the page DOM ${noFxCount} times`;
        const ban = `[note: BANNED — "${action.slice(0, 80)}" has now failed ${Math.max(failCount, noFxCount)} times (${why}). It will not be executed again. Do something STRUCTURALLY different: a different element ref from the snapshot, a vision click on what you SEE, a keyboard path, or a more specific URL.]`;
        console.warn(
          `[loop] ⛔ banned repeatedly-failing action: ${action.slice(0, 80)} (${failCount} exec failures, ${noFxCount} no-effect clicks)`,
        );
        if (history[history.length - 1] !== ban) {
          history.push(ban);
          opts.onHistory?.(ban);
        }
        if (++consecutiveBans >= 3) {
          console.warn(
            `[loop] 🛑 ${consecutiveBans} consecutive banned actions — the planner has no viable move for this step. Bailing early so the plan layer can retry/revise.`,
          );
          return "exhausted";
        }
        if (await interruptiblePause(stepPause, cancelled)) return "cancelled";
        continue;
      }
      // Futile-toggle ban: a KEYBOARD action repeated 4+ times in the
      // recent window "succeeds" every time yet advances nothing — the
      // canonical case is cmd+space TOGGLING Spotlight open/closed
      // forever (each press changes pixels, so the "screen IS changing"
      // exemption in guard #1 never fires; live trace: 10 presses
      // across two sub-step attempts). Coordinate actions are exempt
      // (legitimate re-grounds repeat); the planner has "press KEY N
      // times" for honest repetition.
      if (!needsCoordinates(action)) {
        const repeats = history
          .slice(-8)
          .filter(
            (h) =>
              normalizeAction(h.split("  [note:")[0] ?? "") === normalizedAct,
          ).length;
        if (repeats >= 4 && !trySwapBannedClick()) {
          const ban = `[note: BANNED — "${action.slice(0, 60)}" has been executed ${repeats} times recently with no progress; it is likely TOGGLING something open and closed. Do something STRUCTURALLY different (a click, a navigate, or simply DONE if the goal is already met).]`;
          console.warn(
            `[loop] ⛔ banned futile keyboard repeat: ${action.slice(0, 60)} (${repeats}× recently)`,
          );
          if (history[history.length - 1] !== ban) {
            history.push(ban);
            opts.onHistory?.(ban);
          }
          if (++consecutiveBans >= 3) {
            console.warn(
              `[loop] 🛑 ${consecutiveBans} consecutive banned actions — the planner has no viable move for this step. Bailing early so the plan layer can retry/revise.`,
            );
            return "exhausted";
          }
          if (await interruptiblePause(stepPause, cancelled))
            return "cancelled";
          continue;
        }
      }
    }

    // Anti-loop guard #0: disabled-ref rejection.
    //
    // Catches the most expensive class of agent loop: the planner emits
    // browser.click on a ref that the snapshot just flagged as "(disabled)"
    // (Facebook Marketplace's Apply button while no location suggestion is
    // picked, etc.). Without this guard, Playwright's locator.click waits
    // 5s for the element to become enabled, times out, and the planner
    // re-emits the same disabled click on the next step — burning ~15s
    // before guard #1's 3-of-4-repeats threshold catches it.
    //
    // We catch it on attempt 1 (~0ms cost) by parsing the action and
    // searching the latest snapshot's AX text for "[ref] ... (disabled)".
    // On a hit:
    //   • First strike: log, surface a recovery message, push a synthetic
    //     history line ("(rejected: ...)" — shaped to NOT normalize-equal
    //     the original action, so guard #1 still detects genuine repeats),
    //     brief sleep so the dropdown can finish rendering, continue.
    //   • Second strike on the SAME ref: the model is structurally confused
    //     about prerequisites and re-snapshotting hasn't unstuck it. Bail
    //     with onError before we waste more cycles.
    const browserAct = parseBrowserAction(action);

    // Save-before-type guard. A weak planner reaches an edit form and
    // clicks the Save/Submit button WITHOUT first typing the change —
    // saving an unchanged form does nothing, and the run then thrashes
    // (live + headless: More-options→Edit listing→click Save, 0 edits).
    // If this action clicks a button whose snapshot name is a save/submit
    // verb, the form has a text field, and we have NOT typed on this URL
    // this visit, block it and tell the planner to type first.
    // NARROWLY SCOPED (review 2026-06-11 caught 3 false-positive classes):
    //   • only on an actual EDIT FORM — URL contains "/edit" or the tab
    //     title starts with "Edit". This excludes search/filter/results
    //     pages (the FB "Apply" location-filter flow, post-search-redirect
    //     pages) where a Save-ish button + a stray search field would
    //     otherwise misfire.
    //   • save verb is STRICT (save / publish / "post changes") — NOT
    //     "apply" / "done" / "update" / generic "submit" (those are
    //     filter/search/affirmation verbs).
    //   • capped at 2 blocks per subtask so it can never thrash a run.
    if (
      browserAct?.kind === "click" &&
      browserSnapshot &&
      saveBeforeTypeBlocks < 2
    ) {
      const url = browserSnapshot.url.toLowerCase();
      const title = (browserSnapshot.title ?? "").toLowerCase();
      const onEditForm = /\/edit\b|[?&]edit=/.test(url) || /^edit\b/.test(title);
      const refLine = browserSnapshot.ax
        .split("\n")
        .find((l) => l.trimStart().startsWith(`[${browserAct.ref}]`));
      const isSaveButton =
        refLine !== undefined &&
        /\bbutton\b/i.test(refLine) &&
        /\b(save|publish)\b|\bpost\s+changes\b/i.test(refLine);
      const typedHere = lastTypedUrl !== null && lastTypedUrl === browserSnapshot.url;
      if (onEditForm && isSaveButton && !typedHere) {
        saveBeforeTypeBlocks += 1;
        const note = `[note: do NOT click Save yet — you have not typed the change into THIS edit form. Saving an unchanged form does nothing. FIRST: browser.type <the description/text field's eN> "your new value" and press enter (that often saves on its own); only click Save if pressing enter did not.]`;
        console.warn(
          `[loop] ⛔ save-before-type blocked: ${action.slice(0, 50)} (edit form, no type on ${browserSnapshot.url})`,
        );
        if (history[history.length - 1] !== note) {
          history.push(note);
          opts.onHistory?.(note);
        }
        if (await interruptiblePause(stepPause, cancelled)) return "cancelled";
        continue;
      }
    }

    // Auto-DONE: navigate-to-current-URL.
    //
    // If the brain emits browser.navigate <Y> and the snapshot URL
    // already canonical-matches Y, the subtask "navigate to X" is
    // functionally complete. Re-issuing the navigate either no-ops
    // (wasted Playwright reload) or fires the same redirect again —
    // either way, no progress, and after 3 same-actions guard #1 kills
    // the run, which aborts the remaining subtasks. That's exactly
    // what kept happening on "Open Chrome and navigate to
    // facebook.com/marketplace": step 2 navigated successfully, but
    // the small model didn't recognize completion, re-emitted the
    // navigate twice more, and the WHOLE plan died after subtask 1.
    //
    // Returning "done" here advances to the next subtask. Safer than
    // it sounds: the brain explicitly emitted "navigate to Y" — its
    // intent is "be at Y" — and we ARE at Y. The only edge case
    // (hard refresh) is uncommon and recoverable via hotkey cmd+r;
    // nobody uses browser.navigate to refresh.
    if (browserAct?.kind === "navigate" && browserSnapshot) {
      const target = canonicalizeUrl(browserAct.url);
      const current = canonicalizeUrl(browserSnapshot.url);
      if (target && current && target === current) {
        // Composite mode (2026-06-10): no BLIND auto-DONE — it once
        // killed a 50-step run at step 5, OVERRIDING a completion probe
        // that had just correctly said RETRY. But pure skip-and-note is
        // equally fatal in DECOMPOSE mode: when the sub-step's
        // PRESCRIBED action IS this navigate and we're already at the
        // URL, the step is functionally complete, yet nothing could
        // ever finish it — live trace: 16 redundant navigates across
        // two 8-step budgets while the "do ONLY this step" contract and
        // the skip-note's "continue with the NEXT part" pulled the
        // planner in opposite directions.
        //
        // Resolution: treat the FIRST redundant navigate per URL as a
        // claimed DONE and let the VERIFIER arbitrate against the
        // current task (in decompose mode that's the step contract with
        // its expect — "Marketplace page is displayed" → VERIFIED →
        // advance; in a flat run the whole-goal check correctly says
        // RETRY and we fall through to the note).
        if (provider.name === "composite") {
          if (verifierEnabled() && !verifyGatedNavUrls.has(target)) {
            verifyGatedNavUrls.add(target);
            console.log(
              `[loop] ↪ already at ${browserAct.url} — treating the redundant navigate as a DONE claim, verifying…`,
            );
            const verifyResult = await verify(provider, {
              task: taskForPlanner,
              screenshotB64: shot.png.toString("base64"),
              screen: screenSize,
              browserSnapshot,
              currentUrl,
              tabHidden: controlledTabHidden,
              signal: ctrl.signal,
            });
            if (cancelled()) return "cancelled";
            if (verifyResult.verified) {
              console.log(
                `[loop] ✅ already at ${browserAct.url} — verified DONE`,
              );
              await events.onStatus(`Already at ${browserAct.url}.`);
              return "done";
            }
            console.log(
              `[loop] ↪ verifier kept the run going — ${verifyResult.reason ?? "no reason"}`,
            );
          }
          const navCount = (redundantNavCounts.get(target) ?? 0) + 1;
          redundantNavCounts.set(target, navCount);
          // Escalate: a soft "continue" note didn't stop the planner from
          // re-navigating to the page it was already on (5× live). After
          // the 2nd redundant navigate, give a hard directive that names
          // the concrete next moves and forbids navigating here again.
          // The escalated directive gives ONE clear instruction — a weak
          // planner freezes into a reasoning-note when handed a fork
          // ("open an item OR read"). Pick the single right move from
          // whether a read has already happened this subtask.
          const haveRead = lastReadContent !== null;
          const note =
            navCount >= 2
              ? haveRead
                ? `[note: you are ALREADY on ${browserAct.url} — navigated here ${navCount} times, it does NOTHING, and you have already read it. STOP navigating and STOP noting. Your NEXT action MUST be a single browser.click <eN> on an item's ref from the snapshot (or browser.navigate to an item's OWN edit URL from the page text). Re-navigating to THIS url is forbidden.]`
                : `[note: you are ALREADY on ${browserAct.url} — navigated here ${navCount} times, it does NOTHING. STOP navigating and STOP noting. Your NEXT action MUST be exactly: browser.read — that returns the item list so you can act on it. Re-navigating to THIS url is forbidden.]`
              : `[note: already at ${browserAct.url} — the navigate was skipped as a no-op. If your CURRENT STEP was exactly this navigate, it is ALREADY SATISFIED: emit DONE. Otherwise inspect the page (browser.read once) then OPEN a specific item.]`;
          console.log(
            `[loop] ↪ already at ${browserAct.url} — skipping redundant navigate #${navCount} (composite mode: no blind auto-DONE)`,
          );
          history.push(note);
          actionScreenHashes.push(screenHash);
          opts.onHistory?.(note);
          prevSnapshotHash = snapHash;
          prevScreenHash = screenHash;
          if (await interruptiblePause(stepPause, cancelled))
            return "cancelled";
          continue;
        }
        console.log(
          `[loop] ✅ already at ${browserAct.url} — auto-DONE for subtask`,
        );
        await events.onStatus(`Already at ${browserAct.url}.`);
        return "done";
      }
    }

    // Anti-loop guard #0c: rejected-navigate-URL guard.
    //
    // If the action is browser.navigate <Y> and canonical(Y) is in
    // rejectedNavigateUrls (we've already navigated to it once and the
    // site redirected us elsewhere), don't fire it. Re-emitting would
    // either redirect again (wasted step + Playwright load time) or
    // succeed harmlessly (we're already at the redirected destination)
    // — either way, no progress. Annotate history with a rejection note
    // and continue so the brain re-plans from the current page.
    //
    // We DON'T cap strikes here the way disabled-ref does — repeated
    // navigates aren't dangerous, just wasteful. If the brain keeps
    // emitting them, guard #1's 3-of-4 normalized-action check
    // eventually kills the run anyway.
    if (browserAct?.kind === "navigate") {
      const target = canonicalizeUrl(browserAct.url);
      if (target && rejectedNavigateUrls.has(target)) {
        console.warn(
          `[loop] 🚫 navigate rejected: ${browserAct.url} was redirected on a previous attempt`,
        );
        await events.onError(
          `Skipping navigate to ${browserAct.url} — the site redirected this URL once already. ` +
            `Working from the current page instead.`,
        );
        // [note: …] shape (was "(rejected: …)"). The brain previously
        // sometimes echoed parenthetical history entries verbatim into
        // its next plan output (the "The last step was incorrect…" loop
        // observed in the Bulbasaur trace). The bracket-prefixed shape
        // makes it unambiguous to the prompt that this is a system
        // observation, not a prior action.
        const synthetic = `[note: skipped re-navigate to ${browserAct.url} — site redirected this URL on a prior attempt]`;
        history.push(synthetic);
        actionScreenHashes.push(screenHash);
        opts.onHistory?.(synthetic);
        onStep?.();
        await screen.sleep(400);
        if (cancelled()) return "cancelled";
        continue;
      }
    }

    if (browserAct?.kind === "click" && browserSnapshot) {
      const ref = browserAct.ref;
      // Anchor to start of line so we don't false-match on a line that
      // happens to mention "(disabled)" in its name. The flag suffix is
      // emitted by playwriter.ts/SNAPSHOT_SCRIPT and only appears in that
      // role-flag position, so the line-shape is unambiguous.
      const disabledRe = new RegExp(
        `^\\[${ref}\\][^\\n]*\\(disabled\\)\\s*$`,
        "m",
      );
      if (disabledRe.test(browserSnapshot.ax)) {
        const strike = (disabledRejectCount.get(ref) ?? 0) + 1;
        disabledRejectCount.set(ref, strike);
        console.warn(
          `[loop] 🚫 disabled-ref rejected: ${ref} (strike ${strike}/2)`,
        );
        if (strike >= 2) {
          await events.onError(
            `Tried to click disabled ${ref} twice. A prerequisite step ` +
              `(likely picking an autocomplete suggestion from the dropdown) ` +
              `was missed. Stopping.`,
          );
          return "exhausted";
        }
        await events.onError(
          `Skipping click on disabled ${ref}. Pick a suggestion from the ` +
            `dropdown first — the Apply/Submit button un-disables once a ` +
            `valid option is selected.`,
        );
        const synthetic = `[note: skipped click on disabled ${ref} — pick a suggestion ref first]`;
        history.push(synthetic);
        actionScreenHashes.push(screenHash);
        opts.onHistory?.(synthetic);
        onStep?.();
        // Brief OS settle so any late-arriving dropdown render lands
        // before the next snapshot. Don't pay the full stepPause here —
        // we want recovery to feel snappy (the user just saw an error
        // message; another 6.5s of silence makes it look frozen).
        await screen.sleep(800);
        if (cancelled()) return "cancelled";
        continue;
      }
    }

    // Anti-loop guard #1: if the SAME normalized action was emitted three
    // times in the last four steps AND the screen pixels weren't changing
    // across those repeats, the agent is genuinely stuck (clicking the
    // same icon over and over because nothing's changing on screen).
    // Normalization makes this resilient to trivial drift like "click
    // the search bar" vs "click the search bar." (trailing period).
    //
    // Screen-aware: previously we bailed on action-repeat alone, which
    // killed working flows where the screen WAS changing under the
    // surface (file picker selecting rows, autocomplete filtering, list
    // updating). The Bulbasaur upload trace was the canonical example —
    // three identical "click on the Screenshot…PM.png file" emissions
    // while the file was actually being selected; legacy guard fired
    // and reported a stuck loop on a flow that was making progress.
    // Now we also require that the last 3 emissions all happened from
    // the SAME screen hash (no pixel change). If the screen's moving,
    // we let it ride.
    const normNow = normalizeAction(action);

    // Anti-loop guard #0: NO-OP-SPAM detection.
    //
    // The May-11 bench showed two failure modes the legacy same-action
    // guard handles slowly:
    //   (a) Wait spam — "wait 1s" emitted 8 times after a failed action.
    //       The brain hopes the screen will change on its own.
    //   (b) Enter spam — "press enter" / "key enter" emitted 6 times
    //       after the page already navigated successfully. The brain
    //       doesn't recognize that the goal LANDED and keeps poking.
    //
    // Both are "no-op-like" verbs that shouldn't realistically repeat
    // 3+ times in a row in a healthy run. Press-enter chains do happen
    // legitimately (submit form A, then form B) but those bring screen
    // changes between hits — the same-action guard would fire on the
    // screen-hash check. THIS guard's job is to catch the case where
    // the brain keeps emitting a keyboard no-op while ALSO not learning
    // anything (no useful state to observe).
    //
    // Pattern: classify the action as `wait`/`press enter`/`press
    // escape`/`key enter`/`key escape` (the "I'm just hoping" verbs)
    // and bail after 3 in a row, regardless of screen-hash. Saves 5
    // dead-time steps vs the legacy 8-step grind.
    const NO_OP_ISH = /^(wait\b|press\s+(enter|escape|esc)\b|key\s+\{?\s*"?combo"?\s*:?\s*"?(enter|escape|esc)\b)/i;
    const isNoOpAction = NO_OP_ISH.test(normNow);
    if (isNoOpAction && history.length >= 2) {
      const prev1 = normalizeAction(history[history.length - 1]!);
      const prev2 = normalizeAction(history[history.length - 2]!);
      if (NO_OP_ISH.test(prev1) && NO_OP_ISH.test(prev2)) {
        console.warn(
          `[loop] 🛑 anti-loop (no-op-spam): 3 consecutive no-op-like actions (wait / press enter / press escape). The brain has stalled or doesn't realize the goal already landed. Bailing instead of paying more dead time.`,
        );
        await events.onError(
          `Brain emitted no-op-like actions (wait / press enter / press escape) 3 times in a row — either it's stalled, OR the goal already landed and it didn't notice. ` +
            `Look at the current screenshot AND the URL — has the page navigated? Has a result/dialog appeared? If yes, emit DONE. ` +
            `If no, the prior action didn't fire — pick a different verb (click on a specific labeled element instead of blindly pressing keys).`,
        );
        return "exhausted";
      }
    }

    const last4 = history.slice(-3).map(normalizeAction).concat(normNow);
    const same = last4.filter((h) => h === normNow).length;
    if (last4.length === 4 && same >= 3) {
      const recentHashes = actionScreenHashes.slice(-3);
      const screensIdentical =
        recentHashes.length === 3 &&
        recentHashes.every((h) => h === screenHash);
      if (screensIdentical) {
        // Hierarchical retry: instead of bailing immediately, give the
        // brain ONE chance to course-correct by force-resnapshotting
        // and pushing a strong [note: …] that names the failure mode.
        // If the next iteration emits the same action again, then we
        // bail for real. This converts the anti-loop cliff into a
        // single recovery step.
        if (!hardRetryAttempted) {
          hardRetryAttempted = true;
          console.warn(
            `[loop] ⚠ anti-loop wants to bail (action "${action}" repeated ${same}/4 + screen unchanged) — trying ONE hierarchical recovery first`,
          );
          await events.onStatus(
            "Stuck — re-observing state and asking the brain to change approach…",
          );
          // Drop the prefetched screenshot so step N+1 takes a fresh
          // capture (don't trust the cached one — we want certainty
          // the screen really hasn't changed, not a 250ms-old read).
          prefetched = null;
          // Push a forceful note. The brain will see this on its next
          // plan() call and (hopefully) emit a different verb.
          const note =
            `[note: STUCK — same action "${action}" was emitted ${same} of the last 4 steps with no visible screen change. ` +
            `The current target is NOT working. DO NOT repeat this action. ` +
            `Try a DIFFERENT approach: switch verbs (mouse↔keyboard), pick a different target ref, ` +
            `scroll to reveal what's hidden, press esc to dismiss any blocker, or emit DONE if the goal is already satisfied.]`;
          history.push(note);
          actionScreenHashes.push(screenHash);
          opts.onHistory?.(note);
          // Reset the action's prevSnapshotHash/prevScreenHash so the
          // next step's stall-detect compares against current state,
          // not the pre-stuck state.
          prevSnapshotHash = snapHash;
          prevScreenHash = screenHash;
          // Brief settle then continue. Don't pay full stepPause here
          // because this is a recovery step — the user is already
          // waiting on stuck behavior; another 6.5s of silence makes
          // it worse.
          await screen.sleep(400);
          if (cancelled()) return "cancelled";
          continue;
        }
        console.warn(
          `[loop] 🛑 anti-loop: action "${action}" repeated ${same}/4 times AND screen unchanged AFTER recovery attempt — stopping`,
        );
        await events.onError(
          `Stuck in a loop after one recovery attempt: "${action}" was emitted ${same} of the last 4 steps with no screen change. ` +
            "The brain didn't switch strategy when prompted. Bailing.",
        );
        return "exhausted";
      }
      // Screen is changing — but is the brain actually making progress,
      // or is it WANDERING? Check coord scatter: if the recent grounds
      // for THIS same action text are >SCATTER_THRESHOLD_PX apart,
      // the vision model is hallucinating coords for a target it can't
      // actually see, not converging on a real button. The screen-is-
      // changing exemption was meant for "the file picker is selecting
      // items as we click" — a converging, monotonic flow — not for
      // "we're flailing across the page while an ad animation runs".
      const sameActionGrounds = recentClickGrounds.filter(
        (g) => g.action === normNow,
      );
      if (sameActionGrounds.length >= 3) {
        let maxDist = 0;
        for (let i = 0; i < sameActionGrounds.length; i++) {
          for (let j = i + 1; j < sameActionGrounds.length; j++) {
            const dx = sameActionGrounds[i]!.x - sameActionGrounds[j]!.x;
            const dy = sameActionGrounds[i]!.y - sameActionGrounds[j]!.y;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d > maxDist) maxDist = d;
          }
        }
        if (maxDist > SCATTER_THRESHOLD_PX) {
          console.warn(
            `[loop] 🛑 anti-loop (coord-scatter): action "${action}" grounded ${sameActionGrounds.length} times with max pairwise distance ${Math.round(maxDist)}px (threshold ${SCATTER_THRESHOLD_PX}). Vision model is hallucinating coords — the target is NOT on this screen. Bailing despite pixel changes.`,
          );
          const coordList = sameActionGrounds
            .map((g) => `(${g.x},${g.y})`)
            .join(" → ");
          await events.onError(
            `Stuck: the brain emitted "${action}" ${sameActionGrounds.length} times but the grounder pointed to wildly different spots each time (${coordList}). ` +
              `That means the target isn't actually on the screen — the vision model is guessing. ` +
              `Try a different approach: re-observe with screen_screenshot, switch to a different verb (keyboard input?), ` +
              `or check whether the right app / page is even foregrounded.`,
          );
          return "exhausted";
        }
      }
      console.log(
        `[loop] ⚠ action "${action}" repeated ${same}/4 times but screen IS changing — not bailing (progress likely happening, coord-scatter check passed: ${sameActionGrounds.length} grounds within ${SCATTER_THRESHOLD_PX}px)`,
      );
    }

    // Anti-loop guard #2: type-dedup. The planner wants to type text T —
    // when have we seen this before in this run? Two flavors of bail:
    //   (a) Strong: same text + same screen-hash. Means we're literally
    //       re-running the prior attempt from the identical UI state. Always
    //       a bug.
    //   (b) Soft: same text typed ≥ TYPE_REPEAT_GAP steps ago. Catches the
    //       search-engine macro-loop where pixels drift slightly between the
    //       two attempts (search bar y=409 vs y=413), so flavor (a) misses,
    //       but the planner is clearly stuck re-trying the same query.
    // The gap threshold protects legit close-together repeats: typing the
    // same email into "email" + "confirm email" happens with gap≈2 (one
    // click in between to focus the second field). The search-engine macro-
    // loop has gap≥3 (type → enter → re-click search bar → re-type). 3 is
    // the smallest threshold that separates them. The trace from the cobb-
    // county failure had gap=3 precisely.
    //
    // CRITICAL: handles BOTH OS-level `type "X"` AND structured
    // `browser.type <ref> "X"`. Previously only OS-level was caught, so a
    // browser.type loop would burn 3 attempts before guard #1's 3-of-4
    // threshold killed the run (~30s wasted on the recent
    // "browser.type e17 \"2007 Honda Civic\"" loop). The unified extractor
    // returns the text regardless of which verb form the model emitted.
    const TYPE_REPEAT_GAP = 3;
    const typedText = extractTypedText(action);
    let typeBailReason: string | null = null;
    if (typedText) {
      const norm = typedText.trim().toLowerCase();
      const seen = typedTextScreens.get(norm);
      if (seen?.has(screenHash)) {
        typeBailReason = `screen hash matches a prior attempt (${screenHash})`;
      } else if (seen && seen.size > 0) {
        // Find earliest step where this text was typed (in EITHER verb form).
        const firstSeenAt = history.findIndex(
          (h) => {
            const t = extractTypedText(h);
            return t && t.trim().toLowerCase() === norm;
          },
        );
        if (firstSeenAt !== -1 && history.length - firstSeenAt >= TYPE_REPEAT_GAP) {
          typeBailReason = `same text typed ${history.length - firstSeenAt} steps ago and we're back to retry`;
        }
      }
      if (typeBailReason) {
        console.warn(
          `[loop] 🛑 type-loop: "${typedText}" — ${typeBailReason}`,
        );
        await events.onError(
          `Already attempted "${typedText}" earlier — ${typeBailReason}. ` +
            "The field may not be accepting input — try clicking a different " +
            "field first, or use 'click on the X' (vision) instead of " +
            "browser.type if the ref keeps failing.",
        );
        return "exhausted";
      }
    }

    let coords: { x: number; y: number } | null = null;
    let dragTo: { x: number; y: number } | null = null;

    // Drag is the one action that needs TWO ground calls (source + target).
    // We branch off the normal single-ground flow here so the planner can
    // emit "drag the file to the trash" and we ground each endpoint with
    // its own natural-language description, then exec one drag op below.
    //
    // The two grounds run CONCURRENTLY (2026-06-10): both use the same
    // frozen screenshot and are independent, and a serialized pair was
    // paying 2× the full ground latency per drag. The Modal backend runs
    // llama-server --parallel 4, so the calls genuinely overlap; hcompany
    // absorbs the brief 2-RPM burst inside its existing 429 backoff.
    const drag = parseDragAction(action);
    if (drag) {
      const tGround = Date.now();
      const shotB64 = shot.png.toString("base64");
      let fromTo: [
        { x: number; y: number } | null,
        { x: number; y: number } | null,
      ];
      try {
        fromTo = await Promise.all([
          findCoordinates(provider, {
            instruction: drag.from,
            screenshotB64: shotB64,
            screen: screenSize,
            signal: ctrl.signal,
          }),
          findCoordinates(provider, {
            instruction: drag.to,
            screenshotB64: shotB64,
            screen: screenSize,
            signal: ctrl.signal,
          }),
        ]);
      } catch (e: unknown) {
        if (cancelled()) return "cancelled";
        consecutiveProviderErrors += 1;
        if (consecutiveProviderErrors >= 3) throw e;
        const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
        console.warn(
          `[loop] ⚠ drag ground failed (${msg}) — transient ${consecutiveProviderErrors}/3, retrying next step`,
        );
        const note = `[note: locating the drag endpoints failed with a transient error (${msg}) — nothing was executed; re-emit the action]`;
        history.push(note);
        opts.onHistory?.(note);
        if (await interruptiblePause(Math.max(stepPause, 1000), cancelled))
          return "cancelled";
        continue;
      }
      consecutiveProviderErrors = 0;
      [coords, dragTo] = fromTo;
      console.log(
        `[loop] 🎯 ground/from+to concurrent (${Date.now() - tGround}ms): ` +
          `${coords ? `(${coords.x}, ${coords.y})` : "FAILED"} — "${drag.from}" → ` +
          `${dragTo ? `(${dragTo.x}, ${dragTo.y})` : "FAILED"} — "${drag.to}"`,
      );
      if (coords) await events.onGround(coords);
      if (dragTo) await events.onGround(dragTo);
      if (cancelled()) return "cancelled";
    } else if (/^drag\b/i.test(action.trim())) {
      // Action begins with "drag" but parseDragAction failed (e.g. the model
      // emitted "drag the file" with no destination). Don't ground it as a
      // generic click target — that would burn a request and produce a
      // wrong-shaped action. Surface it as a no-op so the loop's "no
      // executor matched" warning fires and the user sees what came back.
      console.warn(
        `[loop] ⚠ malformed drag (no "to <target>"): ${action} — skipping grounding`,
      );
    } else if (needsCoordinates(action)) {
      // Same-action retry detection: the previous step executed this exact
      // (normalized) action and the brain emitted it again — a suspected
      // misclick. Don't trust the fast path twice: re-ground with the
      // coarse→fine refine pass (~1px vs ~3-6px) for the second attempt.
      // Walk back past synthetic [note: …] entries (e.g. the click-
      // delivery warning) to find the last actually-executed action.
      let lastAction = "";
      for (let h = history.length - 1; h >= 0; h--) {
        const entry = history[h]!;
        if (entry.startsWith("[note:")) continue;
        lastAction = entry.split("  [note:")[0] ?? "";
        break;
      }
      const isRetryOfLast =
        lastAction.length > 0 &&
        normalizeAction(lastAction) === normalizeAction(action);
      if (preGroundedCoords && !isRetryOfLast) {
        // Combined plan+ground already resolved the point — skip the
        // dedicated ground call entirely (the big per-step saving).
        coords = preGroundedCoords;
        console.log(
          `[loop] 🎯 ground skipped — combined step pre-grounded (${coords.x}, ${coords.y})`,
        );
      } else {
        const tGround = Date.now();
        try {
          coords = await findCoordinates(
            provider,
            {
              instruction: action,
              screenshotB64: shot.png.toString("base64"),
              screen: screenSize,
              signal: ctrl.signal,
            },
            {
              // Refine (~1px) when retrying a suspected misclick OR when
              // the planner explicitly asked for precision on a tiny
              // target ("click precisely the …").
              refine:
                isRetryOfLast || /^click\s+precisely\b/i.test(action),
            },
          );
          consecutiveProviderErrors = 0;
        } catch (e: unknown) {
          if (cancelled()) return "cancelled";
          consecutiveProviderErrors += 1;
          if (consecutiveProviderErrors >= 3) throw e;
          const msg =
            e instanceof Error ? e.message.split("\n")[0] : String(e);
          console.warn(
            `[loop] ⚠ ground call failed (${msg}) — transient ${consecutiveProviderErrors}/3, retrying next step`,
          );
          const note = `[note: locating "${action.slice(0, 80)}" failed with a transient error (${msg}) — nothing was executed; re-emit the action]`;
          history.push(note);
          opts.onHistory?.(note);
          if (await interruptiblePause(Math.max(stepPause, 1000), cancelled))
            return "cancelled";
          continue;
        }
        console.log(
          `[loop] 🎯 ground (${Date.now() - tGround}ms): ${coords ? `(${coords.x}, ${coords.y})` : "FAILED"}${isRetryOfLast ? " — refine retry (same action re-emitted)" : ""}`,
        );
      }
      if (coords) {
        await events.onGround(coords);
        // Record this (action, ground-coord) pair for the anti-loop
        // coord-scatter check. We record SCREENSHOT-space coords here
        // (before the offsetX/Y translation a few lines down) — those
        // are the values the vision model produced, so they're what
        // tells us whether the model is wandering. The threshold is
        // SCATTER_THRESHOLD_PX in screenshot-pixel space (250 = about
        // 1/6 of a 1512×982 screen — way larger than the few-px
        // jitter you get from genuine same-target re-grounding).
        recentClickGrounds.push({
          action: normalizeAction(action),
          x: coords.x,
          y: coords.y,
        });
        if (recentClickGrounds.length > SCATTER_WINDOW) {
          recentClickGrounds.shift();
        }
      }
      if (cancelled()) return "cancelled";
    }

    // Multi-monitor offset translation. Holo3's grounder returns coords
    // in SCREENSHOT space (0..shot.width, 0..shot.height). cliclick / nut-js
    // expect coords in SCREEN space (the macOS virtual desktop union of all
    // displays). When the screenshot was captured from the primary display
    // both offsets are 0 and this is a no-op; when the user has Chrome on
    // a secondary display the screenshot was captured via desktopCapturer
    // for that display and we add the display's bounds.x/.y so the click
    // lands on the right monitor. Done HERE (after events.onGround so the
    // UI overlay still shows screenshot-space coords for its own preview).
    if ((shot.offsetX || shot.offsetY) && coords) {
      coords = { x: coords.x + shot.offsetX, y: coords.y + shot.offsetY };
    }
    if ((shot.offsetX || shot.offsetY) && dragTo) {
      dragTo = { x: dragTo.x + shot.offsetX, y: dragTo.y + shot.offsetY };
    }

    // Bounds-validate: when targetApp is set, the click MUST land
    // inside that app's current window. Otherwise it focuses
    // whatever is underneath (Terminal, Cursor IDE, Finder…) and
    // the next screenshot captures the wrong app — exactly the
    // failure mode from the May-11 run where one click at (347,279)
    // landed in the menu-bar area, focused a Terminal window, and
    // the verifier saw Terminal pixels and rejected the (otherwise
    // correct) DONE.
    //
    // We DO NOT bail the run; we refuse this one click and push a
    // [note: …] to history so the brain knows to re-ground. The
    // brain's next plan() call will see the note and (we hope)
    // emit a different verb. If it doesn't, the existing coord-
    // scatter and same-action-N-times guards still apply.
    if (opts.targetApp && coords && process.platform === "darwin") {
      const bounds = await screen.getMacWindowBounds(opts.targetApp);
      if (bounds) {
        const insideX =
          coords.x >= bounds.x && coords.x <= bounds.x + bounds.width;
        const insideY =
          coords.y >= bounds.y && coords.y <= bounds.y + bounds.height;
        if (!insideX || !insideY) {
          console.warn(
            `[loop] 🪟 click out of bounds: (${coords.x},${coords.y}) outside ${opts.targetApp}'s window @(${bounds.x},${bounds.y}) ${bounds.width}×${bounds.height} — refusing this click. Brain will be told to re-ground.`,
          );
          const note =
            `[note: your last grounded click landed at (${coords.x},${coords.y}) which is OUTSIDE ${opts.targetApp}'s window @(${bounds.x},${bounds.y}) ${bounds.width}×${bounds.height}. ` +
            `The click was REFUSED — no action was taken. Look at the screenshot again; the button you described isn't where you thought it was. ` +
            `Either pick a different button OR describe its position more precisely (e.g. "the orange = button in the bottom-right corner of the keypad, in the rightmost column"). Do NOT click outside the ${opts.targetApp} window.]`;
          history.push(note);
          actionScreenHashes.push(screenHash);
          opts.onHistory?.(note);
          await events.onError(
            `Click at (${coords.x},${coords.y}) was outside ${opts.targetApp}'s window — refused. Re-grounding next step.`,
          );
          // Update hashes before continuing so anti-loop guards
          // compare against current state on the next iteration.
          prevSnapshotHash = snapHash;
          prevScreenHash = screenHash;
          if (await interruptiblePause(stepPause, cancelled)) return "cancelled";
          continue;
        }
      }
    }

    // Pre-dispatch delivery check (2026-06-10): the raise that preceded
    // the CAPTURE was ~2s of model time ago. Two delivery hazards by
    // dispatch time: (a) another window came back on TOP of the click
    // point — the CGEvent lands on it; (b) the target app is no longer
    // ACTIVE — macOS consumes the first click as window activation
    // without pressing the control (observed live: same-point clicks 4s
    // apart, first no-op, retry registers). One ~80ms winlist exec
    // checks both; either condition → re-raise (activates) + settle,
    // re-check once, dispatch regardless with a loud log.
    if (coords && opts.targetApp) {
      try {
        const clickX = coords.x + (shot.offsetX || 0);
        const clickY = coords.y + (shot.offsetY || 0);
        let ob = await screen.clickObstruction(
          opts.targetApp,
          clickX,
          clickY,
        );
        if (ob && (ob.coveredBy || ob.activeApp !== opts.targetApp)) {
          console.log(
            `[loop] 🪟 pre-click: ${ob.coveredBy ? `point covered by ${ob.coveredBy}` : `${opts.targetApp} not the active app (active: ${ob.activeApp})`} — re-raising before dispatch`,
          );
          await screen.raiseMacApp(opts.targetApp);
          await screen.sleep(150);
          ob = await screen.clickObstruction(opts.targetApp, clickX, clickY);
          if (ob && ob.coveredBy) {
            console.log(
              `[loop] ⚠ click point still covered by ${ob.coveredBy} after re-raise — the click may land on it`,
            );
          }
        }
      } catch {
        /* best-effort — never block the click on the re-check */
      }
    }

    const tExec = Date.now();
    // Wrap the executor in try/catch so a single click failure (Playwright
    // timeout because the ref is gone, an overlay intercepts pointer
    // events, the page navigated mid-click, etc.) doesn't tear down the
    // entire run. Without this, `browser.click(ref)` throwing here
    // bubbles all the way out of runOneSubtask and the user sees an
    // unhandled exception in the renderer instead of a graceful retry.
    let executed: Awaited<ReturnType<typeof executeAction>> = null;
    let execError: string | null = null;
    // The planner produced an executable (non-banned) action — it still
    // has moves to try, so the consecutive-ban bail resets.
    consecutiveBans = 0;
    try {
      executed = await executeAction(action, coords, dragTo, browser);
    } catch (e) {
      // Keep the message compact — Playwright's full call log is dozens
      // of lines, but the brain only needs the headline ("Timeout 2000ms
      // exceeded" / "subtree intercepts pointer events" / etc.) to
      // course-correct on the next step.
      const raw = e instanceof Error ? e.message : String(e);
      execError = raw.split("\n")[0]!.slice(0, 160);
    }
    if (executed) {
      console.log(
        `[loop] ⚡ exec (${Date.now() - tExec}ms): ${executed.type} ${JSON.stringify(executed.payload)}`,
      );
      await events.onAction(executed);
    } else if (execError) {
      console.warn(
        `[loop] ⚠ exec failed (${Date.now() - tExec}ms): ${execError}`,
      );
      await events.onError(`Action failed: ${action} — ${execError}`);
    } else {
      console.warn(
        `[loop] ⚠ no executor matched action="${action}" coords=${coords ? `(${coords.x},${coords.y})` : "null"}`,
      );
      await events.onStatus(`Skipped (no executor): ${action}`);
      // Browser verbs that fail PARSING (most commonly a name-form ref:
      // browser.click "Modal") get a teaching note instead of a silent
      // skip — the planner must learn the ref contract, not just see
      // the action vanish.
      if (/^browser\.(click|type|scroll)\b/i.test(action.trim())) {
        execError =
          'invalid ref — browser.click/type/scroll take ONLY an e<N> ref from the snapshot (e.g. browser.click e12), never a name. Find the element\'s [eN] in the snapshot, or use a vision click: click <visual description>';
      }
    }

    // Annotate the history entry with failure context so the next plan
    // call sees what went wrong and can switch strategy. Without this,
    // the brain sees its previous action in history as if it succeeded
    // and re-emits a near-identical follow-up — exact loop pattern from
    // the e91 "covered by overlay" trace. Annotation uses the [note: …]
    // shape so the brain treats it as a system observation rather than
    // a verb to imitate.
    // browser.read is only useful if the planner can SEE what was read —
    // previously the scraped text went into the recorded payload and the
    // history got just the action string, so reading was write-only and
    // the planner could never answer from page content. Inline the text
    // (capped) so the next plan call literally has the page in history.
    const readContent =
      executed?.type === "browser_read" &&
      typeof executed.payload.text === "string"
        ? (executed.payload.text as string)
        : null;
    // Remember the read content so a re-read of identical text is caught
    // next step (duplicate-read suppression). Any non-read action clears
    // it — the planner is now acting, so a later read may be legitimately
    // fresh (page changed).
    if (readContent !== null) {
      lastReadContent = readContent;
    } else if (executed && executed.type !== "note") {
      lastReadContent = null;
    }
    // Track the URL we last typed into, so the save-before-type guard
    // knows whether the current form has received input this visit.
    if (executed?.type === "browser_type" && browserSnapshot) {
      lastTypedUrl = browserSnapshot.url;
    }
    // Count ALL committed text edits — DOM (browser_type) AND vision
    // (screen.type → "type"), since agent_do flat/vision-only mode does
    // every edit via screen.type (review 2026-06-11: counting only
    // browser_type wrongly rejected DONE in vision-only runs).
    if (executed?.type === "browser_type" || executed?.type === "type") {
      editActions += 1;
    }
    const historyEntry = execError
      ? `${action}  [note: failed — ${execError}]`
      : readContent !== null
        ? `${action}  [page content: ${readContent.slice(0, 3000).replace(/\s+/g, " ").trim()}${readContent.length > 3000 ? " …(truncated)" : ""}]`
        : action;
    history.push(historyEntry);
    actionScreenHashes.push(screenHash);
    opts.onHistory?.(historyEntry);
    onStep?.();
    // Record this (text, screen-hash) attempt so guard #2 can spot a future
    // re-attempt from the same state. We record AFTER execute so a failed
    // executor (no match, missing coords) doesn't poison the dedup map.
    // Uses the unified extractor so both `type "X"` and `browser.type ref "X"`
    // get tracked under the same normalized key — re-typing the same query
    // via either verb form trips guard #2 on the next attempt.
    if (typedText && executed) {
      const norm = typedText.trim().toLowerCase();
      const set = typedTextScreens.get(norm) ?? new Set<string>();
      set.add(screenHash);
      typedTextScreens.set(norm, set);
    }

    // Speedup: prefetch the next screenshot during the rate-limit pause. We
    // wait PREFETCH_SETTLE_MS first so the OS has finished repainting after
    // our action (focus rings, dropdowns, page transitions). Then we kick off
    // the grab+encode and let it run concurrently with `interruptiblePause`.
    // By the time the next iteration awaits `prefetched`, the bytes are
    // typically already resolved → screenshot latency drops to ~0ms per step.
    // If the pause is very short (default mode = 1200ms) the prefetch may not
    // finish in time; that's fine, the next iteration just awaits whatever's
    // left. We never throw from here — failures fall back to fresh capture.
    //
    // Router fast-path: when this step ran via the local router, we never
    // touched the rate-limited hcompany API. Cap the pause at
    // PREFETCH_SETTLE_MS (250ms) regardless of provider — that's the 5x+
    // speedup the team-of-two architecture buys us. The next step might
    // still go to vision and pay the full 6500ms, but step-by-step routing
    // means we only pay it when we have to.
    // Was this step a typing action? If so, async UI (autocompletes,
    // search-as-you-type results) needs ~1s longer to render before the
    // next snapshot. We bake that wait into the settle period — both the
    // OS-level `type` action and the structured `browser.type` qualify.
    const wasType =
      executed?.type === "type" || executed?.type === "browser_type";
    // Compound-sequence detection: cmd+space (prev step) → type+enter
    // (this step) = Spotlight launch. The launched app needs ~2-3s to
    // draw its window. Without this, the next screenshot shows the
    // previous app and the brain abandons the launch (Run 3 of the
    // honda bench) or cycles cmd+tab trying to find the launched app
    // (Run 4). Pattern matches the brain's actual emission shape:
    // `key {combo:"cmd+space"}` followed by
    // `type {text:"...",thenPress:"enter"}`.
    const prevWasSpotlight =
      prevExecuted?.type === "key" &&
      /cmd\+space/i.test(JSON.stringify(prevExecuted.payload ?? {}));
    const isSpotlightLaunch =
      prevWasSpotlight &&
      wasType &&
      /thenpress["\s:]+["']?enter/i.test(
        JSON.stringify(executed?.payload ?? {}),
      );
    // `open app "Name"` launches in ONE step — same draw-time need as the
    // two-step launcher sequence (the launched app's window takes 2-3s
    // to appear; snapshotting earlier shows the previous app and the
    // planner abandons the launch).
    const isAppLaunch = isSpotlightLaunch || executed?.type === "open_app";
    const settleMs = isAppLaunch
      ? SPOTLIGHT_LAUNCH_SETTLE_MS
      : wasType
        ? POST_TYPE_SETTLE_MS
        : PREFETCH_SETTLE_MS;
    if (isAppLaunch) {
      console.log(
        `[loop] 🚀 app launch detected (${executed?.type === "open_app" ? "open app" : "cmd+space → type+enter"}); settling ${SPOTLIGHT_LAUNCH_SETTLE_MS}ms before next snapshot`,
      );
    }
    // Update prevExecuted only when the action actually ran. A failed/
    // skipped step keeps the previous prevExecuted so the next real
    // step still sees the correct prior context for compound detection.
    if (executed) {
      prevExecuted = executed;
    }

    const effectivePause = usedRouter ? settleMs : Math.max(stepPause, settleMs);
    if (cancelled()) return "cancelled";
    if (effectivePause > settleMs) {
      await screen.sleep(settleMs);
      if (cancelled()) return "cancelled";
      prefetched = screen.screenshot();
      // Swallow rejections so an unhandled rejection here can't kill the run;
      // the await-site has its own try/catch that retries with a fresh grab.
      prefetched.catch(() => {});
      const remaining = effectivePause - settleMs;
      if (await interruptiblePause(remaining, cancelled)) return "cancelled";
    } else {
      // Even on the fast path, settle briefly (or longer after a type) so
      // the next snapshot reflects the action's effect (DOM mutations,
      // focus changes, animations, autocomplete dropdowns). Then prefetch
      // the screenshot in parallel with the (zero-or-tiny) remaining pause.
      await screen.sleep(settleMs);
      if (cancelled()) return "cancelled";
      prefetched = screen.screenshot();
      prefetched.catch(() => {});
    }
  }
  console.log(`[loop] 🛑 exhausted ${maxSteps} steps without DONE`);
  return "exhausted";
}

/**
 * Sleep for `ms`, but check the cancel predicate every 100ms and bail early.
 * Returns true if the pause was cut short by a cancel; false on natural end.
 * Without this, pressing Stop during the 6.5s hcompany-mode pause forces the
 * user to wait the full pause before the loop noticed.
 */
async function interruptiblePause(
  ms: number,
  cancelled: () => boolean,
): Promise<boolean> {
  const tick = 100;
  let elapsed = 0;
  while (elapsed < ms) {
    if (cancelled()) return true;
    const wait = Math.min(tick, ms - elapsed);
    await new Promise((r) => setTimeout(r, wait));
    elapsed += wait;
  }
  return cancelled();
}

async function executeAction(
  action: string,
  coords: { x: number; y: number } | null,
  dragTo: { x: number; y: number } | null = null,
  browser: BrowserClient | null = null,
): Promise<{ type: string; payload: Record<string, unknown> } | null> {
  const a = action.trim();

  // browser.* — handled BEFORE everything else so a Chrome-aware action
  // can't fall through to nut-js cursor automation. Each browser.* verb
  // dispatches via the BrowserClient (Playwright locator), which means the
  // user's OS cursor stays put AND the action targets the actual page
  // viewport / element regardless of what's under the cursor. If the
  // browser client is null (Chrome inactive) we surface as "no executor
  // matched" so the user sees the planner emitted a verb we can't fulfill.
  if (/^browser\./i.test(a)) {
    if (!browser) return null;
    const parsed = parseBrowserAction(a);
    if (!parsed) return null;
    switch (parsed.kind) {
      case "navigate":
        // Used as the agent's "launchpad" move when the active tab is
        // chrome-extension://…/welcome.html (PLAYWRITER_AUTO_ENABLE creates
        // this on first connect and there's nothing else for the agent to
        // do until it leaves). Drives Playwright's page.goto() so the next
        // step's snapshot reflects the new URL.
        await browser.navigate(parsed.url);
        return { type: "browser_navigate", payload: { url: parsed.url } };
      case "click":
        await browser.click(parsed.ref);
        return { type: "browser_click", payload: { ref: parsed.ref } };
      case "type":
        await browser.type(parsed.ref, parsed.text, { submit: parsed.submit });
        return {
          type: "browser_type",
          payload: parsed.submit
            ? { ref: parsed.ref, text: parsed.text, submit: true }
            : { ref: parsed.ref, text: parsed.text },
        };
      case "scroll_page":
        await browser.scrollPage(parsed.dir, parsed.amount);
        return {
          type: "browser_scroll_page",
          payload: { dir: parsed.dir, amount: parsed.amount ?? 800 },
        };
      case "scroll_element":
        await browser.scrollElement(parsed.ref, parsed.dir, parsed.amount);
        return {
          type: "browser_scroll_element",
          payload: { ref: parsed.ref, dir: parsed.dir, amount: parsed.amount ?? 600 },
        };
      case "read": {
        const text = await browser.readText(parsed.ref);
        return {
          type: "browser_read",
          payload: parsed.ref ? { ref: parsed.ref, text } : { text },
        };
      }
    }
  }

  // drag <source> to <target> — handled BEFORE any other matcher so a
  // malformed drag ("drag the file" with no target) can't leak into the
  // generic click fallback at the bottom of this function and click at the
  // single grounded point. We catch anything whose first verb is "drag":
  //   • Well-formed (parseDragAction succeeds) + both coords present → drag.
  //   • Anything else starting with "drag" → return null so the loop logs
  //     "no executor matched" and the user can see what the model emitted.
  if (/^drag\b/i.test(a)) {
    const parsed = parseDragAction(a);
    if (!parsed || !coords || !dragTo) {
      return null;
    }
    await screen.drag(coords.x, coords.y, dragTo.x, dragTo.y);
    return {
      type: "drag",
      payload: { from: { x: coords.x, y: coords.y }, to: { x: dragTo.x, y: dragTo.y } },
    };
  }

  // open app "Name" — deterministic app launch/foreground. The launcher
  // path (cmd+space → type → enter) is brand roulette: cmd+space opens
  // Spotlight on some machines and Raycast on others, and a decomposed
  // step's "Spotlight is open" expect can never verify against Raycast
  // (live trace: the launcher toggled for two full sub-step budgets).
  // raiseMacApp activates via the bridge or AppleScript `activate`,
  // which LAUNCHES the app when it isn't running — one step, no
  // launcher, no brand dependency.
  const openApp = a.match(/^open\s+app\s+["“']?([^"”']+?)["”']?\s*$/i);
  if (openApp) {
    const appName = openApp[1]!.trim();
    const ok = await screen.raiseMacApp(appName);
    if (!ok) throw new Error(`could not launch/activate "${appName}"`);
    return { type: "open_app", payload: { app: appName } };
  }

  // wait Ns / wait 1500ms — brain.ts whitelists `wait` as a keyboard-only
  // (no-grounding) action, so the loop must actually sleep here. Previously
  // this was a silent no-op, leaving the agent paused only by the trailing
  // STEP_PAUSE_MS — which made "wait 5s" behave the same as anything else.
  const waitMatch = a.match(/^wait(?:\s+(\d+(?:\.\d+)?)\s*(ms|s)?)?/i);
  if (waitMatch) {
    const n = waitMatch[1] ? parseFloat(waitMatch[1]) : 1;
    const unit = (waitMatch[2] ?? "s").toLowerCase();
    const ms = unit === "ms" ? n : n * 1000;
    await screen.sleep(ms);
    return { type: "wait", payload: { ms } };
  }

  // type — accept many shapes the model might emit:
  //   type "X"                              ← prescribed format
  //   type 'X'
  //   type X                                ← raw rest of line
  //   type({"text":"X"})                    ← JSON-style hallucination
  //   type({ "text" : "X" })
  //   type {"text":"X"}
  // Followed optionally by "and press KEY" / "then press KEY" / "; press KEY"
  // which the model sometimes appends. Without the chain handling, we'd
  // type the literal string `({"text":"X"}) and press enter` into the box.
  const typed = parseTypeAction(a);
  if (typed) {
    // URL auto-submit heuristic: when the brain types a URL into a
    // focused field (typically Chrome's URL bar after cmd+t) it often
    // forgets to compose `and press enter` to navigate. Observed in 3
    // of 4 honda-sheets bench runs (2026-05-11): brain emits
    // `type "https://sheets.new"` then moves on to clicking, but the
    // URL was never submitted so the page never loaded, and clicks
    // landed on Chrome's empty new-tab page instead of the Sheets UI.
    //
    // When the typed text is unambiguously a URL (starts with http://
    // or https://) AND the brain didn't already specify a thenPress,
    // auto-compose enter. Browser context is overwhelmingly the case
    // for typed URLs; for the rare case of typing a URL into a doc
    // cell, enter just commits the cell which is also usually correct.
    if (!typed.thenPress && /^https?:\/\//i.test(typed.text)) {
      typed.thenPress = "enter";
      console.log(
        `[loop] ⌨️  auto-composed thenPress:"enter" — typed text starts with http(s):// (URL navigation pattern; brain often forgets to submit)`,
      );
    }
    // Expand `\t` / `\n` escape sequences into Tab / Enter key presses
    // interleaved with the surrounding text. The small Holo3 brain often
    // emits `type "URL\tAsking Price\tYear"` thinking the executor will
    // interpret `\t` as Tab — but `screen.typeText` types the literal
    // backslash + t. Observed in t4-honda-crv-google-sheets Run 1
    // (2026-05-11): brain mangled all 7 column headers into a single
    // cell instead of typing one header per column with Tab between.
    // Single-segment input (no escapes) is a no-op pass-through.
    const segments = expandTypeEscapes(typed.text);
    if (segments.length > 1) {
      console.log(
        `[loop] ⌨️  type-with-escapes: expanded ${segments.length} segments from "${typed.text.length > 80 ? typed.text.slice(0, 77) + "..." : typed.text}"`,
      );
    }
    for (const seg of segments) {
      if (seg.kind === "text") {
        await screen.typeText(seg.value);
      } else {
        // Settle so the previous text segment commits before the key
        // press lands. Tab/Enter on an actively-typing field can otherwise
        // eat the trailing character (same reason the thenPress path
        // sleeps 120ms below).
        await screen.sleep(80);
        await screen.pressCombo(seg.value);
      }
    }
    if (typed.thenPress) {
      // Tiny pause so the focused field commits the typed text before we
      // press Enter on top of it. Without this, fast inputs eat the last char.
      await screen.sleep(120);
      await screen.pressCombo(typed.thenPress);
    }
    return {
      type: "type",
      payload: typed.thenPress
        ? { text: typed.text, thenPress: typed.thenPress }
        : { text: typed.text },
    };
  }

  // press KEY  /  hotkey ctrl+v
  const pressMatch = a.match(/^(?:press|hotkey)\s+(.+?)(?:\s*[\.\)\}]?)?$/i);
  // note "..." — the planner's WORKING MEMORY for long tasks. No OS
  // effect; the text lands in history verbatim, so durable state
  // ("edited listing 3 of 7: Blue Lamp — next: Red Chair") survives
  // every later step instead of being inferred from lossy action lines.
  const noteMatch =
    a.match(/^note\s+["'“](.+?)["'”]\s*$/is) ?? a.match(/^note\s+(.+)$/is);
  if (noteMatch) {
    return { type: "note", payload: { text: noteMatch[1].trim() } };
  }

  // press KEY N times — form-tabbing and list-walking in ONE model call
  // instead of N ("press tab 3 times", "press down 5 times").
  const pressRepeatMatch = a.match(
    /^press\s+(.+?)\s+(\d{1,2})\s+times?\s*$/i,
  );
  if (pressRepeatMatch) {
    const combo = pressRepeatMatch[1].trim().replace(/^["'`]|["'`]$/g, "");
    const count = Math.min(20, Math.max(1, parseInt(pressRepeatMatch[2], 10)));
    for (let i = 0; i < count; i++) {
      await screen.pressCombo(combo);
      await screen.sleep(120);
    }
    return { type: "key", payload: { combo, times: count } };
  }

  if (pressMatch) {
    const combo = pressMatch[1].trim().replace(/^["'`]|["'`]$/g, "");
    await screen.pressCombo(combo);
    return { type: "key", payload: { combo } };
  }

  // scroll up|down [N]
  // Default + floor = 50 wheel ticks. nut-js's `step` granularity is
  // OS-dependent; on macOS ~1 tick scrolls 3 lines, so 5 (the previous
  // default) was barely a nudge — pages didn't visibly move and the
  // model would issue scroll-after-scroll forever. 50 ticks ≈ ¾ of a
  // viewport, which is what humans actually mean when they say "scroll
  // down". If the model asks for a smaller amount, we floor to 50; if
  // it asks for a larger amount we honor it. Asking for 0 disables.
  const SCROLL_FLOOR = 50;

  // scroll up|down at|in|on <target> — aim the wheel at a SPECIFIC
  // element (sidebar, nested list, chat pane). The target was grounded
  // (needsCoordinates special-cases this form); park the pointer on it,
  // then wheel. Without this, scrolls hit whatever happened to be under
  // the cursor — nested-pane scrolling was effectively impossible.
  const scrollAtMatch = a.match(
    /^scroll\s+(up|down)(?:\s+(\d+))?\s+(?:at|in|on)\s+/i,
  );
  if (scrollAtMatch && coords) {
    const dir = scrollAtMatch[1].toLowerCase() === "up" ? 1 : -1;
    const amount = Math.max(
      SCROLL_FLOOR,
      scrollAtMatch[2] ? parseInt(scrollAtMatch[2], 10) : SCROLL_FLOOR,
    );
    await screen.hover(coords.x, coords.y);
    await screen.sleep(120);
    await screen.scroll(dir * amount);
    return {
      type: "scroll",
      payload: { direction: scrollAtMatch[1], amount, at: { ...coords } },
    };
  }

  const scrollMatch = a.match(/^scroll\s+(up|down)(?:\s+(\d+))?/i);
  if (scrollMatch) {
    const dirWord = scrollMatch[1].toLowerCase() as "up" | "down";
    const dir = dirWord === "up" ? 1 : -1;
    const requested = scrollMatch[2] ? parseInt(scrollMatch[2], 10) : SCROLL_FLOOR;
    const amount = requested === 0 ? 0 : Math.max(SCROLL_FLOOR, requested);
    // When Chrome is the active surface (browser snapshot was reachable
    // this step), prefer browser.scrollPage over the OS-level wheel scroll.
    // window.scrollBy targets the document viewport unconditionally —
    // sidesteps the entire "cursor parked over sidebar" class of bugs that
    // nut-js scroll suffers from. Falls through to nut-js for non-Chrome
    // contexts.
    if (browser && (await browser.available().catch(() => false))) {
      try {
        await browser.scrollPage(dirWord);
        return {
          type: "browser_scroll_page",
          payload: { dir: dirWord, amount: 800, via: "scroll" },
        };
      } catch (e) {
        console.warn(
          `[loop] browser.scrollPage failed (${e instanceof Error ? e.message : String(e)}) — falling back to nut-js`,
        );
      }
    }
    await screen.scroll(dir * amount);
    return { type: "scroll", payload: { direction: scrollMatch[1], amount } };
  }

  // hover <target> — move the pointer WITHOUT clicking: hover menus,
  // tooltips, reveal-on-hover row actions. Previously unreachable.
  if (/^hover\b/i.test(a) && coords) {
    await screen.hover(coords.x, coords.y);
    return { type: "hover", payload: { ...coords } };
  }

  // Modifier-held clicks — cmd+click (multi-select / open-in-new-tab),
  // shift+click (range select), alt/ctrl variants.
  const modClickMatch = a.match(
    /^(cmd|command|shift|alt|option|ctrl|control)[\s_-]*click\b/i,
  );
  if (modClickMatch && coords) {
    const raw = modClickMatch[1].toLowerCase();
    const mod = (
      raw === "command" ? "cmd" : raw === "option" ? "alt" : raw === "control" ? "ctrl" : raw
    ) as "cmd" | "shift" | "alt" | "ctrl";
    await screen.click(coords.x, coords.y, { modifiers: [mod] });
    return { type: "click", payload: { ...coords, modifier: mod } };
  }

  if (/^double[\s_-]*click/i.test(a) && coords) {
    await screen.click(coords.x, coords.y, { double: true });
    return { type: "double_click", payload: { ...coords } };
  }

  // Triple click — selects all text in the clicked field. The standard
  // pattern is `triple click on <field>` followed by `type X` on the next
  // step, which atomically replaces the field's contents (no cmd+a dance
  // needed). Useful when re-entering a stale search query or overwriting an
  // input that already has text.
  if (/^triple[\s_-]*click/i.test(a) && coords) {
    await screen.click(coords.x, coords.y, { triple: true });
    return { type: "triple_click", payload: { ...coords } };
  }

  // Right click — context menus, copy / paste / inspect element / "open
  // image in new tab", etc. Without this branch, Holo3 emitting "right click
  // on <x>" silently fell through to the generic LEFT-click below, doing
  // the wrong thing entirely. We accept a few spellings the model uses:
  // "right click", "right-click", "rightclick", "secondary click".
  if (/^(?:right[\s_-]*click|secondary[\s_-]*click)/i.test(a) && coords) {
    await screen.click(coords.x, coords.y, { button: "right" });
    return { type: "right_click", payload: { ...coords } };
  }

  if (coords) {
    // Defensive focus promotion: when the planner emits a generic `click`
    // on something that looks like a focusable input — search bar, address
    // bar, text field, textarea, password/email/chat box, etc. — execute a
    // double-click instead of a single click.
    //
    // Why: a missed or under-registered single click leaves focus on the
    // previous element, and the next-step `type X` writes nowhere visible
    // (it goes to whatever WAS focused, or is dropped). The Cobb-County and
    // Chrome-dock failures both started this way.
    //
    // Trade-offs:
    //  • Empty field: double-click is visually identical to single-click.
    //  • Pre-filled field: double-click selects a word; the follow-up
    //    `type X` replaces just that word. Better than typing nowhere.
    //  • Buttons/links/icons: NOT promoted (could double-fire submits) —
    //    `looksLikeFieldTarget` only matches input-like keywords.
    //
    // Disable globally with HOLO3_FIELD_DOUBLE_CLICK=false. If the model
    // explicitly emits "triple click ...", that branch above wins anyway.
    const promoteForFocus =
      process.env.HOLO3_FIELD_DOUBLE_CLICK !== "false" &&
      looksLikeFieldTarget(a);
    if (promoteForFocus) {
      console.log(`[loop] 🎯 promoting click→dbl-click for focus: "${a}"`);
      await screen.click(coords.x, coords.y, { double: true });
      return {
        type: "click",
        payload: { ...coords, doubleForFocus: true },
      };
    }
    await screen.click(coords.x, coords.y);
    return { type: "click", payload: { ...coords } };
  }

  return null;
}

/**
 * Heuristic: does this action target a focusable input field?
 *
 * Conservative — only returns true for explicit input-like keywords. Never
 * matches buttons, links, or icons (where double-clicking could double-fire
 * a submit or open something twice).
 *
 * The negative list strips window-chrome bars (title bar, tool bar, menu
 * bar, tab bar, scroll bar, status bar, task bar) which contain the word
 * "bar" but aren't editable. Without this filter, "click on the title bar"
 * would mistakenly promote.
 */
function looksLikeFieldTarget(action: string): boolean {
  const a = action.toLowerCase();
  // Window-chrome "bars" — never focusable, bail before the positive match.
  if (/\b(?:title|menu|tool|tab|scroll|status|task|side|nav)\s*bar\b/.test(a)) {
    return false;
  }
  return /\b(?:search\s+(?:bar|box|field)|address\s+bar|url\s+bar|location\s+bar|omnibox|textarea|textbox|textfield|text\s+(?:area|box|field)|input\s+(?:field|box)|(?:email|password|username|chat|message|comment|reply)\s+(?:field|input|box)|form\s+(?:field|input)|(?:title|name|first\s+name|last\s+name|subject)\s+(?:field|input))\b/.test(
    a,
  );
}

/**
 * Parse one of these into a {text, thenPress?} object:
 *   type "hello world"
 *   type 'hello world'
 *   type hello world
 *   type({"text": "hello world"})
 *   type({"text":"hello world"}) and press enter
 *   type {"text": "hello world"}, then press enter
 *   type "search box" and press enter
 *
 * Returns null if the action isn't a "type" action.
 */
/**
 * Walk a brain-emitted type-text string and split it into ordered
 * text/key segments wherever `\t` or `\n` escape sequences appear.
 * The brain often emits these intending Tab / Enter key presses
 * between text runs (e.g. `URL\tAsking Price\tYear` to type 3 column
 * headers separated by Tab); without this expansion `screen.typeText`
 * would type the literal backslash + letter into a single cell.
 *
 * Single-segment input (no escapes) returns a one-element array, so
 * the executor's loop is a no-op pass-through for ordinary type calls.
 *
 * Currently recognized escapes: `\t` → tab, `\n` → enter. `\\t` (double
 * backslash + t) is intentionally NOT a literal-backslash-then-tab
 * escape — the brain practically never emits that, and supporting it
 * would require a more complex state machine. If a use-case appears,
 * extend here.
 */
type TypeSegment =
  | { kind: "text"; value: string }
  | { kind: "key"; value: string };
function expandTypeEscapes(text: string): TypeSegment[] {
  const out: TypeSegment[] = [];
  let buf = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\" && i + 1 < text.length) {
      const next = text[i + 1];
      if (next === "t" || next === "n") {
        if (buf) {
          out.push({ kind: "text", value: buf });
          buf = "";
        }
        out.push({ kind: "key", value: next === "t" ? "tab" : "enter" });
        i++; // consume the second char of the escape
        continue;
      }
    }
    buf += text[i];
  }
  if (buf) out.push({ kind: "text", value: buf });
  // Edge case: empty string in → return one empty text segment so the
  // executor still emits the action (records it in history) instead of
  // silently no-op'ing.
  if (out.length === 0) out.push({ kind: "text", value: "" });
  return out;
}

function parseTypeAction(
  raw: string,
): { text: string; thenPress?: string } | null {
  if (!/^type\b/i.test(raw)) return null;

  // First try JSON-style: type({"text":"X"}) optionally followed by ") and press Y"
  const jsonStyle = raw.match(
    /^type\s*\(?\s*\{\s*["']?text["']?\s*:\s*["'](?<text>[^"']*)["']\s*\}\s*\)?\s*(?:\s*,?\s*(?:and|then)\s+press\s+(?<key>[\w+\.\-]+))?/i,
  );
  if (jsonStyle?.groups?.text !== undefined) {
    return {
      text: jsonStyle.groups.text,
      thenPress: jsonStyle.groups.key,
    };
  }

  // Quoted form: type "X" or type 'X' (smart quotes too) optionally chained
  const quoted = raw.match(
    /^type\s+["“'](?<text>[^"”']*)["”']\s*(?:(?:and|then)\s+press\s+(?<key>[\w+\.\-]+))?/i,
  );
  if (quoted?.groups?.text !== undefined) {
    return {
      text: quoted.groups.text,
      thenPress: quoted.groups.key,
    };
  }

  // Bare form: type rest-of-line, possibly with "and press X" tail.
  const bare = raw.match(
    /^type\s+(?<text>.+?)(?:\s+(?:and|then)\s+press\s+(?<key>[\w+\.\-]+))?\s*$/i,
  );
  if (bare?.groups?.text) {
    let text = bare.groups.text.trim();
    // Strip stray wrapping quotes / parens that JSON-style hallucinations
    // sometimes leave behind (e.g. `({"text":"hi")`).
    text = text.replace(/^[\(\[\{]+|[\)\]\}]+$/g, "").trim();
    text = text.replace(/^["'“”]+|["'“”]+$/g, "").trim();
    if (!text) return null;
    return { text, thenPress: bare.groups.key };
  }

  return null;
}

/**
 * Unified extractor: returns the typed text from EITHER an OS-level
 * `type "X"` action OR a structured `browser.type <ref> "X"` action.
 *
 * Used by anti-loop guard #2 (type-dedup) so a model stuck on
 * `browser.type e17 "2007 Honda Civic"` gets caught on attempt 2 instead
 * of riding all the way to guard #1's 3-of-4 threshold (~30s wasted).
 * Returns null for non-type actions and for the synthetic
 * `(failed: ...)` / `(rejected: ...)` history annotations.
 */
function extractTypedText(action: string): string | null {
  const t = parseTypeAction(action);
  if (t) return t.text;
  const b = parseBrowserAction(action);
  if (b?.kind === "type") return b.text;
  return null;
}
