/**
 * Composite provider: a SMART hosted planner + Holo3 as the grounder.
 *
 * The Surfer-2 split (H Company's own published architecture, arXiv
 * 2510.19949): a frontier-class model decides WHAT to do each step and
 * names the target in words; the small grounding model only resolves
 * words → coordinates. Their ablations show the planner is where the
 * intelligence belongs — and every remaining failure in our live traces
 * (router loops, planner timeouts, prose-as-action, never emitting
 * DONE) is a small-model planning failure, not a grounding failure.
 *
 * Implementation: ProviderClient already splits plan() from ground(),
 * so the composite is a thin wrapper —
 *   plan()        → the hosted planner (OpenAI-compatible chat API)
 *   ground()      → the wrapped executor (Modal Holo3), unchanged
 *   groundBatch() → executor's, when present
 *   step()        → deliberately ABSENT: the loop's combined-step fast
 *                   path only applies to Holo-only mode; composite mode
 *                   wants the split so each model does its half.
 * Everything that calls provider.plan — the brain, the verifier, the
 * completion probe, decompose() — upgrades automatically.
 *
 * Configuration (any OpenAI-compatible endpoint):
 *   GEMINI_API_KEY        → Gemini via its OpenAI-compat endpoint,
 *                           default model gemini-2.5-flash-lite
 *   or PLANNER_API_KEY + PLANNER_API_BASE (+ PLANNER_MODEL)
 *   PONDER_PLANNER=off    → disable wrapping entirely
 *   PLANNER_VISION=off    → text-only planning (URL + AX snapshot only;
 *                           cheaper, but blind on native-app surfaces)
 */
import type { GroundResult, PlanResult, ProviderClient } from "../types";

/** One OpenAI-compatible model endpoint. */
export interface ModelEndpoint {
  apiKey: string;
  /** Base URL ending at the OpenAI-compat root (we append /chat/completions). */
  apiBase: string;
  model: string;
}

export interface PlannerConfig {
  /**
   * Model for steps that DON'T need pixels — i.e. a Chrome DOM/a11y
   * snapshot is present so the planner reasons from text. Default:
   * DeepSeek v4 Flash via OpenRouter (cheap + fast). User directive
   * 2026-06-18: "deepseek flash v4 if it doesn't need image".
   */
  text: ModelEndpoint;
  /**
   * Model for steps that DO need pixels — native apps, canvas, or any
   * surface with no usable a11y snapshot. Default: Gemini 2.5 Flash.
   * User directive: "if it does [need image] use gemini flash 2.5".
   */
  vision: ModelEndpoint;
  /** Global kill-switch for images: force the text model on every step. */
  visionDisabled?: boolean;
  fetchImpl?: typeof fetch;
}

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const GEMINI_OPENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";

export function plannerConfigFromEnv(): PlannerConfig | null {
  if ((process.env.PONDER_PLANNER ?? "").toLowerCase() === "off") return null;

  const orKey = process.env.OPENROUTER_API_KEY;
  const gemKey = process.env.GEMINI_API_KEY;
  const genericKey = process.env.PLANNER_API_KEY;
  const genericBase = process.env.PLANNER_API_BASE;

  // Generic override (any OpenAI-compat endpoint) applies to both lanes
  // unless a more specific lane is configured below.
  const generic: ModelEndpoint | null =
    genericKey && genericBase
      ? {
          apiKey: genericKey,
          apiBase: genericBase.replace(/\/+$/, ""),
          model: process.env.PLANNER_MODEL ?? "deepseek/deepseek-chat",
        }
      : null;

  // VISION lane → Gemini 2.5 Flash. Prefer OpenRouter (one key for both),
  // else Gemini's own OpenAI-compat endpoint.
  let vision: ModelEndpoint | null = orKey
    ? { apiKey: orKey, apiBase: OPENROUTER_BASE, model: process.env.PLANNER_VISION_MODEL ?? "google/gemini-2.5-flash" }
    : gemKey
      ? { apiKey: gemKey, apiBase: GEMINI_OPENAI_BASE, model: process.env.PLANNER_VISION_MODEL ?? "gemini-2.5-flash" }
      : null;

  // TEXT lane → DeepSeek v4 Flash via OpenRouter.
  let text: ModelEndpoint | null = orKey
    ? { apiKey: orKey, apiBase: OPENROUTER_BASE, model: process.env.PLANNER_TEXT_MODEL ?? "deepseek/deepseek-v4-flash" }
    : null;

  // Generic endpoint fills any unset lane; then cross-fill so neither is null.
  text ??= generic;
  vision ??= generic;
  text ??= vision;
  vision ??= text;
  if (!text || !vision) return null;

  if (!orKey && !generic) {
    console.warn(
      "[planner] OPENROUTER_API_KEY not set — text + vision both fall back to " +
        `${vision.model}. Set OPENROUTER_API_KEY to use DeepSeek for text-only steps.`,
    );
  }

  return {
    text,
    vision,
    visionDisabled: (process.env.PLANNER_VISION ?? "on").toLowerCase() === "off",
  };
}

// Tight prompt — a frontier-class model needs the CONTRACT, not the
// 210-line scaffolding the small Holo brain required. The action
// vocabulary must match brain.ts's parser allow-list exactly.
const PLANNER_SYSTEM = `You are the planner of a computer-use agent driving a real macOS desktop and a real Chrome browser, one step at a time. Each turn you get the task, recent action history, and the current state (screenshot and/or a Chrome accessibility snapshot with [eN] element refs).

Reply with EXACTLY ONE action line — no prose, no markdown, no quotes around the whole line, no numbering. Allowed actions:
  click <visual description of the target>
  click precisely <description>   (tiny/dense targets — slower, sub-pixel grounding)
  double click <description>
  right click <description>
  cmd click <description>    (open-in-new-tab / add item to a multi-selection)
  shift click <description>  (range select)
  hover <description>        (move pointer WITHOUT clicking — hover menus, tooltips, reveal-on-hover buttons)
  type "text"            (types into whatever has keyboard focus — the ONLY way to type into OS UI: launchers, native dialogs, menus; append: and press enter)
  press KEY              (enter, esc, tab, …)
  press KEY N times      (e.g. press tab 3 times — form navigation in one step)
  hotkey KEY+KEY         (cmd+l, cmd+tab, … — note: cmd+space opens the system launcher, which is Spotlight on some Macs and Raycast on others; both launch apps the same way, but PREFER open app below)
  open app "Name"        (launch or foreground a macOS app directly — use this instead of cmd+space)
  drag <source description> to <target description>
  scroll up | scroll down
  scroll down at <description>   (aim the wheel at a SPECIFIC pane/sidebar/list; also: scroll up at …)
  wait Ns
  note "text"            (record COMPLETED progress only — "done 2 of 5: …". NOT for restating the task or narrating a plan; if you would write "the task is…/I need to…/I will…", do the action instead)
  browser.navigate <url>
  browser.click e<N>
  browser.type e<N> "text"      (optionally: and press enter — the e<N> ref is REQUIRED; browser.type with no ref is REJECTED. For OS-level typing use plain: type "text")
  browser.read
  browser.scroll page down | browser.scroll page up
  browser.scroll e<N> down | browser.scroll e<N> up   (scroll a SPECIFIC element's container — nested lists/sidebars where page scroll has no effect)
  DONE                   (the task's goal is VISIBLY achieved in the current state)
  INFEASIBLE: <reason>   (a concrete blocker makes the task impossible)

Long tasks (multiple items or phases): your action history is your only memory and it is long and lossy. Use note "…" to record durable state at every milestone — which items are DONE, which item you are ON, what remains, and facts you extracted (note "edited 2 of 5 listings: Blue Lamp, Red Chair done; next: Desk Fan"). Write a note after finishing EACH item, before starting the next. When unsure where you are, trust your latest note over re-deriving from the screen.

WORKING THROUGH A LIST ("do X to each / all of …"): you drive the iteration yourself — there is no outer loop doing it for you. FIRST check your history:
- Is there ALREADY a [page content: …] entry? Then step 1 is DONE — SKIP straight to step 2 and OPEN an item. Do NOT browser.read again.
- No [page content: …] yet? Do step 1 once.
The pattern:
1. browser.read the list page ONCE. The [page content: …] it produces is a FULL scrape — EVERY item (even off-screen), each with its attributes (status, date, view/click counts, price) and OFTEN a direct URL (".../edit/?listing_id=123" or a "Continue" link). That scrape is your worklist; act from it, don't click around to re-discover what it already shows. If the task filters by a CRITERION (slow-moving, unsold, older than X, low engagement), pick which items qualify by READING those attributes (e.g. still-listed + low clicks ⇒ slow-moving) and act on those; if it says each/all with no filter, every item qualifies. If nothing matches perfectly, act on the closest editable candidates rather than giving up.
2. Pick the FIRST unprocessed item from the worklist and OPEN it THIS step. Choose the open method in this order:
   a. If the read text shows a DIRECT edit/detail URL for it (e.g. ".../edit/?listing_id=123" or a "Continue" link) → browser.navigate to that URL. This is the most reliable — always prefer it.
   b. Else browser.click the item's own [eN] (its title link).
   c. Else if it only has a "More options" / "…" button → browser.click that ref ONCE. A MENU then appears in the NEXT snapshot (e.g. [eN] menuitem "Edit listing"); your next action is browser.click that "Edit listing" menuitem — do NOT click the "More options" button again (that just CLOSES the menu), and do NOT open "View listing" / the public item page (".../marketplace/item/…") — that is a DEAD END you cannot edit from.
   Always use browser.click <eN> with the ref from the snapshot — NOT a vision "click <description>" (vision is the slow fallback for when no ref exists). "read again" / "navigate to the list page again" / "scroll" are NOT opening an item — never choose those when a [page content: …] is already in history.
3. On the item's edit page, make the change AND submit in ONE action: browser.type <field eN> "new value" and press enter. Typing is REQUIRED before saving — NEVER click a Save button before you have typed THIS item's change (clicking Save on an unchanged form does nothing). If pressing enter does not save, THEN browser.click the Save ref. You start fresh on every item: the fact that you typed/saved a PREVIOUS item does not mean this one is done.
4. note "done N of M: <item name>; next: <item>" — then go back and OPEN the next item.
5. Repeat until every item is processed. Emit DONE only when your notes show all M items handled — and M is the FULL count from step 1, not just the easy ones. Before DONE, check: did you process the harder items (Sold / menu-only) too? If any remain, go do them via their More-options menu.

MODALITY ARBITRATION — you have two senses (the SCREENSHOT pixels and the page SNAPSHOT text) and two hands (browser.* DOM actions and vision actions). Use them to cover for each other:
- To EXTRACT information from a web page, use browser.read — the page's text will appear in your history as [page content: …]; read it there and act on it (often the task is DONE right after).
- browser.* works even when the controlled tab is NOT the visible tab; vision actions work on anything actually visible (native apps, dialogs, canvas, other windows).
- If a browser.* action fails or changes nothing twice → do the SAME thing with vision: click <description of what you SEE>.
- If a vision action misses or changes nothing twice → find the target's [eN] in the snapshot, or navigate directly by URL.
- If the screenshot and the snapshot disagree (they show different pages), the snapshot is the truth about the CONTROLLED tab; the screenshot is the truth about what is physically on screen (OS dialogs, overlays, other windows). Pick the hand that matches the surface you need to touch.

Anti-stall discipline:
- A note is NOT progress and NOT thinking-out-loud. NEVER narrate your plan or restate the task in a note ("the task is…", "I need to…", "I will…", "the page shows…"). If you can describe what you're about to do, just DO it this turn. A note is allowed ONLY to record a COMPLETED milestone ("done 2 of 5: Blue Lamp saved").
- When a [page content: …] entry is already in your history, the page is read — your action this turn MUST be a concrete browser.* / click action (open an item, type, save), never a note and never another read.
- [note: …] entries in the history are SYSTEM observations addressed to YOU — never repeat, quote, or paraphrase one as your action.
- If a scroll changes nothing twice in a row, STOP scrolling: either the content is fully loaded (act on what's visible) or the list is a nested scroll container (use: scroll down at <description of the list>).
- Prefer ACTING on currently-visible items over exhaustively revealing all items first — process visible items, then scroll for more.
- If the history says an action failed or changed nothing, do something DIFFERENT — a different element, a more specific URL, a keyboard path, or a vision click on what you can see.
- DON'T RE-GATHER WHAT YOU HAVE. Two hard rules:
  • If your history already contains a [page content: …] entry, you have ALREADY read this page — do NOT browser.read again. Your next action MUST act on what you read: OPEN the first unprocessed item (browser.navigate to its edit/detail URL if the page text shows one — e.g. ".../edit/?listing_id=…" — otherwise browser.click the item's [eN] ref or its "More options"/"Edit" control).
  • If the snapshot URL already matches where you were about to browser.navigate, you are ALREADY there — do NOT navigate to it. Move to the next sub-goal: read the page ONCE if you haven't, otherwise open a specific item.

Rules:
- NEVER interact with the agent's OWN control window — an Electron app showing provider buttons ("Modal", "H Company", "Local") and "Sessions"/"Automations" tabs. That is YOUR user interface, not the task's target. If it is what's on screen, your first move is to reach the task's real target (browser.navigate for websites, open app "Name" for native apps).
- When a [CHROME ACTIVE] snapshot is present, the browser is ALREADY connected and controllable: web goals NEVER need cmd+space, launching Chrome, or any app switching — go straight to browser.navigate <url>. Launch apps only for goals that genuinely live OUTSIDE the browser.
- When a [CHROME ACTIVE] snapshot is present, PREFER browser.* actions — they are precise and fast. Use the [eN] refs from the snapshot, never invented ones. browser.click/type/scroll take ONLY an e<N> ref — NEVER a name or label; if you don't know the ref, use a vision click (click <description>) instead.
- TO FILL A FORM FIELD (textbox / textarea / input shown in the snapshot), use browser.type <its eN> "text" DIRECTLY — it focuses and types in one step. Do NOT click the field first, and do NOT vision-click it. To submit, add "and press enter" or browser.click the Save/Submit ref.
- For navigation, construct the most specific URL you can instead of clicking through menus.
- Vision "click <description>" actions are grounded by a separate vision model: describe the target the way it LOOKS on screen ("the orange = button in the bottom-right of the keypad"), specific enough to be unambiguous.
- Check the history: if your previous action failed or changed nothing, do something DIFFERENT — a different element, a more specific URL, or a keyboard path.
- Emit DONE only when the CURRENT state shows the goal is met. Emit it promptly when it is — do not keep acting after success.
- One physical action per reply. Never chain.`;

interface ChatMessage {
  role: "system" | "user";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >;
}

export function createCompositeProvider(
  executor: ProviderClient,
  cfg: PlannerConfig,
): ProviderClient {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  // Planner-side history cap. The loop sends its full history array;
  // hosted planners have huge contexts so we keep generous tail context
  // without unbounded growth on marathon runs.
  const HISTORY_CAP = 30;

  async function plan(args: {
    task: string;
    history: string[];
    screenshotB64: string;
    screen: [number, number];
    signal?: AbortSignal;
  }): Promise<PlanResult> {
    // META prompts ride through provider.plan with their OWN output
    // contracts: the verifier wants "VERIFIED"/"RETRY: …", decompose
    // wants a JSON array. Forcing the one-action-line system prompt on
    // those breaks them (the planner would dutifully emit an action).
    // Detect by the markers those modules put at the top of the task.
    const isMeta =
      args.task.includes("VERIFICATION CHECK") ||
      args.task.startsWith("PLANNING REQUEST") ||
      args.task.startsWith("You are the closing voice"); // extractor post-mortem
    const systemPrompt = isMeta
      ? "You are a precise component inside a computer-use agent. Follow the output contract stated in the user message EXACTLY — no extra prose, no markdown."
      : PLANNER_SYSTEM;
    const tail = args.history.slice(-HISTORY_CAP);
    const historyBlock =
      tail.length > 0
        ? (args.history.length > HISTORY_CAP
            ? `(${args.history.length - HISTORY_CAP} earlier actions omitted)\n`
            : "") + tail.map((h) => `- ${h}`).join("\n")
        : "(none)";
    const userText =
      `${args.task}\n\n` +
      `Screen: ${args.screen[0]}x${args.screen[1]}\n` +
      `Action history (oldest first, most recent last):\n${historyBlock}\n\n` +
      `What is the single next action?`;
    // Route between the two model lanes by whether this step needs PIXELS:
    // - A Chrome DOM/a11y snapshot ("CHROME ACTIVE" / "[page content")
    //   means the page is fully described in TEXT → plan with the cheap
    //   text model (DeepSeek v4 Flash), no image. (User directive 2026-06-18:
    //   "deepseek flash v4 if it doesn't need image; if it does, gemini 2.5".)
    // - Otherwise, if an image is available, use the vision model
    //   (Gemini 2.5 Flash) and attach the screenshot. Meta prompts
    //   (verifier/extractor) keep the image when present — they judge the
    //   actual rendered state.
    // - An EMPTY screenshotB64 means the caller deliberately withheld the
    //   image (verifier with a hidden tab) → text lane regardless.
    const hasImage = args.screenshotB64.length > 0 && !cfg.visionDisabled;
    const domContext =
      /\bCHROME ACTIVE\b/.test(args.task) || /\[page content/.test(args.task);
    const attachImage = hasImage && (isMeta ? true : !domContext);
    const endpoint = attachImage ? cfg.vision : cfg.text;
    const url = `${endpoint.apiBase}/chat/completions`;
    const content: ChatMessage["content"] = attachImage
      ? [
          { type: "text", text: userText },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${args.screenshotB64}` },
          },
        ]
      : userText;
    const t0 = Date.now();
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${endpoint.apiKey}`,
        // OpenRouter likes these attribution headers (harmless elsewhere).
        ...(endpoint.apiBase.includes("openrouter.ai")
          ? { "HTTP-Referer": "https://holo.company", "X-Title": "holo3-agent" }
          : {}),
      },
      body: JSON.stringify({
        model: endpoint.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content },
        ] satisfies ChatMessage[],
        temperature: 0.2,
        // Meta prompts (decompose) can legitimately return a multi-line
        // JSON array; action prompts never need more than one line.
        max_tokens: isMeta ? 800 : 300,
      }),
      signal: args.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `planner ${endpoint.model} ${res.status}: ${body.slice(0, 300)}`,
      );
    }
    const out = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: Record<string, number>;
    };
    let raw = out.choices?.[0]?.message?.content ?? "";
    // Some OpenAI-compatible backends leak reasoning as inline
    // <think>…</think> (or stash content elsewhere and return "").
    raw = raw
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .replace(/^[\s\S]*<\/think>/, "");
    // Meta replies (VERIFIED/RETRY, JSON plan arrays) pass through
    // whole — their callers parse them. Action replies collapse to the
    // first non-empty line, stripped of stray markdown/quote wrappers.
    let action = isMeta
      ? raw.trim()
      : (raw
          .split("\n")
          .map((l) =>
            l.trim().replace(/^[`*">-]+\s*/, "").replace(/`+$/, ""),
          )
          .find((l) => l.length > 0) ?? "");
    if (!isMeta) {
      // Salvage the "[note: …]" wrapper form (live-observed: the model
      // bracket-wrapped its note, ran to the token cap, and the reply
      // parsed as invalid). Convert to the canonical note action.
      const noteWrap = action.match(/^\[note:\s*([\s\S]+?)\]?\s*$/i);
      if (noteWrap) {
        action = `note "${noteWrap[1].trim().replace(/"/g, "'").slice(0, 300)}"`;
      }
    }
    console.log(
      `[planner] ${endpoint.model} ${attachImage ? "[vision]" : "[text]"} (${Date.now() - t0}ms) → ${action.slice(0, 120)}`,
    );
    if (!action) {
      // Throw rather than return "" — the composite's plan() wrapper
      // catches this and falls back to the executor's own plan() for
      // this step (Holo3 plans it), so an empty/reasoning-only reply
      // degrades instead of burning an invalid-output strike.
      throw new Error(`planner ${endpoint.model} returned an empty action`);
    }
    return { action, usage: out.usage };
  }

  const composite: ProviderClient = {
    name: "composite",
    warm: () => executor.warm(),
    // Self-healing: a planner failure (rate limit, network, empty
    // reply) hands the step to the executor's own plan() — exactly the
    // pre-composite behavior — instead of erroring the loop.
    plan: async (args) => {
      try {
        return await plan(args);
      } catch (e) {
        if (args.signal?.aborted) throw e;
        console.warn(
          `[planner] ${cfg.text.model}/${cfg.vision.model} failed (${e instanceof Error ? e.message.split("\n")[0] : String(e)}) — falling back to ${executor.name}.plan for this step`,
        );
        return executor.plan(args);
      }
    },
    ground: (args: Parameters<ProviderClient["ground"]>[0]) =>
      executor.ground(args) as Promise<GroundResult>,
    // step intentionally omitted — composite wants the split path.
  };
  if (typeof executor.groundBatch === "function") {
    composite.groundBatch = executor.groundBatch.bind(executor);
  }
  return composite;
}
