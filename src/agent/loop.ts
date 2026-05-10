import { createHash } from "node:crypto";
import {
  think,
  needsCoordinates,
  isDone,
  isValidAction,
  parseDragAction,
  parseBrowserAction,
} from "./brain";
import { findCoordinates } from "./eyes";
import { createOllamaPlanner } from "./planner";
import { canonicalizeUrl, type RouterClient } from "./router";
import type { AgentEvents, ProviderClient } from "./types";
import type { BrowserClient, BrowserSnapshot } from "./browser/types";
import { verify, verifierEnabled } from "./verifier";
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
const STEP_PAUSE_MS_DEFAULT = 1200;
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
 */
async function maybeCropToTargetApp(
  shot: screen.Screenshot,
  targetApp: string | undefined,
): Promise<screen.Screenshot> {
  if (!targetApp || process.platform !== "darwin") return shot;
  const tBounds = Date.now();
  const bounds = await screen.getMacWindowBounds(targetApp);
  if (!bounds) {
    console.log(
      `[loop] 🪟 crop skipped: getMacWindowBounds("${targetApp}") returned null in ${Date.now() - tBounds}ms — running uncropped this step.`,
    );
    return shot;
  }
  // Translate screen-space window bounds into screenshot-pixel space. On
  // a single-display setup both offsets are 0; on multi-monitor where
  // the cursor sits on the secondary display, shot.offsetX/Y carry that
  // display's screen-space origin and we subtract to get a rect inside
  // the captured PNG.
  const cropX = bounds.x - shot.offsetX;
  const cropY = bounds.y - shot.offsetY;
  if (
    cropX < 0 ||
    cropY < 0 ||
    cropX + bounds.width > shot.width ||
    cropY + bounds.height > shot.height
  ) {
    console.log(
      `[loop] 🪟 crop skipped: window rect ${bounds.width}×${bounds.height}@(${cropX},${cropY}) doesn't fit inside captured frame ${shot.width}×${shot.height} (window may be partially off-screen).`,
    );
    return shot;
  }

  // Electron's nativeImage is the only PNG decode/encode primitive we
  // have in-process without adding a new dep. Lazy require so the
  // module loads in Electron contexts (where the loop actually runs)
  // and silently no-ops in non-Electron contexts (Jest, doctor scripts).
  let nativeImage: typeof import("electron").nativeImage | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    nativeImage = (require("electron") as typeof import("electron")).nativeImage;
  } catch {
    console.log(
      `[loop] 🪟 crop skipped: nativeImage unavailable (non-Electron context).`,
    );
    return shot;
  }
  if (!nativeImage) return shot;

  const tCrop = Date.now();
  try {
    const img = nativeImage.createFromBuffer(shot.png);
    const cropped = img.crop({
      x: cropX,
      y: cropY,
      width: bounds.width,
      height: bounds.height,
    });
    const croppedPng = cropped.toPNG();
    console.log(
      `[loop] 🪟 cropped to ${targetApp} (${bounds.width}×${bounds.height} @ ${cropX},${cropY} in screenshot): ` +
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
 * Public entry point. Decomposes the task with the small local planner
 * (qwen3 via Ollama by default), then runs the existing per-step Holo3 loop
 * once per subtask, feeding the OVERALL goal back into each subtask's prompt
 * so the lower-level model stays oriented.
 *
 * If the planner is unavailable, returns a single-subtask plan and we run
 * exactly the old flat behavior — no regression for users who don't have
 * Ollama installed.
 */
export async function runTask(
  opts: RunOptions,
): Promise<"done" | "cancelled" | "exhausted"> {
  const { task, events } = opts;

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
    return result === "cancelled" || result === "exhausted" ? result : "done";
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

    if (result === "cancelled") return "cancelled";
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
): Promise<"done" | "cancelled" | "exhausted"> {
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
  // Ralph verifier: when the brain emits DONE we ask the same model
  // (different prompt) "did the goal actually land?". If RETRY, we
  // push a [note: …] to history and run one more iteration so the
  // brain can course-correct. Capped at one verify per subtask — we'd
  // rather trust the second DONE than enter an infinite verify loop.
  let verificationAttempted = false;
  // Hierarchical retry: when anti-loop guard #1 would bail (same
  // action 3/4 times AND screen unchanged), give the brain ONE
  // chance to recover by force-resnapshotting + pushing a strong
  // "you are stuck — change strategy" note. If the next iteration
  // ALSO emits the same action, we bail for real. This converts the
  // hard cliff at the anti-loop boundary into a single graceful
  // recovery step. Tracked once per subtask.
  let hardRetryAttempted = false;
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
  // Prefetched next screenshot. We kick this off ~250ms after each action so
  // it overlaps with the inter-step pause; by the time the next iteration
  // starts, the bytes are already in memory and we skip a 50-200ms grab+encode.
  let prefetched: Promise<screen.Screenshot> | null = null;
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
    const screenHash = hashScreen(shot.png);
    console.log(
      `[loop] 📸 screenshot ${shot.width}x${shot.height} (${shot.png.length} bytes, ${Date.now() - t0}ms${prefetchUsed ? " prefetched" : ""}) hash=${screenHash}`,
    );
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
    const browserStalled = snapshotUnchanged && screenChanged;
    if (browserStalled) {
      console.log(
        "[loop] 🪟 browser-stall: DOM unchanged but screen pixels moved — OS overlay likely (file picker / native dialog). Skipping router this step, going vision.",
      );
      pendingRouterHint =
        "Previous click opened a NATIVE OS dialog on top of Chrome (likely a file picker / save dialog / system prompt). The Chrome accessibility tree is stale — IGNORE browser.* refs this step. Look at the screenshot and emit a vision-grounded mouse action ('click on the file …', 'click the Open button', etc.) to drive the dialog.";
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
          case "action":
            console.log(`[router] (${dt}ms) → ${decision.action}`);
            routerAction = decision.action;
            usedRouter = true;
            break;
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
        action = await think(provider, {
          task: taskForPlanner,
          history,
          screenshotB64: shot.png.toString("base64"),
          screen: screenSize,
          signal: ctrl.signal,
          browserSnapshot,
          routerHint: pendingRouterHint,
        });
      } catch (e: unknown) {
        if (cancelled()) return "cancelled";
        throw e;
      }
      // Hint consumed — clear so it doesn't leak into the next step if the
      // router has nothing further to say.
      pendingRouterHint = undefined;
      console.log(`[loop] 🧠 plan (${Date.now() - tPlan}ms): ${action}`);
      await events.onThought(action);
      if (cancelled()) return "cancelled";
    }

    if (isDone(action)) {
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
      console.log(
        `[loop] ⚠ action "${action}" repeated ${same}/4 times but screen IS changing — not bailing (progress likely happening)`,
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
    const drag = parseDragAction(action);
    if (drag) {
      const tGroundA = Date.now();
      try {
        coords = await findCoordinates(provider, {
          instruction: drag.from,
          screenshotB64: shot.png.toString("base64"),
          screen: screenSize,
          signal: ctrl.signal,
        });
      } catch (e: unknown) {
        if (cancelled()) return "cancelled";
        throw e;
      }
      console.log(
        `[loop] 🎯 ground/from (${Date.now() - tGroundA}ms): ${coords ? `(${coords.x}, ${coords.y})` : "FAILED"} — "${drag.from}"`,
      );
      if (coords) await events.onGround(coords);
      if (cancelled()) return "cancelled";

      const tGroundB = Date.now();
      try {
        dragTo = await findCoordinates(provider, {
          instruction: drag.to,
          screenshotB64: shot.png.toString("base64"),
          screen: screenSize,
          signal: ctrl.signal,
        });
      } catch (e: unknown) {
        if (cancelled()) return "cancelled";
        throw e;
      }
      console.log(
        `[loop] 🎯 ground/to (${Date.now() - tGroundB}ms): ${dragTo ? `(${dragTo.x}, ${dragTo.y})` : "FAILED"} — "${drag.to}"`,
      );
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
      const tGround = Date.now();
      try {
        coords = await findCoordinates(provider, {
          instruction: action,
          screenshotB64: shot.png.toString("base64"),
          screen: screenSize,
          signal: ctrl.signal,
        });
      } catch (e: unknown) {
        if (cancelled()) return "cancelled";
        throw e;
      }
      console.log(
        `[loop] 🎯 ground (${Date.now() - tGround}ms): ${coords ? `(${coords.x}, ${coords.y})` : "FAILED"}`,
      );
      if (coords) await events.onGround(coords);
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

    const tExec = Date.now();
    // Wrap the executor in try/catch so a single click failure (Playwright
    // timeout because the ref is gone, an overlay intercepts pointer
    // events, the page navigated mid-click, etc.) doesn't tear down the
    // entire run. Without this, `browser.click(ref)` throwing here
    // bubbles all the way out of runOneSubtask and the user sees an
    // unhandled exception in the renderer instead of a graceful retry.
    let executed: Awaited<ReturnType<typeof executeAction>> = null;
    let execError: string | null = null;
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
    }

    // Annotate the history entry with failure context so the next plan
    // call sees what went wrong and can switch strategy. Without this,
    // the brain sees its previous action in history as if it succeeded
    // and re-emits a near-identical follow-up — exact loop pattern from
    // the e91 "covered by overlay" trace. Annotation uses the [note: …]
    // shape so the brain treats it as a system observation rather than
    // a verb to imitate.
    const historyEntry = execError
      ? `${action}  [note: failed — ${execError}]`
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
    const settleMs = wasType ? POST_TYPE_SETTLE_MS : PREFETCH_SETTLE_MS;

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
    await screen.typeText(typed.text);
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
