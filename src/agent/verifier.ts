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

  const verificationTask =
    `VERIFICATION CHECK — DO NOT EMIT AN ACTION VERB.\n` +
    `\n` +
    `Original goal: ${args.task}\n` +
    `\n` +
    `The agent has just claimed this goal is achieved. Compare the goal ` +
    `to what's visibly on the screenshot. Be skeptical but fair: if the ` +
    `goal is partially achieved or the UI is mid-animation, lean toward ` +
    `VERIFIED unless something is clearly missing or wrong.${snapshotBlock}\n` +
    `\n` +
    `Reply with EXACTLY ONE LINE:\n` +
    `  VERIFIED                       (the screen confirms the goal landed)\n` +
    `  RETRY: <one-sentence reason>   (the screen contradicts the claim)\n` +
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
