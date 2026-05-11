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
}

export interface VerifyResult {
  verified: boolean;
  reason?: string;
}

// Verifier is conservative on snapshot size — it only needs gist, not
// every interactive ref. Bigger snapshot = slower verifier call.
const VERIFIER_SNAPSHOT_LIMIT = 8_000;

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
      (args.browserSnapshot.ax.length > VERIFIER_SNAPSHOT_LIMIT
        ? args.browserSnapshot.ax.slice(0, VERIFIER_SNAPSHOT_LIMIT) +
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

  const verificationTask =
    `VERIFICATION CHECK — DO NOT EMIT AN ACTION VERB.\n` +
    `\n` +
    `Original goal: ${args.task}\n` +
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
      screenshotB64: args.screenshotB64,
      screen: args.screen,
      signal: args.signal,
    });
    raw = out.action.trim();
  } catch (e) {
    console.warn(
      `[verifier] ← error (${Date.now() - t0}ms): ${
        e instanceof Error ? e.message : String(e)
      } — accepting DONE conservatively`,
    );
    return { verified: true };
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
  // Ambiguous output (verb echo, prose, empty). The brain claimed DONE; we
  // accept rather than enter a Ralph→Sisyphus loop on a misformatted reply.
  console.warn(
    `[verifier] ambiguous response, treating as VERIFIED: "${trimmed.slice(0, 80)}"`,
  );
  return { verified: true };
}

/** Whether the verifier should run. Default on; PONDER_VERIFIER=off disables. */
export function verifierEnabled(): boolean {
  return process.env.PONDER_VERIFIER !== "off";
}
