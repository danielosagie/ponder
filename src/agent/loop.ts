import { createHash } from "node:crypto";
import {
  think,
  needsCoordinates,
  isDone,
  parseDragAction,
  parseBrowserAction,
} from "./brain";
import { findCoordinates } from "./eyes";
import { createOllamaPlanner } from "./planner";
import type { AgentEvents, ProviderClient } from "./types";
import type { BrowserClient, BrowserSnapshot } from "./browser/types";
import type { Screenshot, ScreenAdapter } from "./screen/types";
import { createNutScreenAdapter } from "./screen/nut";

// Per-subtask cap. With hierarchical planning the inner loop only needs to
// carry ONE focused phase to completion ("open Chrome", "search Google for
// X"), so 12 steps is plenty. If a subtask exhausts without DONE we abort
// the whole run rather than burning the rest of the budget — the planner's
// decomposition was probably wrong, retry with a clearer prompt.
const MAX_STEPS_PER_SUBTASK = 12;
// Hard ceiling across all subtasks combined. Even with a 6-subtask plan we
// never want more than this total. Roughly 2x the old flat MAX_STEPS — gives
// hierarchical mode headroom without making cancel-by-budget useless.
const MAX_STEPS_TOTAL = 60;
// Legacy cap for non-hierarchical (planner unavailable / single-subtask) runs.
// Matches the old behavior so flat mode is identical to before.
const MAX_STEPS = 30;
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

export interface RunOptions {
  task: string;
  provider: ProviderClient;
  events: AgentEvents;
  shouldCancel?: () => boolean;
  /**
   * Optional Chrome control via Playwriter. When present AND the extension
   * is connected to an active tab, the loop will:
   *   1. Pull an accessibility snapshot at the start of each step and
   *      include it in the planner prompt so the model can pick browser.*
   *      actions instead of guessing pixel coordinates.
   *   2. Route browser.click/type/scroll/read through this client instead
   *      of nut-js cursor automation.
   * When the client is null, or `available()` returns false (extension
   * offline / no green tab), the loop runs the legacy vision-only flow
   * with zero behavioral change.
   */
  browser?: BrowserClient | null;
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
   * Optional screen automation adapter. When omitted the loop creates a
   * default nut-js + cliclick adapter (the same behavior as before this
   * abstraction landed). SDK consumers running headless or on non-mac
   * platforms should pass their own implementation.
   */
  screen?: ScreenAdapter;
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
  const planner = createOllamaPlanner();
  const t0 = Date.now();
  const plan = await planner.plan(task);
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
  const screen = opts.screen ?? createNutScreenAdapter();
  const history: string[] = [];
  // For each typed text we've ever attempted in this run, the set of screen
  // hashes the screen had right before we tried it. Re-typing the SAME text
  // from a screen we've already typed it on is the search-engine loop pattern
  // (planner sees the input box, types the query, page updates, planner
  // re-emits "type the query" because it doesn't realize results are already
  // showing). Catching this saves ~10 wasted steps per failure.
  const typedTextScreens = new Map<string, Set<string>>();
  // Prefetched next screenshot. We kick this off ~250ms after each action so
  // it overlaps with the inter-step pause; by the time the next iteration
  // starts, the bytes are already in memory and we skip a 50-200ms grab+encode.
  let prefetched: Promise<Screenshot> | null = null;
  const stepPause =
    provider.name === "hcompany" ? STEP_PAUSE_MS_HCOMPANY : STEP_PAUSE_MS_DEFAULT;

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
    let shot: Screenshot;
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

    const tPlan = Date.now();
    let action: string;
    try {
      action = await think(provider, {
        task: taskForPlanner,
        history,
        screenshotB64: shot.png.toString("base64"),
        screen: screenSize,
        signal: ctrl.signal,
        browserSnapshot,
      });
    } catch (e: unknown) {
      if (cancelled()) return "cancelled";
      throw e;
    }
    console.log(`[loop] 🧠 plan (${Date.now() - tPlan}ms): ${action}`);
    await events.onThought(action);
    if (cancelled()) return "cancelled";

    if (isDone(action)) {
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
      history.push("(empty)");
      // Two empty plans in a row = the model is stuck. Bail rather than
      // burn through 30 steps doing nothing.
      if (history.length >= 2 && history.at(-2) === "(empty)") {
        console.warn("[loop] 🛑 two consecutive empty plans — stopping");
        await events.onError("Model returned empty actions twice in a row — stopping.");
        return "exhausted";
      }
      if (await interruptiblePause(stepPause, cancelled)) return "cancelled";
      continue;
    }

    // Anti-loop guard #1: if the SAME normalized action was emitted three
    // times in the last four steps and we haven't hit DONE, the agent is
    // stuck (clicking the same icon over and over because nothing's changing
    // on screen). Normalization makes this resilient to trivial drift like
    // "click the search bar" vs "click the search bar." (trailing period).
    const normNow = normalizeAction(action);
    const last4 = history.slice(-3).map(normalizeAction).concat(normNow);
    const same = last4.filter((h) => h === normNow).length;
    if (last4.length === 4 && same >= 3) {
      console.warn(
        `[loop] 🛑 anti-loop: action "${action}" repeated ${same}/4 times — stopping`,
      );
      await events.onError(
        `Stuck in a loop: "${action}" was emitted ${same} of the last 4 steps. ` +
          "The screen may not be updating, or the target isn't reachable from this state.",
      );
      return "exhausted";
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
    const TYPE_REPEAT_GAP = 3;
    const typed = parseTypeAction(action);
    let typeBailReason: string | null = null;
    if (typed) {
      const norm = typed.text.trim().toLowerCase();
      const seen = typedTextScreens.get(norm);
      if (seen?.has(screenHash)) {
        typeBailReason = `screen hash matches a prior attempt (${screenHash})`;
      } else if (seen && seen.size > 0) {
        // Find earliest step where this text was typed.
        const firstSeenAt = history.findIndex(
          (h) => parseTypeAction(h)?.text.trim().toLowerCase() === norm,
        );
        if (firstSeenAt !== -1 && history.length - firstSeenAt >= TYPE_REPEAT_GAP) {
          typeBailReason = `same text typed ${history.length - firstSeenAt} steps ago and we're back to retry`;
        }
      }
      if (typeBailReason) {
        console.warn(
          `[loop] 🛑 type-loop: "${typed.text}" — ${typeBailReason}`,
        );
        await events.onError(
          `Already attempted "${typed.text}" earlier — ${typeBailReason}. ` +
            "Try a more specific prompt, or check that the right field is focused.",
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

    const tExec = Date.now();
    const executed = await executeAction(action, coords, dragTo, browser, screen);
    if (executed) {
      console.log(
        `[loop] ⚡ exec (${Date.now() - tExec}ms): ${executed.type} ${JSON.stringify(executed.payload)}`,
      );
      await events.onAction(executed);
    } else {
      console.warn(
        `[loop] ⚠ no executor matched action="${action}" coords=${coords ? `(${coords.x},${coords.y})` : "null"}`,
      );
      await events.onStatus(`Skipped (no executor): ${action}`);
    }

    history.push(action);
    opts.onHistory?.(action);
    onStep?.();
    // Record this (text, screen-hash) attempt so guard #2 can spot a future
    // re-attempt from the same state. We record AFTER execute so a failed
    // executor (no match, missing coords) doesn't poison the dedup map.
    if (typed && executed) {
      const norm = typed.text.trim().toLowerCase();
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
    if (cancelled()) return "cancelled";
    if (stepPause > PREFETCH_SETTLE_MS) {
      await screen.sleep(PREFETCH_SETTLE_MS);
      if (cancelled()) return "cancelled";
      prefetched = screen.screenshot();
      // Swallow rejections so an unhandled rejection here can't kill the run;
      // the await-site has its own try/catch that retries with a fresh grab.
      prefetched.catch(() => {});
      const remaining = stepPause - PREFETCH_SETTLE_MS;
      if (await interruptiblePause(remaining, cancelled)) return "cancelled";
    } else {
      if (await interruptiblePause(stepPause, cancelled)) return "cancelled";
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
  screen: ScreenAdapter = createNutScreenAdapter(),
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
