/**
 * One-shot strong-model task decomposition (NEXT-WORK-2026-05-18 Item 2,
 * Option A).
 *
 * This is NOT the disabled Ollama planner. That one ran a weak local
 * model on EVERY flat call and over-decomposed single-step inputs into
 * wrong subtasks ("Open Chrome" while Chrome is already front). This is
 * ONE call to the strong hosted model (the same provider the brain
 * uses), made ONLY when the caller declares the task multi-step, with
 * explicit position tracking handled by the loop (a verifier gate
 * between items — see the flat branch in loop.ts).
 *
 * Failure contract: ANY parse failure, provider error, or a degenerate
 * plan (<=1 step) degrades to `{ steps: [task], oneShot: true }` —
 * byte-identical to today's flat behavior. Decomposition can only ever
 * add structure, never remove the working path.
 */
import type { ProviderClient } from "./types";

export interface DecomposedPlan {
  steps: string[];
  /**
   * Per-step EXPECTED OUTCOME ("display shows 47", "the listing's edit
   * form is open") aligned with `steps` — null where the model omitted
   * one. Threaded into each sub-step's task text so the verifier judges
   * the step against ITS OWN success condition instead of the overall
   * goal (the live failure: "click the 7" was verified against "shows
   * 376", which no amount of clicking 7 can satisfy).
   */
  expects: Array<string | null>;
  /** True when we fell back to the original task as the single step. */
  oneShot: boolean;
}

/**
 * Hard cap on plan length. Holo3-class models occasionally enumerate
 * keystroke-level minutiae ("move the mouse toward...") — a plan longer
 * than this is a symptom of that failure mode, not a real 13-step task,
 * so we fall back to flat rather than grind the verifier through it.
 */
const MAX_PLAN_STEPS = Number(process.env.PONDER_DECOMPOSE_MAX_STEPS ?? 12);

/** Gate: decomposition runs only when PONDER_DECOMPOSE is on AND the
 *  caller passed decompose:true. Default OFF → zero behavior change. */
export function decomposeEnabled(): boolean {
  const v = (process.env.PONDER_DECOMPOSE ?? "").toLowerCase();
  return v === "1" || v === "on" || v === "true";
}

const DECOMPOSE_PROMPT_HEADER = `PLANNING REQUEST — do not click anything.
Break the task below into a SHORT ordered list of atomic UI steps.
Rules:
- Plan the TASK, not the current screen. The screenshot may show an
  UNRELATED app — including the agent's OWN control window (an Electron
  app with provider buttons like "Modal" / "H Company" / "Local" and
  "Sessions" / "Automations" tabs). NEVER plan steps that interact with
  that window: it is the agent's UI, not the task's target. If the
  task's app/site is not on screen yet, the FIRST step must reach it
  (browser.navigate <url> for websites, or open app "Name" for a
  native macOS app).
- Each step = ONE physical action (a single click, one typed string, one
  hotkey) that a verifier can confirm is done from a screenshot.
- Each step carries an "expect": what the SCREEN should visibly show
  once that step succeeded ("the calculator display shows 47", "the
  listing's edit form is open"). Describe OUTCOMES, never brand names
  of system UI ("an app launcher overlay with a search field is open",
  NOT "Spotlight is open" — some machines run Raycast/Alfred instead).
- Use the screenshot to skip steps that are ALREADY satisfied (app
  already open, field already filled).
- If the task is already a single atomic action, return it as the only
  element.
- Reply with ONLY a JSON array of objects, each
  {"step": "<action>", "expect": "<visible result>"}.
  No prose, no numbering, no markdown fence.
`;

/** Live browser-relay state threaded into the plan so it is
 *  browser-first. Live failure without this: decompose planned
 *  "hotkey cmd+space → type facebook marketplace → press enter" while
 *  the controlled tab was ONE browser.navigate away — and cmd+space
 *  opened Raycast, whose "Spotlight is open" expect could never verify,
 *  so the launcher toggled until every budget burned. */
export interface DecomposeBrowserContext {
  connected: boolean;
  url: string | null;
}

function browserStateBlock(ctx: DecomposeBrowserContext | undefined): string {
  if (ctx?.connected) {
    return (
      `\nBROWSER STATE: a controlled Chrome tab is ALREADY CONNECTED` +
      (ctx.url ? ` (current URL: ${ctx.url})` : "") +
      `.\n` +
      `- Every step that happens on a website MUST be a browser.* action:\n` +
      `  browser.navigate <url> / browser.click e<N> / browser.type e<N> "text" / browser.read.\n` +
      `- Navigate to the MOST SPECIFIC URL for the goal, not a homepage\n` +
      `  (e.g. the user's own listings live at\n` +
      `  facebook.com/marketplace/you/selling — going to /marketplace and\n` +
      `  clicking through menus wastes steps).\n` +
      `- NEVER plan launcher or app-opening steps (hotkey cmd+space,\n` +
      `  "open Chrome", Spotlight, Raycast) for anything reachable in the\n` +
      `  browser — the tab is already controllable without them.\n` +
      `- LOOKUP vs ACTION — decide which this is:\n` +
      `  • PURE LOOKUP (the ONLY goal is to retrieve/answer info — find,\n` +
      `    check, what is, who won, how much): do NOT break it up. Return\n` +
      `    the task as the SINGLE element; the step loop solves it directly\n` +
      `    (navigate → browser.read → answer).\n` +
      `  • MULTI-ITEM ACTION (do something to EACH / ALL of a set — "change\n` +
      `    the description on each listing", "message every seller"): also\n` +
      `    return the task as a SINGLE element. The step loop iterates item\n` +
      `    by item using its working memory; a fixed step list would run\n` +
      `    ONCE and stop after a single item. Do NOT enumerate items.\n` +
      `  • SINGLE-TARGET ACTION (modify ONE specific thing — "change the\n` +
      `    price of the Honda listing to $2000"): decompose into real\n` +
      `    steps — (1) reach the page, (2) open the target, (3) make the\n` +
      `    change, (4) save. A bare "navigate" step is NOT enough.\n`
    );
  }
  return (
    `\nBROWSER STATE: no controlled browser tab is connected.\n` +
    `- To open a macOS app, plan ONE step: open app "Name" (launches\n` +
    `  directly — no launcher involved).\n` +
    `- Only fall back to hotkey cmd+space if open app failed. cmd+space\n` +
    `  opens the system launcher — Spotlight on some machines, Raycast on\n` +
    `  others; both launch apps the same way (type the name, press enter).\n`
  );
}

/**
 * Extract the first JSON plan array from model output. Accepts BOTH the
 * current {"step","expect"} object form and the legacy plain-string
 * form (mixed arrays rejected). Tolerates surrounding prose and
 * markdown fences — including prose that itself contains brackets —
 * by trying every '['..']' candidate pair (bounded; plan replies are
 * short) and returning the first that parses cleanly.
 */
export function parsePlanArray(
  text: string,
): { steps: string[]; expects: Array<string | null> } | null {
  const opens: number[] = [];
  for (let i = 0; i < text.length && opens.length < 16; i++) {
    if (text[i] === "[") opens.push(i);
  }
  for (const start of opens) {
    let end = text.length - 1;
    while (end > start) {
      end = text.lastIndexOf("]", end);
      if (end <= start) break;
      try {
        const parsed: unknown = JSON.parse(text.slice(start, end + 1));
        if (Array.isArray(parsed)) {
          const steps: string[] = [];
          const expects: Array<string | null> = [];
          let valid = true;
          for (const item of parsed) {
            if (typeof item === "string" && item.trim().length > 0) {
              steps.push(item.trim());
              expects.push(null);
            } else if (
              item !== null &&
              typeof item === "object" &&
              typeof (item as { step?: unknown }).step === "string" &&
              (item as { step: string }).step.trim().length > 0
            ) {
              const o = item as { step: string; expect?: unknown };
              steps.push(o.step.trim());
              expects.push(
                typeof o.expect === "string" && o.expect.trim().length > 0
                  ? o.expect.trim()
                  : null,
              );
            } else {
              // Structurally different from what we asked — don't
              // trust it (and don't keep scanning inside it).
              valid = false;
              break;
            }
          }
          return valid && steps.length === parsed.length
            ? { steps, expects }
            : null;
        }
      } catch {
        /* not valid JSON at this span — try a shorter one */
      }
      end -= 1;
    }
  }
  return null;
}

export async function decompose(
  task: string,
  firstScreenshotB64: string,
  screen: [number, number],
  provider: ProviderClient,
  signal?: AbortSignal,
  browserCtx?: DecomposeBrowserContext,
): Promise<DecomposedPlan> {
  const fallback: DecomposedPlan = {
    steps: [task],
    expects: [null],
    oneShot: true,
  };
  let raw: string;
  try {
    const t0 = Date.now();
    const result = await provider.plan({
      task: DECOMPOSE_PROMPT_HEADER + browserStateBlock(browserCtx) + "\nTask: " + task,
      history: [],
      screenshotB64: firstScreenshotB64,
      screen,
      signal,
    });
    raw = result.action ?? "";
    console.log(
      `[decompose] plan call ${Date.now() - t0}ms → ${raw.slice(0, 200)}`,
    );
  } catch (e) {
    console.log(
      `[decompose] provider.plan failed (${e instanceof Error ? e.message : String(e)}) — falling back to flat`,
    );
    return fallback;
  }

  const parsed = parsePlanArray(raw);
  if (!parsed || parsed.steps.length <= 1) {
    console.log(
      `[decompose] ${parsed ? `single-step plan` : `unparseable output`} — running flat`,
    );
    return fallback;
  }
  if (parsed.steps.length > MAX_PLAN_STEPS) {
    console.log(
      `[decompose] plan has ${parsed.steps.length} steps (> cap ${MAX_PLAN_STEPS}) — over-decomposition symptom, running flat`,
    );
    return fallback;
  }
  return { steps: parsed.steps, expects: parsed.expects, oneShot: false };
}
