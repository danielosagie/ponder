/**
 * Extractor — the agent's "answer."
 *
 * The narrator gives an 18-word friendly sentence ("Done — Marketplace is
 * loaded"). That's not what the user asked for when they said "report back
 * with which items I have for sale." The extractor is the missing piece: it
 * runs once at end-of-run, reads the final page state (Playwriter snapshot
 * if Chrome was active, last screenshot otherwise), and answers the
 * original task in plain text.
 *
 * Output is variable-length on purpose. A list-question gets a list. A
 * yes/no question gets a sentence. A procedural task gets a one-liner
 * confirming what was done.
 *
 * Reuses the planner's `provider.plan()` transport — no new HTTP code, no
 * new auth, the existing AbortController hooks Stop into the extract call
 * the same way it does into ground/plan calls. Cancellable via the loop's
 * shared signal, but NOT raced against a timeout — this is the deliverable,
 * not a flourish.
 */

import type { ProviderClient } from "./types";
import type { BrowserSnapshot } from "./browser/types";

export interface ExtractInput {
  /** The original user prompt, exactly as typed. */
  task: string;
  /** Every action emitted during the run, in order. Helps the model
   *  understand what "the agent just did" so its answer is grounded. */
  history: string[];
  /** Final-frame screenshot. Always present even when Playwriter wired in,
   *  because some tasks (Figma, native apps) won't have a browserSnapshot. */
  lastScreenshotB64: string;
  /** Accessibility tree of the active Chrome tab, when available. The
   *  extractor strongly prefers this when present — it's structured text,
   *  cheaper than a screenshot, and the planner is already trained to read
   *  similar formats. */
  browserSnapshot?: BrowserSnapshot;
  /** Final outcome bucket, so the system prompt can shape the answer
   *  ("done" → answer the question; "exhausted" → say what's missing). */
  outcome: "done" | "cancelled" | "exhausted" | "error";
  /** Cancel signal threaded from the agent loop's AbortController so a
   *  Stop press kills the extract HTTP call along with everything else. */
  signal?: AbortSignal;
}

export interface ExtractorClient {
  extract(args: ExtractInput): Promise<string>;
}

export interface ExtractorConfig {
  /** Hard cap on history lines included in the prompt. Earlier lines are
   *  rarely useful for the answer; the final state matters most. */
  historyLimit?: number;
  /** Hard cap on a11y snapshot size. Beyond ~30KB the planner starts losing
   *  focus and answer quality drops. */
  snapshotLimit?: number;
}

const SYSTEM_PROMPT = `You are the answerer of a computer-use agent. The agent has finished a task. Using ONLY the final page/screen state and the action history, answer the user's original question.

Style rules:
- If the question is informational ("what items…", "list…", "find…", "how much…", "which…", "is there…"): produce a concise plain-text answer with concrete details from the screen — names, prices, counts, dates. If it's a list, use a bulleted list with one line per item. No more than 12 items unless the user asked for more.
- If the question is procedural ("open X", "click Y", "navigate to Z"): confirm what was done in one or two sentences.
- If the agent ran out of steps or was cancelled before the answer was reachable: say what's visible right now and what's missing.
- If you cannot answer from the available state: say so explicitly. Do NOT invent details. Better to say "couldn't find the listings page" than to make up items.

Format:
- Plain text. No markdown headers. Bullet lists are OK for inventories.
- No "I observed", "I saw", "the agent did X". Speak directly to the user.
- No emojis. No quotes wrapping the whole answer.`;

export function createExtractor(
  provider: ProviderClient,
  cfg: ExtractorConfig = {},
): ExtractorClient {
  const historyLimit = cfg.historyLimit ?? 30;
  const snapshotLimit = cfg.snapshotLimit ?? 30_000;

  return {
    async extract(args: ExtractInput): Promise<string> {
      const recent = args.history.slice(-historyLimit);
      const historyBlock =
        recent.length === 0
          ? "(no actions recorded)"
          : recent.map((h, i) => `${i + 1}. ${h}`).join("\n");

      // Prefer the structured snapshot when present. The provider's plan()
      // accepts a screenshot in its dedicated slot, so we still pass the
      // last screenshot bytes — that gives the model both signals when
      // Chrome was active. Snapshot text goes in the user-content text
      // alongside the question.
      let snapshotBlock = "";
      if (args.browserSnapshot) {
        const ax = args.browserSnapshot.ax;
        const trimmed =
          ax.length > snapshotLimit
            ? ax.slice(0, snapshotLimit) + "\n…(truncated)"
            : ax;
        snapshotBlock =
          `\nPage URL: ${args.browserSnapshot.url}\n` +
          `Page title: ${args.browserSnapshot.title}\n` +
          `Page accessibility tree:\n${trimmed}\n`;
      }

      const outcomeNote =
        args.outcome === "done"
          ? ""
          : args.outcome === "cancelled"
            ? "\nNote: the agent was cancelled before finishing — answer based on the partial state shown."
            : args.outcome === "exhausted"
              ? "\nNote: the agent ran out of steps before fully completing the task — say what's visible and what's missing."
              : "\nNote: the agent hit an error during the run — answer best-effort from the partial state.";

      const userText =
        `ORIGINAL USER REQUEST: ${args.task}\n\n` +
        `Action history (${recent.length} of ${args.history.length} most recent):\n${historyBlock}\n` +
        snapshotBlock +
        outcomeNote +
        "\n\nAnswer the user's request now.";

      // We hijack provider.plan() because it already speaks the right HTTP
      // dialect with the right auth and the right cancellation wiring. The
      // "task" field carries our extractor system prompt + the assembled
      // user message; the screenshot slot carries the final frame. Empty
      // history because the planner's history is for *its* per-step
      // self-context, not relevant here.
      const result = await provider.plan({
        task: SYSTEM_PROMPT + "\n\n---\n\n" + userText,
        history: [],
        screenshotB64: args.lastScreenshotB64,
        screen: [0, 0],
        signal: args.signal,
      });
      return result.action.trim();
    },
  };
}
