/**
 * Hierarchical planner — the agent's "manager."
 *
 * Holo3 is great at deciding the next pixel-level action ("click the search
 * bar", "type X", "press enter") but bad at staying oriented across a long
 * task. The classic failure: it sees a related-but-wrong UI element ("27
 * inch monitor 240hz" tab in Chrome's tab strip) and pursues it because the
 * surface text loosely matches the goal.
 *
 * The planner sits ABOVE the per-step loop. Before any pixels move, we ask a
 * small local model (qwen3:0.6b via Ollama by default — same infra as the
 * narrator) to decompose the user's task into 3-6 focused subtasks. The main
 * loop then runs Holo3 once per subtask, each with the OVERALL goal threaded
 * back into the prompt so it doesn't drift.
 *
 * Why a small model: this is a one-shot, low-stakes plan. We need 200 tokens
 * of structured output, no vision. qwen3:0.6b runs in <300ms on M1 and
 * doesn't need a GPU. If it's unavailable we fall back to flat (single-
 * subtask) execution — the system degrades gracefully to today's behavior.
 *
 * Configure via env:
 *   PLANNER_MODEL  — Ollama tag (default: qwen3:0.6b, falls through to NARRATOR_MODEL)
 *   PLANNER_HOST   — Ollama URL (default: NARRATOR_HOST → OLLAMA_HOST → 127.0.0.1:11434)
 *   PLANNER_TIMEOUT_MS — hard cap (default 8000)
 */
import { Ollama } from "ollama";

export interface PlannerConfig {
  host?: string;
  model?: string;
  /** Hard cap on planning time. Never let this block the run. */
  timeoutMs?: number;
}

export interface SubtaskPlan {
  /** Ordered list of subtasks for the inner loop to execute. */
  subtasks: string[];
  /** True if the planner produced multiple subtasks; false if we fell back. */
  decomposed: boolean;
  /** Human-readable note about the planner outcome — shown in logs/UI. */
  note: string;
}

/** Optional snapshot of what's CURRENTLY on screen, passed to the planner
 *  so it can skip already-completed setup steps (don't decompose
 *  "Open Chrome" if Chrome is already on the right URL). All fields
 *  optional — provide what's known. */
export interface PlannerContext {
  /** Active Chrome URL, if Chrome is the foreground app. */
  browserUrl?: string;
  /** Active Chrome page title, if available. */
  browserTitle?: string;
  /** Frontmost OS app name (e.g., "Chrome", "Finder", "Calculator"). */
  frontmostApp?: string;
}

export interface PlannerClient {
  plan(task: string, context?: PlannerContext): Promise<SubtaskPlan>;
  /** Cheap probe — true if the model responds at all. */
  available(): Promise<boolean>;
}

const SYSTEM_PROMPT = `You are a task planner for an autonomous computer-use agent that operates a real desktop.

The agent can click, type, scroll, and read the screen. A separate vision model handles every pixel-level action — your job is to give it a SHORT numbered plan of focused subtasks.

Rules:
- 3 to 6 subtasks. Never more.
- Each subtask is ONE focused phase of work: "Open Chrome", "Search Google for 'X'", "Open the most relevant non-ad result and skim the page".
- Phrase as imperative actions in present tense.
- DO NOT decompose into individual clicks, key presses, or coordinates — the lower-level vision model handles those.
- Plan in SCOPES, from outermost to innermost — this prevents the lower-level model from confusing the OS launcher, the browser address bar, and an in-page search bar (a common failure that wastes 10+ steps):
   1. OS scope — open or focus the right APP (Chrome, Slack, Finder, etc.).
   2. App scope — navigate to the right WINDOW / TAB / URL inside that app.
   3. Page scope — use the page's OWN controls (its search bar, its filter buttons, its result cards) to do the specific thing. NOT the OS search. NOT the browser address bar.
- The first subtask usually opens an app or focuses the right window.
- The last subtask reports the answer / confirms completion.
- If the task names specific criteria ("for a Dell SE2719HR", "rotating monitors", "in Marietta GA"), preserve those words in the relevant subtask so the lower-level model has them too.
- DEFAULT TOOL PREFERENCE: the lower-level executor leans ~70% keyboard / CLI-style verbs (browser.navigate, browser.type, hotkey, press) and ~30% mouse (browser.click, click) — that's already wired into its system prompt, you don't need to repeat it. Only override when the user explicitly states a different ratio in the task ("use cli 90% of the time", "no keyboard shortcuts", etc.) — in that case, preserve the user's wording verbatim in the relevant subtask. If the user says nothing about tool preference, say nothing.

Worked example — "find a 1997 Toyota Camry on Facebook Marketplace in Marietta GA under $3k":
  1. Open or switch to Chrome
  2. Navigate to facebook.com/marketplace
  3. Use the Marketplace search bar to search for "1997 Toyota Camry"
  4. Set the location filter to Marietta, GA and the price filter to under $3000
  5. Open the top matching listings and report their details
  DONE

Output format — exactly this, no preamble, no commentary:
1. <subtask>
2. <subtask>
3. <subtask>
DONE`;

/**
 * Parse the model's numbered plan into a list of subtask strings.
 *
 * Tolerates:
 *  - "1. ..." / "1) ..." / "- ..." / "* ..." prefixes
 *  - <think>...</think> reasoning blocks (Qwen3 emits these)
 *  - Stray prose before/after the list
 *
 * Stops parsing at a "DONE" line so the model can signal end-of-plan.
 */
function parsePlan(raw: string): string[] {
  // Strip closed reasoning blocks first.
  let body = raw.replace(/<think>[\s\S]*?<\/think>/g, "");
  // If we still have an UN-closed <think> (truncated reasoning), drop from
  // there forward — the answer (if any) sat after the close tag, but there
  // is no close, so nothing useful is being kept.
  const tIdx = body.indexOf("<think>");
  if (tIdx !== -1) body = body.slice(0, tIdx);

  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const subtasks: string[] = [];
  for (const line of lines) {
    if (/^DONE\b/i.test(line)) break;
    // Numbered or bulleted line.
    const m = line.match(/^(?:\d+[.)]|[-*•])\s+(.+?)\s*$/);
    if (m) {
      const text = m[1].trim();
      // Sanity: subtasks shouldn't be too short (single word "Click") or too
      // long (full paragraph) — both signal a parse miss.
      if (text.length >= 4 && text.length <= 200) subtasks.push(text);
    }
  }
  return subtasks;
}

export function createOllamaPlanner(cfg: PlannerConfig = {}): PlannerClient {
  const ollama = new Ollama({
    host:
      cfg.host ??
      process.env.PLANNER_HOST ??
      process.env.NARRATOR_HOST ??
      process.env.OLLAMA_HOST ??
      "http://127.0.0.1:11434",
  });
  const model =
    cfg.model ??
    process.env.PLANNER_MODEL ??
    process.env.NARRATOR_MODEL ??
    "qwen3.5:0.8b";
  const timeoutMs = cfg.timeoutMs ?? Number(process.env.PLANNER_TIMEOUT_MS ?? 8000);

  return {
    async plan(task: string, context?: PlannerContext): Promise<SubtaskPlan> {
      const t0 = Date.now();
      // Build a CURRENT-STATE block so the planner can skip subtasks
      // that are already satisfied. Without this the planner blindly
      // decomposes "add a photo to the listing" into "Open Chrome /
      // Navigate to URL / Click Add" even when Chrome is ALREADY on
      // the listing edit page — wasting 2 subtasks (and worse, the
      // first "Open Chrome" subtask sometimes navigates AWAY from the
      // listing back to the marketplace homepage).
      const stateBits: string[] = [];
      if (context?.frontmostApp) {
        stateBits.push(`Frontmost app: ${context.frontmostApp}`);
      }
      if (context?.browserUrl) {
        stateBits.push(`Active Chrome URL: ${context.browserUrl}`);
      }
      if (context?.browserTitle) {
        stateBits.push(`Active Chrome title: ${context.browserTitle}`);
      }
      const stateBlock =
        stateBits.length > 0
          ? `\n\nCurrent state:\n${stateBits.join("\n")}\n\nIMPORTANT: skip any setup subtask that's already satisfied by the current state above. If Chrome is already on the right URL, do NOT decompose "Open Chrome" or "Navigate to URL" as subtasks — start from the next thing to do.`
          : "";
      try {
        const result = await Promise.race([
          ollama.chat({
            model,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: `Task: ${task}${stateBlock}` },
            ],
            // think: false — disable Qwen3 reasoning at the API level.
            // Without this, qwen3.5:0.8b emits a 5-9s <think> block on
            // every prompt, which is why the planner kept hitting
            // "planner timeout" → "running flat" in every trace. With
            // reasoning off the same call returns in ~300-800ms and the
            // 8s timeout becomes generous headroom rather than a
            // permanent ceiling. Same fix the router and extractor got.
            think: false,
            // temperature: low so the plan is deterministic; we don't want
            // creativity here, we want the SHORTEST sensible decomposition.
            // num_predict: 256 is plenty for 6 subtasks at ~30 tokens each.
            options: { temperature: 0.3, num_predict: 256 },
          }),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error("planner timeout")), timeoutMs),
          ),
        ]);
        const raw = (result as { message: { content: string } }).message.content;
        const subtasks = parsePlan(raw);
        // Cap to 6 in case the model overshoots — keeps the per-subtask step
        // budget reasonable.
        const capped = subtasks.slice(0, 6);

        if (capped.length === 0) {
          // Parser found nothing — the model didn't follow the format. Fall
          // back to the original task as a single subtask. Better than
          // failing the whole run.
          return {
            subtasks: [task],
            decomposed: false,
            note: `planner returned an unparseable plan (${(Date.now() - t0)}ms) — running flat`,
          };
        }
        if (capped.length === 1) {
          // Single-subtask plan — there's no hierarchy to add. Just run flat.
          return {
            subtasks: capped,
            decomposed: false,
            note: `planner returned 1 subtask (${(Date.now() - t0)}ms) — running flat`,
          };
        }
        return {
          subtasks: capped,
          decomposed: true,
          note: `planner produced ${capped.length} subtasks (${(Date.now() - t0)}ms)`,
        };
      } catch (e) {
        return {
          subtasks: [task],
          decomposed: false,
          note: `planner unavailable (${e instanceof Error ? e.message : String(e)}) — running flat`,
        };
      }
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
