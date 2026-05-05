/**
 * Narrator — the agent's "voice."
 *
 * The planner (Holo3) is great at deciding the next action but terrible at
 * sounding like a person. The narrator is a small, fast chat model — the
 * user's existing local Ollama model, defaulting to Qwen — that speaks the
 * intro ("got it, opening Figma…") and the post-task summary ("done — Figma
 * is open and showing the workspace") in the buddy bubble.
 *
 * Cheap, optional, and never blocks the loop: if the narrator fails (Ollama
 * not running, model not pulled, network glitch) we fall back to a templated
 * sentence. The agent never gets stuck waiting on this.
 *
 * Model: defaults to `qwen3:0.6b` (small + fast; the closest real Ollama tag
 * to "qwen 3.5 0.8b"). Override with NARRATOR_MODEL. Host via NARRATOR_HOST
 * (defaults to OLLAMA_HOST or http://127.0.0.1:11434).
 */
import { Ollama } from "ollama";

export type NarratorOutcome = "done" | "cancelled" | "exhausted" | "error";

export interface NarratorClient {
  /** Spoken when a task starts — friendly acknowledgment of what we're about to do. */
  intro(args: { task: string }): Promise<string>;
  /** Spoken when a task ends — short summary of what happened. */
  summary(args: {
    task: string;
    outcome: NarratorOutcome;
    history: string[];
    error?: string;
  }): Promise<string>;
  /** Cheap probe — true if the model responds at all. */
  available(): Promise<boolean>;
}

export interface NarratorConfig {
  host?: string;
  model?: string;
  /** Hard cap on time spent narrating. We never let it block a real run. */
  timeoutMs?: number;
}

const INTRO_SYSTEM = `You are the friendly assistant voice of an autonomous computer-use agent.
The agent is about to start working on the user's task.
Reply with ONE short sentence (max 14 words) acknowledging what you're going to do.
- Conversational, casual.
- No emojis. No quotes. No "I will" — speak in present tense ("opening...", "looking up...").
- No second sentence. No commentary. Just the line.

Examples:
  Task: "open Slack and search for jamie"
  → On it — opening Slack and finding jamie.
  Task: "what's the weather in tokyo"
  → Looking up Tokyo's weather now.
  Task: "open figma stock chart"
  → Opening Figma to find the stock chart.`;

const SUMMARY_SYSTEM = `You are the friendly assistant voice of an autonomous computer-use agent.
The agent just finished. Speak ONE short sentence (max 18 words) telling the user what happened.
- Past tense, conversational.
- If the agent ran out of steps or got stuck, say so plainly and suggest retrying with a clearer prompt.
- No emojis, no quotes, no apologies, no "I have done".
- Just the line.

Examples:
  Outcome done, task "open figma":
  → Done — Figma is open and ready.
  Outcome cancelled:
  → Stopped.
  Outcome exhausted, task "open slack":
  → Couldn't finish opening Slack — try again with a more specific prompt.
  Outcome error:
  → Hit an error: <reason>.`;

export function createOllamaNarrator(cfg: NarratorConfig = {}): NarratorClient {
  const ollama = new Ollama({
    host: cfg.host ?? process.env.NARRATOR_HOST ?? process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434",
  });
  const model = cfg.model ?? process.env.NARRATOR_MODEL ?? "qwen3.5:0.8b";
  const timeoutMs = cfg.timeoutMs ?? 6_000;

  async function generate(system: string, user: string): Promise<string> {
    // Race the chat against a timeout so a cold model load can't stall the run.
    const result = await Promise.race([
      ollama.chat({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        options: { temperature: 0.6, num_predict: 64 },
      }),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("narrator timeout")), timeoutMs),
      ),
    ]);
    const raw = (result as { message: { content: string } }).message.content;
    // Strip <think> blocks (Qwen3 emits reasoning by default), trim, drop
    // wrapping quotes the model loves to add despite the system prompt.
    return raw
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .trim()
      .replace(/^["'“]+|["'”]+$/g, "")
      .split("\n")[0]
      .trim();
  }

  return {
    async intro({ task }) {
      try {
        const text = await generate(INTRO_SYSTEM, `Task: "${task}"`);
        if (text) return text;
      } catch (e) {
        console.warn(
          `[narrator] intro failed (${e instanceof Error ? e.message : String(e)}) — using fallback`,
        );
      }
      // Templated fallback so the user always gets SOMETHING.
      return `On it — ${task.replace(/[.!?]+$/, "")}.`;
    },

    async summary({ task, outcome, error }) {
      try {
        const userMsg =
          `Task: "${task}"\n` +
          `Outcome: ${outcome}` +
          (error ? `\nError: ${error}` : "");
        const text = await generate(SUMMARY_SYSTEM, userMsg);
        if (text) return text;
      } catch (e) {
        console.warn(
          `[narrator] summary failed (${e instanceof Error ? e.message : String(e)}) — using fallback`,
        );
      }
      // Templated fallbacks per outcome.
      if (outcome === "done") return "Done.";
      if (outcome === "cancelled") return "Stopped.";
      if (outcome === "error") return `Hit an error: ${error ?? "unknown"}.`;
      return "Couldn't finish in 30 steps — try a more specific prompt.";
    },

    async available() {
      try {
        const list = await ollama.list();
        return list.models.some(
          (m) => m.name === model || m.name === `${model}:latest`,
        );
      } catch {
        return false;
      }
    },
  };
}
