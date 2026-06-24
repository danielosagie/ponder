import type { ProviderClient } from "./types";
import type { BrowserSnapshot } from "./browser/types";

/**
 * Ralph-style verifier — closes the false-DONE class of bug.
 *
 * Pattern (from the Vercel labs ralph-loop and ice-ice-bear post,
 * March 2026): even when the agent says "done," restart it once and
 * make it verify — the agent loop keeps going until the result is
 * actually correct. We don't go full Ralph (infinite verify) because
 * a small VLM brain can disagree with itself indefinitely; we cap at
 * ONE verification per subtask. If the verifier rejects, the loop
 * runs one more iteration with a [note: …] in history; if the brain
 * emits DONE again, the second DONE is trusted and the loop returns.
 *
 * The verifier reuses the brain provider with a different question
 * shape — no new ProviderClient method, no new endpoint. Costs roughly
 * one extra plan() call per run that emits DONE (~3-7s on hcompany,
 * <1s on local). Set PONDER_VERIFIER=off to disable for cost-sensitive
 * runs.
 */

export interface VerifyArgs {
  /** The original goal the brain claimed to have completed. */
  task: string;
  /** Latest screenshot bytes (base64). */
  screenshotB64: string;
  /** Screen size, passed through to the provider. */
  screen: [number, number];
  /** Optional Chrome AX snapshot for verifier context. */
  browserSnapshot?: BrowserSnapshot;
  /** Optional current browser URL+title from AppleScript probe
   *  (src/screen.ts getBrowserUrl). Verifier uses this to compare
   *  expected URL pattern (extracted from `task`) against actual
   *  page state — the May-11 false-positive DONE happened because
   *  the verifier rubber-stamped a screenshot of facebook.com/
   *  marketplace/you when the goal was to search for "bulbasaur"
   *  (expected URL contains "search?q=bulbasaur"). With this field
   *  the verifier can explicitly assert URL-pattern match. */
  currentUrl?: { url: string; title: string };
  /** Abort signal. */
  signal?: AbortSignal;
  /**
   * The CONTROLLED browser tab is not the visible one — the screenshot
   * shows a DIFFERENT tab than browserSnapshot/currentUrl describe.
   * When true, the verifier must judge browser state from the URL/AX
   * snapshot and treat the screenshot pixels as unrelated.
   */
  tabHidden?: boolean;
  /**
   * What to return when the verifier call ERRORS or replies ambiguously.
   * Default true (fail-open): for a brain-claimed DONE we'd rather accept
   * than spin. The proactive completion probe passes false (fail-closed):
   * the brain made NO done claim there, so a transient provider error
   * must not terminate the run — under decompose it would falsely
   * advance the plan past an incomplete step.
   */
  errorDefault?: boolean;
}

export interface VerifyResult {
  verified: boolean;
  reason?: string;
}

// Verifier is conservative on snapshot size — it only needs gist, not
// every interactive ref. Bigger snapshot = slower verifier call. The
// composite planner has ~1M ctx, and with tabHidden the snapshot is the
// verifier's ONLY evidence — truncating it there hides exactly the
// content being judged.
const VERIFIER_SNAPSHOT_LIMIT = 8_000;
const VERIFIER_SNAPSHOT_LIMIT_COMPOSITE = 20_000;

function snapshotLimitFor(provider: ProviderClient): number {
  return provider.name === "composite"
    ? VERIFIER_SNAPSHOT_LIMIT_COMPOSITE
    : VERIFIER_SNAPSHOT_LIMIT;
}

/**
 * Ask the brain whether the original goal actually landed.
 *
 * Returns:
 *   { verified: true }                       → DONE is real, loop returns done.
 *   { verified: false, reason: <string> }    → DONE is wrong, loop adds a
 *                                              [note: …] and runs one more
 *                                              iteration.
 *
 * On verifier error or ambiguous output, defaults to verified:true. We'd
 * rather accept a brain's DONE than spin — false positives on the
 * verifier are worse than false negatives.
 */
export async function verify(
  provider: ProviderClient,
  args: VerifyArgs,
): Promise<VerifyResult> {
  const snapshotBlock = args.browserSnapshot
    ? `\n\nChrome accessibility snapshot (informational):\n` +
      `URL: ${args.browserSnapshot.url}\n` +
      (args.browserSnapshot.ax.length > snapshotLimitFor(provider)
        ? args.browserSnapshot.ax.slice(0, snapshotLimitFor(provider)) +
          "\n…(truncated for verifier)"
        : args.browserSnapshot.ax)
    : "";
  // Always include the URL when we have it — even without an AX
  // snapshot. This is THE single most important signal for
  // verification on web tasks: if the goal says "search for X" and
  // the URL doesn't contain "search" and "X", we are NOT done.
  const urlBlock = args.currentUrl
    ? `\n\nCurrent browser URL: ${args.currentUrl.url}\n` +
      `Current browser title: ${args.currentUrl.title}\n`
    : "";

  // When the controlled tab is hidden, the screenshot shows an UNRELATED
  // window — and instructing the model to ignore an image it can see does
  // not work (live: "the URL matches the goal, HOWEVER the screenshot
  // shows a file explorer" → RETRY). For providers that support text-only
  // calls (composite), WITHHOLD the image entirely; the Modal /plan
  // endpoint requires one, so there we keep the image + instruction.
  const withholdScreenshot =
    args.tabHidden === true && provider.name === "composite";
  const verificationTask =
    `VERIFICATION CHECK — DO NOT EMIT AN ACTION VERB.\n` +
    `\n` +
    `Original goal: ${args.task}\n` +
    (withholdScreenshot
      ? `\nNOTE: no screenshot is attached — the agent's controlled browser ` +
        `tab is not currently visible on the physical screen (an unrelated ` +
        `window covers it), so pixels would be misleading. Judge ENTIRELY ` +
        `from the URL and accessibility snapshot below; they are live and ` +
        `accurate for the controlled tab.\n`
      : args.tabHidden
        ? `\nIMPORTANT: the SCREENSHOT shows a DIFFERENT Chrome tab than the one ` +
          `the agent controls. Judge browser state ONLY from the URL and the ` +
          `accessibility snapshot below — the screenshot pixels are unrelated ` +
          `to the controlled tab and must not count against verification.\n`
        : ``) +
    `${urlBlock}${snapshotBlock}\n` +
    `\n` +
    `The agent has just claimed this goal is achieved. Default answer is RETRY.\n` +
    `Only respond VERIFIED if you can identify a CONCRETE, SPECIFIC signal in ` +
    `the screenshot or browser state that the goal LITERALLY landed. Examples:\n` +
    `  • Goal "search for X" → URL must contain "search" or the page must show a ` +
    `results-list / results-header / "Search results for X" text. URL ending in ` +
    `the home page or "/you" or a category page is NOT verified.\n` +
    `  • Goal "open the listing for Y" → page must show the listing's title, ` +
    `price, or description. A search results page or category index is NOT verified.\n` +
    `  • Goal "compute X" → the calculator's display must show the exact numeric ` +
    `answer. Showing a partial expression or wrong number is NOT verified.\n` +
    `  • Goal "send a message" → the conversation/post must show the sent message ` +
    `appearing as a new entry. Just having the compose box focused is NOT verified.\n` +
    `\n` +
    `EQUIVALENCE RULE — system launchers are interchangeable: if the goal\n` +
    `or expected result names one launcher (Spotlight, Raycast, Alfred) and\n` +
    `the screen shows a DIFFERENT one, judge the FUNCTION, not the brand —\n` +
    `any launcher overlay with a search field counts as "the launcher is\n` +
    `open". Same for typed-ahead app names: the app name visible in ANY\n` +
    `launcher's field/results satisfies "typed into Spotlight".\n` +
    `\n` +
    `Be SKEPTICAL. If the action LIKELY landed but you can't confirm it from\n` +
    `the screenshot or URL, RETRY is the safer answer — the orchestrator will\n` +
    `re-check; verifying a wrong state is worse than retrying a correct one.\n` +
    `\n` +
    `Reply with EXACTLY ONE LINE:\n` +
    `  VERIFIED                       (concrete proof of completion present)\n` +
    `  RETRY: <one-sentence reason>   (no concrete proof, or contradiction)\n` +
    `\n` +
    `No other output. No verbs. No prose. Just one of those two shapes.`;

  const t0 = Date.now();
  console.log(
    `[verifier] → ${provider.name}.plan task="${args.task.slice(0, 60)}${args.task.length > 60 ? "..." : ""}"`,
  );
  let raw: string;
  try {
    const out = await provider.plan({
      task: verificationTask,
      history: [], // verifier sees no prior actions — it's a fresh judgement
      screenshotB64: withholdScreenshot ? "" : args.screenshotB64,
      screen: args.screen,
      signal: args.signal,
    });
    raw = out.action.trim();
  } catch (e) {
    const fallback = args.errorDefault ?? true;
    console.warn(
      `[verifier] ← error (${Date.now() - t0}ms): ${
        e instanceof Error ? e.message : String(e)
      } — ${fallback ? "accepting DONE conservatively" : "treating as NOT verified (probe fail-closed)"}`,
    );
    return fallback
      ? { verified: true }
      : { verified: false, reason: "verifier call errored — no proof of completion" };
  }
  console.log(
    `[verifier] ← (${Date.now() - t0}ms) "${raw.slice(0, 120)}${raw.length > 120 ? "..." : ""}"`,
  );

  const trimmed = raw.trim();
  if (/^VERIFIED\b/i.test(trimmed)) {
    return { verified: true };
  }
  const retryMatch = trimmed.match(/^\s*RETRY\s*[:\-]\s*(.+?)\s*$/im);
  if (retryMatch && retryMatch[1]) {
    return { verified: false, reason: retryMatch[1].trim() };
  }
  // Ambiguous output (verb echo, prose, empty). For a brain-claimed DONE we
  // accept rather than enter a Ralph→Sisyphus loop on a misformatted reply;
  // for a proactive probe (errorDefault:false) ambiguity is not proof.
  const ambiguousFallback = args.errorDefault ?? true;
  console.warn(
    `[verifier] ambiguous response, treating as ${ambiguousFallback ? "VERIFIED" : "NOT verified (probe fail-closed)"}: "${trimmed.slice(0, 80)}"`,
  );
  return ambiguousFallback
    ? { verified: true }
    : { verified: false, reason: "verifier reply was ambiguous — no proof" };
}

/** Whether the verifier should run. Default on; PONDER_VERIFIER=off disables. */
export function verifierEnabled(): boolean {
  return process.env.PONDER_VERIFIER !== "off";
}

export interface InfeasibleResult {
  /** True only when a concrete, screen-visible blocker is confirmed. */
  confirmed: boolean;
  reason?: string;
}

/**
 * The mirror of verify() for the INFEASIBLE claim.
 *
 * verify() guards false-positive DONE (agent lies that it finished).
 * This guards false-positive INFEASIBLE (agent gives up on a task that
 * is merely hard, not impossible) — the T5 failure class. The defaults
 * are deliberately INVERTED vs verify(): on verifier error or ambiguous
 * output we return { confirmed: false } (keep working), because wrongly
 * abandoning a doable task is worse than spending one more step on a
 * genuinely impossible one.
 *
 * Only `confirmed: true` when the screenshot/URL shows a concrete
 * immovable barrier: a permission-denied dialog, a read-only / locked
 * error, an explicit system "this can't be done" message, a login wall
 * with no credentials, etc. "I couldn't find the button" is NOT
 * infeasible — that's a grounding miss; keep trying.
 */
export async function verifyInfeasible(
  provider: ProviderClient,
  args: VerifyArgs & { claimedReason: string },
): Promise<InfeasibleResult> {
  const urlBlock = args.currentUrl
    ? `\n\nCurrent browser URL: ${args.currentUrl.url}\n` +
      `Current browser title: ${args.currentUrl.title}\n`
    : "";
  const snapshotBlock = args.browserSnapshot
    ? `\n\nChrome accessibility snapshot (informational):\n` +
      `URL: ${args.browserSnapshot.url}\n` +
      (args.browserSnapshot.ax.length > snapshotLimitFor(provider)
        ? args.browserSnapshot.ax.slice(0, snapshotLimitFor(provider)) +
          "\n…(truncated for verifier)"
        : args.browserSnapshot.ax)
    : "";

  const checkTask =
    `INFEASIBILITY CHECK — DO NOT EMIT AN ACTION VERB.\n` +
    `\n` +
    `Original goal: ${args.task}\n` +
    `The agent claims this is IMPOSSIBLE, reason: "${args.claimedReason}"\n` +
    `${urlBlock}${snapshotBlock}\n` +
    `\n` +
    `Default answer is CONTINUE. Only respond IMPOSSIBLE if the screenshot\n` +
    `or browser state shows a CONCRETE, immovable blocker:\n` +
    `  • a permission-denied / "operation not permitted" / read-only or\n` +
    `    locked-file error dialog,\n` +
    `  • an explicit system message that the action cannot be done,\n` +
    `  • a login / paywall the agent has no way past,\n` +
    `  • a missing prerequisite the agent cannot create.\n` +
    `\n` +
    `These are NOT impossible (respond CONTINUE):\n` +
    `  • "I can't find the button/element" — that's a grounding miss.\n` +
    `  • the task is long, fiddly, or multi-step.\n` +
    `  • a dialog is in the way that could just be dismissed.\n` +
    `  • the agent simply hasn't tried a working approach yet.\n` +
    `\n` +
    `Reply with EXACTLY ONE LINE:\n` +
    `  IMPOSSIBLE: <one-sentence concrete blocker visible now>\n` +
    `  CONTINUE: <one-sentence reason it is still worth trying>\n` +
    `\n` +
    `No other output. No verbs. No prose.`;

  const t0 = Date.now();
  console.log(
    `[infeasible-check] → ${provider.name}.plan reason="${args.claimedReason.slice(0, 60)}"`,
  );
  let raw: string;
  try {
    const out = await provider.plan({
      task: checkTask,
      history: [],
      screenshotB64: args.screenshotB64,
      screen: args.screen,
      signal: args.signal,
    });
    raw = out.action.trim();
  } catch (e) {
    console.warn(
      `[infeasible-check] ← error (${Date.now() - t0}ms): ${
        e instanceof Error ? e.message : String(e)
      } — NOT confirming (keep working)`,
    );
    return { confirmed: false };
  }
  console.log(
    `[infeasible-check] ← (${Date.now() - t0}ms) "${raw.slice(0, 120)}${raw.length > 120 ? "..." : ""}"`,
  );

  const m = raw.match(/^\s*IMPOSSIBLE\s*[:\-]\s*(.+?)\s*$/im);
  if (m && m[1]) {
    return { confirmed: true, reason: m[1].trim() };
  }
  // CONTINUE, ambiguous, verb echo, empty — all mean "don't give up".
  return { confirmed: false };
}
