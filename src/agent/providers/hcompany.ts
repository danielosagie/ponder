/**
 * H Company hosted API provider — https://api.hcompany.ai/v1/
 *
 * This is the official Holo3 inference platform. Compared to self-hosting
 * on Modal with llama.cpp:
 *   - No GPU infrastructure (zero idle cost; pay per token).
 *   - Native model — full quality, no quantization artifacts.
 *   - Chat template + reasoning are handled server-side; we just send
 *     OpenAI-format messages and get answers back.
 *   - Structured outputs use `extra_body.structured_outputs.json` instead
 *     of llama.cpp's `grammar` field. Same idea, different syntax.
 *
 * Auth: HAI_API_KEY env var. Get one at https://hub.hcompany.ai (Portal-H).
 *
 * Reference: https://hub.hcompany.ai/llms.txt → Quickstart docs
 */
import type { ProviderClient, PlanResult, GroundResult } from "../types";

interface HCompanyConfig {
  apiKey: string;
  model?: string; // default "holo3-35b-a3b"
  baseUrl?: string; // default "https://api.hcompany.ai/v1"
  fetchImpl?: typeof fetch;
}

/**
 * Remove `<think>...</think>` blocks AND any unclosed `<think>...` prefix.
 * Holo3-A3B's reasoning emits the opening tag immediately and we sometimes
 * truncate before the close tag arrives, leaving the closing-regex no match
 * and the whole answer trapped inside the opening tag. This helper handles
 * both shapes safely.
 */
function stripThink(text: string): string {
  // Drop any complete <think>...</think> blocks first.
  let out = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  // If we still have an opening <think> with no close, drop everything from
  // that tag forward — the answer (if any) sits AFTER the closing tag, but
  // by definition there is no close, so nothing useful is being kept anyway.
  // Otherwise we'd return the reasoning instead of the action.
  const openIdx = out.indexOf("<think>");
  if (openIdx !== -1) out = out.slice(0, openIdx);
  // Some servers leak just a stray "</think>" at the start when reasoning
  // was empty. Strip it.
  out = out.replace(/^\s*<\/think>\s*/i, "");
  return out.trim();
}

// JSON Schema for the grounder's coordinate output. Matches the Pydantic
// example in the H Company quickstart: `class ClickCoordinates(BaseModel)`.
const CLICK_COORDINATES_SCHEMA = {
  type: "object",
  properties: {
    x: { type: "integer", description: "The x coordinate (0-1000)." },
    y: { type: "integer", description: "The y coordinate (0-1000)." },
  },
  required: ["x", "y"],
  additionalProperties: false,
} as const;

export function createHCompanyProvider(cfg: HCompanyConfig): ProviderClient {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const baseUrl = cfg.baseUrl ?? "https://api.hcompany.ai/v1";
  const model = cfg.model ?? "holo3-35b-a3b";

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
  };

  async function chatCompletion(
    body: Record<string, unknown>,
    timeoutMs = 60_000,
    externalSignal?: AbortSignal,
  ): Promise<{
    choices: Array<{ message: { content: string }; finish_reason?: string }>;
    usage?: Record<string, number>;
  }> {
    if (!cfg.apiKey || !cfg.apiKey.trim()) {
      throw new Error(
        "HAI_API_KEY not set. Get one at https://hub.hcompany.ai (Portal-H), " +
          "add `HAI_API_KEY=hai_...` to your .env, then restart the app.",
      );
    }

    // 429 retry with exponential backoff. The default H Company tier is
    // ~10 RPM, and we issue plan+ground per step — easy to trip during a
    // multi-step task. Wait the time the server suggests (Retry-After header
    // in seconds, or fall back to exponential), then retry up to 3 times
    // before bubbling the error.
    let attempt = 0;
    const maxAttempts = 3;
    while (true) {
      // Composite signal: abort if the caller's signal aborts (Stop pressed)
      // OR our internal timeout fires. Either path collapses to one ctrl.
      if (externalSignal?.aborted) {
        throw new Error("hcompany cancelled");
      }
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const onExternalAbort = () => ctrl.abort();
      externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

      let res: Response;
      try {
        res = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({ model, ...body }),
          signal: ctrl.signal,
        });
      } catch (e: unknown) {
        // External cancel turns into a clean "cancelled" error so the loop
        // can return early without surfacing a scary fetch-aborted trace.
        if (externalSignal?.aborted) {
          throw new Error("hcompany cancelled");
        }
        const msg =
          e instanceof Error ? e.message : typeof e === "string" ? e : "fetch failed";
        throw new Error(`hcompany network: ${msg}`);
      } finally {
        clearTimeout(t);
        externalSignal?.removeEventListener("abort", onExternalAbort);
      }

      if (res.ok) return (await res.json()) as never;

      const text = await res.text().catch(() => "");
      if (res.status === 401) {
        throw new Error(
          `hcompany 401 unauthorized — check HAI_API_KEY. body: ${text.slice(0, 200)}`,
        );
      }
      if (res.status === 404) {
        throw new Error(
          `hcompany 404 — model "${model}" not found at ${baseUrl}. body: ${text.slice(0, 200)}`,
        );
      }
      if (res.status === 429 && attempt < maxAttempts) {
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        const wait = retryAfter ?? Math.min(15_000, 2_000 * 2 ** attempt);
        console.warn(
          `[hcompany] 429 rate limit — backing off ${wait}ms (attempt ${attempt + 1}/${maxAttempts})`,
        );
        await new Promise((r) => setTimeout(r, wait));
        attempt++;
        continue;
      }
      throw new Error(`hcompany ${res.status}: ${text.slice(0, 400)}`);
    }
  }

  function parseRetryAfter(header: string | null): number | null {
    if (!header) return null;
    const n = Number(header);
    if (Number.isFinite(n)) return Math.max(0, Math.round(n * 1000));
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
    return null;
  }

  function imageContent(screenshotB64: string): Array<Record<string, unknown>> {
    if (!screenshotB64) return [];
    return [
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${screenshotB64}` },
      },
    ];
  }

  return {
    name: "hcompany",

    async warm() {
      // Hosted API is always warm. Send a tiny ping to verify the key is
      // valid and the model is reachable.
      const t0 = Date.now();
      await chatCompletion(
        {
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 4,
          temperature: 0,
        },
        15_000,
      );
      return { ready: true, warmSeconds: (Date.now() - t0) / 1000 };
    },

    async plan(args): Promise<PlanResult> {
      // Numbered history with the most recent action labeled "← last" so the
      // model can directly compare it against the new screenshot. Without
      // numbering, multi-step plans drift because the model doesn't realize
      // how far through the task it is.
      const recent = args.history.slice(-5);
      const baseStep = args.history.length - recent.length;
      const historyBlock =
        recent.length === 0
          ? "(none — this is step 1)"
          : recent
              .map((h, i) => {
                const idx = baseStep + i + 1;
                const tag = i === recent.length - 1 ? "  ← last" : "";
                return `${idx}. ${h}${tag}`;
              })
              .join("\n");
      const dupWarning =
        args.history.length >= 2 &&
        args.history.at(-1) === args.history.at(-2)
          ? "\nCRITICAL WARNING: your last action was repeated. " +
            "If the screen did not change, switch strategy or return DONE."
          : "";

      const system =
        "You are the Brain of a computer-use agent. Look at the screenshot " +
        "and decide the SINGLE next action.\n" +
        "\n" +
        "Allowed actions — emit EXACTLY one of these on its own line:\n" +
        "  - click <thing>            (single left click)\n" +
        "  - double click <thing>\n" +
        '  - type "text"              (text in straight double-quotes)\n' +
        "  - press KEY                (e.g. press enter, press esc)\n" +
        "  - hotkey KEY+KEY           (e.g. hotkey cmd+space)\n" +
        "  - drag <source> to <target>  (drag-and-drop one element onto another)\n" +
        "  - scroll up | scroll down  (optionally with N steps)\n" +
        "  - wait Ns                  (when waiting for an app to load)\n" +
        "  - DONE                     (when the user's goal is visibly achieved)\n" +
        "\n" +
        "PREFER KEYBOARD WHEN IT IS FASTER OR MORE RELIABLE — clicks fight other\n" +
        "windows, keyboard shortcuts always work on the foreground app:\n" +
        "  • hotkey cmd+tab           → cycle apps (much faster than dock)\n" +
        "  • hotkey cmd+space         → Spotlight; type the app name to launch\n" +
        "  • hotkey cmd+`             → cycle WINDOWS within the current app\n" +
        "  • hotkey cmd+w / cmd+q     → close window / quit app\n" +
        "  • hotkey cmd+t / cmd+l     → new tab / focus address bar (browsers)\n" +
        "  • hotkey cmd+f             → in-page find\n" +
        "  • press tab / shift+tab    → next/previous form field\n" +
        "  • press enter              → submit the focused field\n" +
        "  • press esc                → close popovers, cancel modals\n" +
        "If you need to switch to an already-open app, prefer hotkey cmd+tab over\n" +
        "hunting for the dock icon. If the app isn't running yet, hotkey cmd+space\n" +
        "+ type the name + press enter is faster than navigating Finder.\n" +
        "\n" +
        "DRAG AND DROP — use when an element needs to MOVE, not be clicked:\n" +
        "  drag the file icon to the trash\n" +
        "  drag the slider handle to the right end\n" +
        "  drag the email to the archive folder\n" +
        "  drag the rectangle to the canvas\n" +
        "Both endpoints (source and destination) must be visible on screen.\n" +
        "If the destination is off-screen, scroll first.\n" +
        "\n" +
        "FORMAT RULES — these are non-negotiable:\n" +
        '  • Use the simple verb form: type "search" — NOT type({"text":"search"})\n' +
        "  • Do NOT chain actions. NEVER write `type X and press enter`. If you\n" +
        "    need to press a key after typing, that's the NEXT step.\n" +
        "  • Do NOT wrap actions in JSON, code blocks, or function-call syntax.\n" +
        "  • One short imperative sentence. No prose, no quotes around the\n" +
        "    whole sentence, no markdown.\n" +
        "\n" +
        "STOP CRITERIA — return DONE when ANY of these are true:\n" +
        "  • The user's goal is already visible on screen.\n" +
        "  • The requested app/window is now in the foreground.\n" +
        "  • Further actions would not bring you closer to the goal.\n" +
        "If you are unsure whether the task is complete, prefer DONE over " +
        "guessing more actions.\n" +
        "\n" +
        "Examples (good):\n" +
        "  hotkey cmd+tab\n" +
        '  click on the address bar\n' +
        '  type "figma stock"\n' +
        "  press enter\n" +
        "  drag the document.pdf icon to the trash\n" +
        "  DONE\n" +
        "\n" +
        "Examples (BAD — never emit these):\n" +
        '  type({"text":"figma"}) and press enter   ← chained + JSON\n' +
        '  "click on the icon"                      ← outer quotes\n' +
        "  Click the search box, then type figma    ← multi-step prose\n";
      const stepNum = args.history.length + 1;
      const userText =
        `USER GOAL: ${args.task}\n` +
        `Step ${stepNum} of up to 30. Screen: ${args.screen[0]}x${args.screen[1]}\n` +
        `Action history (most recent last):\n${historyBlock}${dupWarning}\n\n` +
        "Compare the screenshot to the goal:\n" +
        "  • If the goal is already visible / achieved → reply DONE.\n" +
        "  • If your last action did not change the screen → switch strategy or DONE.\n" +
        "  • Otherwise output the SINGLE next action that moves toward the goal.";

      const out = await chatCompletion(
        {
          messages: [
            { role: "system", content: system },
            {
              role: "user",
              content: [
                ...imageContent(args.screenshotB64),
                { type: "text", text: userText },
              ],
            },
          ],
          temperature: 0.2,
          // Bumped from 128 → 256 so a slightly verbose model never gets cut
          // off mid-sentence. The completion is a single short action sentence;
          // 256 is more than enough but cheap.
          max_tokens: 256,
          // Holo3 has reasoning always on by default. Disable via the H Company
          // / vLLM convention: `chat_template_kwargs.enable_thinking: false`.
          // (We previously sent `thinking: false`, which the server silently
          // ignored — the model burned all 128 max-tokens inside an unclosed
          // <think> block and returned an empty string. See
          // https://hub.hcompany.ai → Quickstart for the canonical shape.)
          chat_template_kwargs: { enable_thinking: false },
        },
        60_000,
        args.signal,
      );
      const text = out.choices[0]?.message.content?.trim() ?? "";
      const cleaned = stripThink(text);
      return { action: cleaned, usage: out.usage ?? {} };
    },

    async ground(args): Promise<GroundResult> {
      const out = await chatCompletion(
        {
          messages: [
            {
              role: "user",
              content: [
                ...imageContent(args.screenshotB64),
                {
                  type: "text",
                  text:
                    `Click target: ${args.instruction}\n` +
                    "Return the exact click coordinates as JSON " +
                    '{"x": <int 0-1000>, "y": <int 0-1000>} ' +
                    "normalized to a 1000x1000 grid over the screenshot.",
                },
              ],
            },
          ],
          temperature: 0,
          // Same reasoning: bump max_tokens so a JSON object always fits.
          max_tokens: 256,
          // Disable reasoning via the canonical H Company field. Without this
          // the model wraps its answer in a <think> block that eats the budget
          // before any coordinates are emitted. (Was `thinking: false`, ignored.)
          chat_template_kwargs: { enable_thinking: false },
          // H Company's structured-output mode — guarantees parseable JSON
          // matching the schema. Replaces llama.cpp's GBNF grammar.
          structured_outputs: { json: CLICK_COORDINATES_SCHEMA },
        },
        60_000,
        args.signal,
      );
      const raw = out.choices[0]?.message.content?.trim() ?? "";
      const cleaned = stripThink(raw);

      let rx = 0;
      let ry = 0;
      try {
        const parsed = JSON.parse(cleaned);
        rx = Math.round(Number(parsed.x));
        ry = Math.round(Number(parsed.y));
      } catch {
        // Fallback: pull the first two integers out of the string.
        const nums = cleaned.match(/\d+/g);
        if (!nums || nums.length < 2) {
          return { x: 0, y: 0, error: `could not parse coordinates: ${cleaned.slice(0, 120)}` };
        }
        rx = parseInt(nums[0]!, 10);
        ry = parseInt(nums[1]!, 10);
      }

      // Normalize 0-1000 grid → pixels (matches the Modal server-side rescale).
      const x = rx <= 1000
        ? Math.round((rx / 1000) * args.screen[0])
        : rx;
      const y = ry <= 1000
        ? Math.round((ry / 1000) * args.screen[1])
        : ry;
      return {
        x: Math.max(0, Math.min(args.screen[0] - 1, x)),
        y: Math.max(0, Math.min(args.screen[1] - 1, y)),
        raw: [rx, ry],
      };
    },
  };
}
