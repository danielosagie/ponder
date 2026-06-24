/**
 * Extractor — the agent's "answer."
 *
 * Runs once at end-of-run, reads the final page state (Playwriter
 * snapshot + last screenshot + action history), and produces the
 * conversational reply to the user's original question.
 *
 * Two transports, in priority order:
 *
 *   1. Local Ollama (PRIMARY).
 *      Fast (~1s), free, never rate-limits, always returns SOMETHING.
 *      Text-only, so it leans on the browser snapshot + action history
 *      when those are present. For non-browser tasks (no snapshot) it
 *      still produces a sensible "I did X, Y" answer from history alone.
 *
 *   2. Holo3 / hcompany via provider.plan() (FALLBACK).
 *      Multimodal — only used if Ollama isn't available AND we have a
 *      screenshot worth showing. Hcompany is rate-limited and slow, so
 *      we treat it as the resort, not the default.
 *
 * Last-resort: if BOTH transports fail (Ollama down, hcompany rate-
 * limited), we emit a templated sentence from the action history alone
 * so the user always sees something conversational. The buddy bubble
 * never goes silent.
 */

import { Ollama } from "ollama";
import type { ProviderClient } from "./types";
import type { BrowserSnapshot } from "./browser/types";

export interface ExtractInput {
  /** The original user prompt, exactly as typed. */
  task: string;
  /** Every action emitted during the run, in order. */
  history: string[];
  /** Final-frame screenshot. */
  lastScreenshotB64: string;
  /** Accessibility tree of the active Chrome tab, when available. */
  browserSnapshot?: BrowserSnapshot;
  /** Plain text scrape of the active page, when available. The
   *  accessibility tree only carries roles+names — not the actual
   *  copy/prices/listing content. Without this, the closer can only
   *  describe "what's interactable" rather than "what was found". */
  pageText?: string;
  /** Final outcome bucket. */
  outcome: "done" | "cancelled" | "exhausted" | "error";
  /** Cancel signal. */
  signal?: AbortSignal;
}

export interface ExtractorClient {
  extract(args: ExtractInput): Promise<string>;
}

export interface ExtractorConfig {
  historyLimit?: number;
  snapshotLimit?: number;
  /** Ollama host. Defaults to OLLAMA_HOST env or 127.0.0.1:11434. */
  ollamaHost?: string;
  /** Ollama model. Defaults to EXTRACTOR_MODEL or qwen3.5:0.8b. */
  ollamaModel?: string;
  /** Hard cap on local-LLM call. */
  ollamaTimeoutMs?: number;
}

const SYSTEM_PROMPT = `You are the closing voice of a computer-use agent. The agent just FINISHED a task — your job is the POST-MORTEM, not a re-statement of the request.

HARD RULE — NEVER restate, paraphrase, or re-plan the original request. The user already typed it; they don't need to hear it back. Skip phrases like "I will…", "Let me…", "I'm going to…", "First I'll…", or any forward-looking plan. Your reply describes what HAPPENED, in past tense, and what was FOUND.

Three cases — pick exactly one and write the reply for it:

A. INFORMATIONAL request was answered (the user asked for items / prices / facts and the page text contains them):
   • Lead with the answer. First sentence is the headline ("Found 3 listings under $3000:").
   • Then a hyphen-bulleted list pulled from the PAGE TEXT — title, price, location, link if you have one. Up to 12 items.
   • If you have fewer items than asked, say so in the headline ("Found 2 of the 3 you wanted because…").

B. PROCEDURAL task succeeded (the user asked you to navigate / configure / click and the action history confirms it):
   • One short past-tense sentence: "Opened Marketplace and applied the Marietta + $2.5k–$3k filters."
   • No list needed unless the user asked you to verify multiple things.

C. RUN STOPPED early (outcome is exhausted / cancelled / error, OR the page text doesn't contain the answer):
   • Lead with what blocked you in past tense: "Got stuck on the location filter — Apply stayed disabled because the dropdown suggestion didn't render in time."
   • Then describe what's visibly on the page right now (1 sentence).
   • Then ONE concrete suggestion the user can try: "Try the same prompt again — Marketplace's autocomplete is sometimes laggy on first load." Don't suggest more than one.
   • If the failure-annotated history shows clicked-disabled / overlay-intercepted / ref-vanished events, mention them — they're the diagnostic.

Format:
- Plain text. No markdown headers, no asterisks, no code blocks, no emojis, no outer quotes.
- Hyphen bullets for lists.
- Speak as the agent in first person past tense ("I found…", "I tried…"). Never "the agent…".
- Procedural confirmations: 1–2 sentences. Informational answers: headline + up to 12 bullets. Failure post-mortems: 2–4 sentences total.
- Source the bullets from PAGE TEXT (the actual copy on the page), not from the action history. The action history is for diagnosing failure, not for listing results.

If you catch yourself starting with "I will" / "Let me" / "First, I'll" — STOP. Rewrite in past tense.`;

function templatedFallback(args: ExtractInput): string {
  // Last-resort line when both LLM paths fail. Use the action history
  // and outcome to say SOMETHING useful instead of going silent.
  const recent = args.history.filter((h) => h !== "(empty)").slice(-5);
  const lastAction = recent.at(-1);
  if (args.outcome === "exhausted") {
    return `I got stuck before finishing "${args.task}". Last thing I tried was: ${lastAction ?? "(no actions)"}. Try again with a more specific prompt.`;
  }
  if (args.outcome === "cancelled") {
    return `Stopped "${args.task}" mid-run.`;
  }
  if (args.outcome === "error") {
    return `Hit an error working on "${args.task}". The action history was: ${recent.join(" → ") || "(none)"}.`;
  }
  return `Done — ${recent.join(" → ") || "no actions recorded"}.`;
}

function buildUserMessage(
  args: ExtractInput,
  cfg: Required<Pick<ExtractorConfig, "historyLimit" | "snapshotLimit">>,
): string {
  const recent = args.history.slice(-cfg.historyLimit);
  const historyBlock =
    recent.length === 0
      ? "(no actions recorded)"
      : recent.map((h, i) => `${i + 1}. ${h}`).join("\n");

  // Page text comes FIRST in the user message (after the outcome): for
  // informational tasks this is the answer source. The accessibility
  // tree alone carries roles + names ("button 'Search'") but no listing
  // copy or prices — without pageText the closer falls back to history,
  // which is what was making it sound like a plan re-statement.
  let pageTextBlock = "";
  if (args.pageText && args.pageText.trim()) {
    const text = args.pageText.trim();
    // The page text is potentially huge (50KB cap from readText); we
    // give the closer a generous window because this is THE source of
    // listing details, but still cap it so a runaway page doesn't blow
    // the model's context.
    const cap = Math.max(cfg.snapshotLimit, 30_000);
    const trimmed = text.length > cap ? text.slice(0, cap) + "\n…(truncated)" : text;
    pageTextBlock = `\nPAGE TEXT (final, this is your source for listings/prices/facts):\n${trimmed}\n`;
  }

  let snapshotBlock = "";
  if (args.browserSnapshot) {
    const ax = args.browserSnapshot.ax;
    const trimmed =
      ax.length > cfg.snapshotLimit
        ? ax.slice(0, cfg.snapshotLimit) + "\n…(truncated)"
        : ax;
    snapshotBlock =
      `\nFinal page: ${args.browserSnapshot.title} (${args.browserSnapshot.url})\n` +
      `Interactive elements still on screen:\n${trimmed}\n`;
  }

  const outcomeLabel =
    args.outcome === "done"
      ? "OUTCOME: done — the run completed normally."
      : args.outcome === "cancelled"
        ? "OUTCOME: cancelled — the user stopped the run mid-flight. Describe the partial state."
        : args.outcome === "exhausted"
          ? "OUTCOME: exhausted — the run hit the step budget before finishing. Diagnose what blocked it from the failure-annotated history (look for `(failed: ...)` and `(rejected: ...)` entries)."
          : "OUTCOME: error — something threw during the run. Best-effort summary, mention the error if visible in history.";

  // Order is deliberate: OUTCOME → PAGE TEXT → SNAPSHOT → HISTORY → TASK.
  // The model's attention bias is strongest on what comes first; putting
  // the original task last (and labeled as context, not a request) is
  // what stops the closer from treating this prompt as "execute the
  // task" and emitting plan-style "I will open Chrome…" prose instead
  // of a post-mortem.
  return (
    `${outcomeLabel}\n` +
    pageTextBlock +
    snapshotBlock +
    `\nWhat the agent actually did (most recent ${recent.length} of ${args.history.length} actions; entries with "(failed: …)" / "(rejected: …)" are diagnostic):\n${historyBlock}\n` +
    `\n--- context only, do NOT restate ---\n` +
    `Original task the user typed: ${args.task}\n` +
    `\nWrite the post-mortem reply now. Past tense. No plan, no "I will". If informational, lead with the answer; if procedural, confirm what was done; if stuck, diagnose + one suggestion.`
  );
}

function stripThink(text: string): string {
  // Qwen3 emits <think>...</think> reasoning when enabled. Strip it so
  // the answer doesn't include the model's internal monologue.
  let out = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const open = out.indexOf("<think>");
  if (open !== -1) out = out.slice(0, open);
  return out
    .replace(/^\s*<\/think>\s*/i, "")
    .trim()
    .replace(/^["'“]+|["'”]+$/g, "")
    .trim();
}

export function createExtractor(
  provider: ProviderClient | null,
  cfg: ExtractorConfig = {},
): ExtractorClient {
  const historyLimit = cfg.historyLimit ?? 30;
  const snapshotLimit = cfg.snapshotLimit ?? 30_000;
  const ollama = new Ollama({
    host:
      cfg.ollamaHost ??
      process.env.EXTRACTOR_HOST ??
      process.env.OLLAMA_HOST ??
      "http://127.0.0.1:11434",
  });
  const ollamaModel =
    cfg.ollamaModel ??
    process.env.EXTRACTOR_MODEL ??
    process.env.NARRATOR_MODEL ??
    "qwen3.5:0.8b";
  const ollamaTimeoutMs =
    cfg.ollamaTimeoutMs ??
    Number(process.env.EXTRACTOR_TIMEOUT_MS ?? 30_000);

  async function tryOllama(args: ExtractInput): Promise<string | null> {
    const userMsg = buildUserMessage(args, { historyLimit, snapshotLimit });
    try {
      const result = await Promise.race([
        ollama.chat({
          model: ollamaModel,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userMsg },
          ],
          // think: false — disable Qwen3 reasoning at the API level. The
          // closer was producing empty / cut-off replies because the
          // <think> block burned the full num_predict budget before any
          // visible content emerged (same root cause as the router
          // empty-response bug, fixed there in the previous patch). With
          // reasoning off, the post-mortem text comes out cleanly and we
          // can keep num_predict at 512 for proper list-style answers.
          think: false,
          // Higher temperature than the router because we want a
          // conversational tone, not a one-line decision.
          options: { temperature: 0.5, num_predict: 512 },
        }),
        new Promise<never>((_, rej) =>
          setTimeout(
            () => rej(new Error("extractor (ollama) timeout")),
            ollamaTimeoutMs,
          ),
        ),
      ]);
      const raw = (result as { message: { content: string } }).message.content;
      const cleaned = stripThink(raw);
      console.log(
        `[extract] ollama (${ollamaModel}) → ${cleaned.length}b`,
      );
      return cleaned || null;
    } catch (e) {
      console.warn(
        `[extract] ollama failed (${e instanceof Error ? e.message : String(e)}) — trying fallback`,
      );
      return null;
    }
  }

  async function tryProvider(args: ExtractInput): Promise<string | null> {
    if (!provider) return null;
    const userMsg = buildUserMessage(args, { historyLimit, snapshotLimit });
    try {
      const result = await provider.plan({
        task: SYSTEM_PROMPT + "\n\n---\n\n" + userMsg,
        history: [],
        screenshotB64: args.lastScreenshotB64,
        screen: [0, 0],
        signal: args.signal,
      });
      const text = result.action.trim();
      console.log(`[extract] provider(${provider.name}) → ${text.length}b`);
      return text || null;
    } catch (e) {
      console.warn(
        `[extract] provider failed (${e instanceof Error ? e.message : String(e)})`,
      );
      return null;
    }
  }

  return {
    async extract(args: ExtractInput): Promise<string> {
      // Composite mode: the provider IS a frontier-class hosted planner
      // — strictly better at the post-mortem than the 0.8B local model
      // (live-observed: qwen3.5:0.8b emitted a 3-BYTE "answer" to a
      // marketplace task), and multimodal so it can read the final
      // frame. Use it FIRST; Ollama becomes the offline fallback.
      const order =
        provider?.name === "composite"
          ? ([tryProvider, tryOllama] as const)
          : ([tryOllama, tryProvider] as const);
      for (const transport of order) {
        const answer = await transport(args);
        if (answer) return answer;
      }

      // Last resort: templated. The buddy NEVER goes silent.
      console.warn("[extract] both LLM paths failed — using templated fallback");
      return templatedFallback(args);
    },
  };
}
