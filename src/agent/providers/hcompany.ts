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
  // holo3-35b-a3b is DEPRECATED by H Company effective 2026-06-15
  // (hub.hcompany.ai/quickstart). holo3-1-35b-a3b is the drop-in
  // successor (same family, Apache-2.0; H measured >25% harness
  // improvement in 3.1 via native function calling). Override with
  // cfg.model / HCOMPANY_MODEL to pin something else.
  const model = cfg.model ?? "holo3-1-35b-a3b";

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
      // KV-cache-friendly history: append-only, no shifting numbers, only the
      // most recent line carries a "← last" marker. Why this shape matters:
      //
      // The hcompany / OpenAI-compatible API auto-caches the LONGEST IDENTICAL
      // PREFIX of consecutive requests. If we slice history to the last 5 and
      // prepend absolute step numbers like `47. click on the search bar`,
      // EVERY step shifts the numbers and rewrites the entire history block —
      // the prefix changes mid-message and the cache invalidates after the
      // system prompt. Step 1's user message is `1. <action>`, step 2's is
      // `2. <action> ← last\n3. <action>`, and so on. No cache hit beyond the
      // system boundary.
      //
      // With append-only no-number history, step N's history is a strict
      // prefix of step N+1's history — modulo the moving "← last" marker,
      // which only mutates the trailing line. The cache hits the entire
      // (system + earlier history) prefix on every call after the first.
      //
      // We don't slice anymore: most runs are <50 steps and history entries
      // are short (one verb + brief annotation). The token cost is bounded
      // and amortized via the cache. If history ever grows pathological we
      // can introduce a hard cap (say 200 entries) — but slicing-then-
      // numbering was the worst of both worlds.
      const items = args.history;
      const historyBlock =
        items.length === 0
          ? "(none — this is step 1)"
          : items
              .map((h, i) => (i === items.length - 1 ? `${h}  ← last` : h))
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
        "TOOL CHOICE — DEFAULT to keyboard / CLI-style verbs (~70% of actions);\n" +
        "use mouse / browser.click for the ~30% of steps where it's strictly\n" +
        "necessary. CLI-style verbs are: hotkey, press, type, browser.navigate,\n" +
        "browser.type. Mouse verbs are: click, double click, browser.click.\n" +
        "If the user's task names a different ratio (e.g. 'use cli 90% of the\n" +
        "time'), HONOR THAT — they know their workflow. Do not override the\n" +
        "user's stated preference with a mouse click when a keyboard path\n" +
        "exists.\n" +
        "\n" +
        "KEYBOARD / CLI wins for (the 70%):\n" +
        "  • App switching: hotkey cmd+tab (cycle), hotkey cmd+`  (windows)\n" +
        "  • App launching: hotkey cmd+space → type name → press enter\n" +
        "  • Window/tab management: hotkey cmd+w, cmd+q, cmd+t\n" +
        "  • Browser address bar focus: hotkey cmd+l → type URL → press enter\n" +
        "    (or just emit browser.navigate <url> directly — even more CLI-ish)\n" +
        "  • In-page find: hotkey cmd+f → type query → press enter\n" +
        "  • Field navigation: press tab / shift+tab between inputs\n" +
        "  • Dismissing popovers / modals: press esc\n" +
        "  • Filling text fields: type or browser.type — never click-then-click\n" +
        "    when the field is already focused.\n" +
        "  • Submitting a form THAT IS keyboard-bindable (one focused field,\n" +
        "    standard 'Enter to submit' pattern). NOT for forms gated on a\n" +
        "    suggestion pick — see SEARCH/LOCATION FORM below.\n" +
        "\n" +
        "MOUSE / browser.click wins for (the 30%):\n" +
        "  • Picking a SPECIFIC item from a list (search-result card, dropdown\n" +
        "    suggestion, listing tile, sidebar entry) — these need an exact\n" +
        "    target, not a key.\n" +
        "  • Toggling a custom button, link, switch, or non-keyboard-bindable\n" +
        "    control where 'press enter' would be ambiguous.\n" +
        "  • Anywhere multiple fields could compete for keyboard focus and\n" +
        "    typing into the wrong one would be silent.\n" +
        "  • The third leg of TYPE → CLICK SUGGESTION → CLICK APPLY (see below).\n" +
        "\n" +
        "When in doubt: pick the KEYBOARD/CLI option. The keyboard path is\n" +
        "faster, doesn't fight the OS cursor, and reads like a CLI command —\n" +
        "which matches how the user thinks about most tasks.\n" +
        "\n" +
        "BROWSER TOOLS — when a Chrome page snapshot is attached to the user\n" +
        "message, you have a SECOND set of verbs targeting page elements by\n" +
        "accessibility ref. Use these for IN-PAGE web actions; use the OS-level\n" +
        "hotkey/press only for OS switching (Spotlight, cmd+tab, cmd+space).\n" +
        "  - browser.navigate <url>      open a URL in the active tab\n" +
        "  - browser.click <eN>          click an element by ref (e.g. browser.click e12)\n" +
        '  - browser.type <eN> "text"    type into a field by ref\n' +
        "  - browser.scroll page down    scroll the viewport (use this, not OS scroll)\n" +
        "  - browser.read [<eN>]         read page or element text\n" +
        "PREFER browser.* over click/type when a snapshot is available — refs are\n" +
        "exact (no grounding error) and disabled refs are flagged in the snapshot.\n" +
        "\n" +
        "SEARCH SCOPES — there are THREE different 'search' surfaces and they\n" +
        "serve DIFFERENT purposes. Picking the wrong one is a common failure\n" +
        "(typing 'facebook marketplace toyota camry' into Spotlight just opens\n" +
        "a local file search). Always identify the scope FIRST.\n" +
        "\n" +
        "1. OS / SYSTEM SEARCH — the OS-level launcher.\n" +
        "   • macOS: Spotlight (top of screen). Trigger: hotkey cmd+space.\n" +
        "   • Windows: Start search (bottom). Trigger: press win.\n" +
        "   • USE FOR: launching an app that isn't running ('open Chrome',\n" +
        "     'open Calculator'), or finding a local file by name.\n" +
        "   • DO NOT USE FOR: web search or in-site search.\n" +
        "\n" +
        "2. BROWSER ADDRESS BAR — the URL field at the top of the active tab.\n" +
        "   • Trigger: hotkey cmd+l → type URL → press enter,\n" +
        "     OR: browser.navigate <url> when a snapshot is attached.\n" +
        "   • USE FOR: jumping to a known URL (facebook.com/marketplace,\n" +
        "     amazon.com), or a generic Google search via the omnibox when no\n" +
        "     specific site applies.\n" +
        "   • DO NOT USE FOR: searching INSIDE a site that has its own search\n" +
        "     UI — you'd get Google results, not Marketplace listings.\n" +
        "\n" +
        "3. PAGE / SITE SEARCH — a search bar/box rendered by the website.\n" +
        "   • Trigger: browser.click <search-input-ref> → browser.type → pick a\n" +
        "     suggestion ref → click submit/apply (see SEARCH/LOCATION FORM).\n" +
        "   • USE FOR: searching Facebook Marketplace listings, Amazon products,\n" +
        "     YouTube videos, Gmail messages — anywhere the site has its own\n" +
        "     search UI with site-specific filters and results.\n" +
        "   • The page may have MULTIPLE site-search bars (top header search,\n" +
        "     left-rail filter search, modal search). Pick the one whose name\n" +
        "     matches the goal: 'Search Marketplace' for Marketplace, not the\n" +
        "     generic top-of-page Facebook search.\n" +
        "\n" +
        "TYPICAL FLOW for 'find X on site Y':\n" +
        "  a. Foreground Chrome — hotkey cmd+tab if it's already running, else\n" +
        "     hotkey cmd+space → 'chrome' → press enter.\n" +
        "  b. Land on site Y — browser.navigate https://y.com OR hotkey cmd+l\n" +
        "     → type URL → press enter.\n" +
        "  c. Use Y's OWN search bar — browser.click on the page search input,\n" +
        "     browser.type the query, pick a suggestion, then submit/apply.\n" +
        "\n" +
        "SEARCH / LOCATION FORM — TYPE → CLICK SUGGESTION → CLICK APPLY.\n" +
        'A "(disabled)" ref is UNCLICKABLE — clicking wastes 5s on a Playwright timeout.\n' +
        "When you typed into a search/location/combobox field and the submit button\n" +
        "(Apply / Search / Confirm) is disabled, your NEXT action MUST be\n" +
        'browser.click on a "(suggestion)" ref (or any role: option / menuitem /\n' +
        "listitem / link in the dropdown), NOT the disabled button, NOT pressing enter.\n" +
        "\n" +
        "  Snapshot:\n" +
        '    [e86] textbox "Location"\n' +
        '    [e91] option "Marietta, GA, United States" (suggestion)\n' +
        '    [e90] button "Apply" (disabled)\n' +
        '  Last action: browser.type e86 "Marietta, GA"\n' +
        "    Wrong: browser.click e90       ← it's disabled, this hangs for 5s\n" +
        "    Wrong: press enter             ← submit is via the button, not enter\n" +
        "    Right: browser.click e91       ← Apply un-disables on the next snapshot\n" +
        "\n" +
        "LIST TASKS — when the user asked for N items ('find 3 listings', 'list\n" +
        "the top 5 products', 'show me 4 jobs'), do NOT stop at the search-results\n" +
        "page. The search-results page only shows TITLES + PRICES; the user wants\n" +
        "DETAILS (description, location, posting date, seller, full price). For\n" +
        "each of the N items:\n" +
        "  1. browser.click the listing card to open its detail page.\n" +
        "  2. browser.read once the detail page loads — this captures the full\n" +
        "     copy that the closer will use to summarize.\n" +
        "  3. Either press the browser back button or click the next listing in\n" +
        "     the results — keep going until you've opened all N.\n" +
        "Only emit DONE after the Nth detail page has been read. Stopping at the\n" +
        "search-results page is a partial-credit failure — the closer will say\n" +
        "'I found N listings but couldn't open them' and the user has to redo it.\n" +
        "\n" +
        "STUCK RECOVERY — when an action keeps failing, SWITCH MODES instead of\n" +
        "retrying the same verb. Look at the most recent history line: if it\n" +
        "ends with `(failed: ...)` or `(rejected: ...)`, your last attempt did\n" +
        "not work and re-emitting the same verb won't either.\n" +
        "  • browser.click <ref> failed twice in a row (overlay intercepts,\n" +
        "    locator timeout, ref vanished) → switch to vision: emit\n" +
        "    'click on the <description>' so the grounder picks pixel coords\n" +
        "    from the screenshot. The mouse path uses cliclick / nut-js and\n" +
        "    bypasses the overlay/ref problem entirely.\n" +
        "  • browser.navigate <url> redirected → DO NOT re-emit the same URL\n" +
        "    (the runtime guard rejects it anyway). Either accept the redirected\n" +
        "    URL and use the page's on-page filters, or VISION_NEEDED.\n" +
        "  • browser.type into a focused field did nothing → the field may not\n" +
        "    actually be focused. Try `click on the <field name>` first, then\n" +
        "    type on the next step.\n" +
        "  • Same action repeated 2+ times in history → STOP and try a DIFFERENT\n" +
        "    verb (mouse instead of keyboard, vision instead of refs, scroll\n" +
        "    instead of click). The 70/30 keyboard/mouse default is a default,\n" +
        "    NOT a constraint when stuck.\n" +
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
        "  • Your output MUST start with one of the allowed verbs above (click,\n" +
        "    double click, type, press, hotkey, drag, scroll, wait, DONE, or a\n" +
        "    browser.* verb). Anything else — explanation, meta-reasoning,\n" +
        "    repetition of the prompt, 'The last step was incorrect…' — is\n" +
        "    invalid and the runtime will reject the step.\n" +
        "\n" +
        "HISTORY NOTATION — lines in Action history that start with `[note: …]`\n" +
        "are SYSTEM OBSERVATIONS about your prior steps (rejected clicks,\n" +
        "redirects, invalid output, failed executions). They are NOT prior\n" +
        "actions you emitted; do not quote them and do not echo them as your\n" +
        "next action. Read them as feedback, then emit a fresh action verb.\n" +
        "\n" +
        "STOP CRITERIA — return DONE when ANY of these are true:\n" +
        "  • The user's goal is already visible on screen.\n" +
        "  • The requested app/window is now in the foreground.\n" +
        "  • Further actions would not bring you closer to the goal.\n" +
        "  • The CURRENT subtask is 'navigate to X' / 'open X' / 'go to X' AND\n" +
        "    the page on screen IS X (its URL canonical-matches). The previous\n" +
        "    navigate succeeded; emit DONE so the next subtask can run.\n" +
        "  • The CURRENT subtask is 'click X' / 'open X' / 'focus X' and X is\n" +
        "    now focused/open in the snapshot. Don't re-click what you already\n" +
        "    clicked.\n" +
        "If you are unsure whether the task is complete, prefer DONE over " +
        "guessing more actions.\n" +
        "\n" +
        "DO NOT REPEAT YOUR LAST ACTION when the page reflects that it already\n" +
        "succeeded. If you just emitted browser.navigate URL_X and the snapshot\n" +
        "now shows you're AT URL_X, the next action MUST be DONE (not the same\n" +
        "navigate again). The runtime will short-circuit a no-op navigate as\n" +
        "DONE anyway, so saving you the round-trip if you recognize it first.\n" +
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
      // Build the user text in cache-friendly order: STABLE prefix (goal +
      // screen size + history that the model has seen on prior calls), then
      // the dynamic dup-warning, then the closing instruction (also stable).
      // The screenshot lives ahead of the text in the user content array
      // (image bytes change every step; the API treats per-image cache
      // separately).
      //
      // We deliberately drop the per-call `Step N of up to 30` counter — it
      // was a moving integer in a stable-looking string, which prevented
      // any prefix-cache hit on the user text. The model can count history
      // entries itself if it cares; the closing instruction tells it the
      // answer shape regardless of step number.
      const userText =
        `USER GOAL: ${args.task}\n` +
        `Screen: ${args.screen[0]}x${args.screen[1]}\n` +
        `Action history (most recent last; \`[note: …]\` lines are system observations, not your prior actions):\n${historyBlock}${dupWarning}\n\n` +
        "Compare the screenshot to the goal, then emit ONE action verb:\n" +
        "  • If the goal is already visible / achieved → emit DONE on its own.\n" +
        "  • If your last action did not change the screen → switch strategy or DONE.\n" +
        "  • Otherwise emit the SINGLE next action verb that moves toward the goal.\n" +
        "Your reply must START with one of: click | double click | type | press | hotkey | drag | scroll | wait | DONE | browser.* — nothing else.";

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
