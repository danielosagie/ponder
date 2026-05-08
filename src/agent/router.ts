/**
 * Router — the agent's "fast path."
 *
 * When Chrome is the active surface and Playwriter has captured an
 * accessibility snapshot, the router decides the next action LOCALLY in
 * 500–1000ms instead of round-tripping to Holo3 (≈10s/step on hcompany).
 * The snapshot already names every interactive element by aria-ref, so a
 * small Qwen3 model is more than capable of picking the right one.
 *
 * The router and the vision agent (Holo3) work as a TEAM:
 *   • Router goes first per step. If the snapshot has what's needed, it
 *     emits a `browser.click eN` / `browser.scroll page down` etc. and the
 *     loop executes immediately, skipping plan + ground entirely.
 *   • If the snapshot is sparse, the target isn't named, the page is a
 *     canvas (Figma), or the router just isn't sure, it emits
 *     "VISION_NEEDED <reason>" and the loop falls through to Holo3 with
 *     the reason spliced into Holo3's prompt as context.
 *   • Bidirectional: each step is independently routed. After Holo3
 *     unsticks something, the next step calls the router again. They
 *     swap step-by-step.
 *
 * Why a separate agent (not the planner): the planner decomposes a task
 * once at run start. The router decides one action per step. Different
 * jobs, different prompts, different latency budgets.
 *
 * Configure via env:
 *   ROUTER_MODEL  — Ollama tag (default qwen3.5:0.8b)
 *   ROUTER_HOST   — Ollama URL (default OLLAMA_HOST → 127.0.0.1:11434)
 *   ROUTER_TIMEOUT_MS — hard cap (default 4000ms)
 *   HOLO3_ROUTER=off — disable the router globally; loop runs vision-only
 */
import { Ollama } from "ollama";
import type { BrowserSnapshot } from "./browser/types";

export type RouterDecision =
  /** Direct browser.* action — execute immediately, skip plan/ground. */
  | { kind: "action"; action: string }
  /** Task is visibly complete on this snapshot. */
  | { kind: "done" }
  /** CLI path can't proceed — fall through to Holo3 with this reason. */
  | { kind: "vision_needed"; reason: string }
  /** Router unavailable / errored / timed out — silent fall-through. The
   *  loop uses this as a signal to take the vision path WITHOUT a hint
   *  (the reason is internal, not useful for Holo3). */
  | { kind: "skip"; reason: string };

export interface RouterClient {
  decide(args: {
    task: string;
    history: string[];
    snapshot: BrowserSnapshot;
    /** True iff the snapshot text from this step matches the previous
     *  step's snapshot — i.e. the router just acted and nothing changed.
     *  Strong signal to either escalate or DONE. */
    snapshotUnchanged: boolean;
    signal?: AbortSignal;
  }): Promise<RouterDecision>;
  /** Cheap probe — true if the model responds at all. */
  available(): Promise<boolean>;
}

export interface RouterConfig {
  host?: string;
  model?: string;
  timeoutMs?: number;
}

const SYSTEM_PROMPT = `You are the FAST-PATH router for a computer-use agent. The user's Chrome browser is connected via a snapshot of the active tab's accessibility tree. Each interactive element is tagged [eN]. Your job: pick the SINGLE next action OR escalate to the vision agent.

Respond with EXACTLY ONE LINE in one of these shapes:

  browser.navigate <url>         (open a URL in the active tab — use this when the page can't help with the goal yet, e.g. you're on the Playwriter welcome page or a search-engine landing page and need to jump to facebook.com / amazon.com / google.com / etc.)
  browser.click <ref>            (e.g. browser.click e12)
  browser.type <ref> "text"      (with optional "and press enter")
  browser.scroll page down       (whole-viewport scroll — use for "I need to see more")
  browser.scroll page up
  browser.scroll <ref> down      (scroll a specific element / sidebar)
  browser.read                   (read whole page text — when the user asked an informational question and you need to extract the content)
  browser.read <ref>             (read a specific region's text)
  DONE                           (the user's goal is visibly achieved on this snapshot)
  VISION_NEEDED <one-sentence reason>   (CLI cannot proceed — the vision agent will take over this step)

LAUNCHPAD RULE — when the active URL is chrome-extension://*/src/welcome.html (the Playwriter auto-created tab), the snapshot will be near-empty. Your FIRST action MUST be browser.navigate to a URL that helps the goal. Pick a sensible site from the user's task ("facebook marketplace" → https://www.facebook.com/marketplace, "amazon" → https://www.amazon.com, "search X" → https://www.google.com/search?q=X). Do NOT escalate from the welcome page — vision can't help here either; just navigate.

SCOPE CHECK — when typing a search query, FIRST identify which textbox you're targeting:
  • Address bar (browser-level): named like "Address and search bar", "Search Google or type a URL", or has the active page URL pre-filled. ONLY use this when the goal is to navigate to a different site — for that, prefer browser.navigate <url> directly.
  • Page search (site-level): named like "Search Marketplace", "Search products", "Search messages", "Search YouTube". USE THIS when searching INSIDE the current site.
A page may have multiple search bars (header search, sidebar/filter search, modal search). Pick the one whose name matches the goal — if the user wants Marketplace listings, use "Search Marketplace", not the generic top-of-page Facebook search.

REDIRECT DETECTION — if your previous action was \`browser.navigate X\` and the current snapshot URL is NOT X (the site rewrote your URL), the destination URL is invalid for that site. DO NOT re-emit the same navigate — you'll loop. Common cases:
  • Facebook Marketplace doesn't accept arbitrary city slugs in /marketplace/<city>/search — it normalizes to /marketplace/category/search/.
  • Some sites strip query params, redirect HTTP→HTTPS, or send / to /home.
  Fix: either accept the redirected URL and proceed from THERE (use the page's own filters/search bar to refine), or VISION_NEEDED to let the vision agent see the redirected page. Never re-emit the failed URL.

SUBTASK COMPLETION — if the USER GOAL is "navigate to X" / "open X" / "go to X" and the snapshot URL canonical-matches X (you're already there from a prior navigate), emit DONE. Do NOT emit \`browser.navigate X\` when you're at X — that's a no-op (the runtime will auto-DONE it anyway, but recognizing it saves a step). The same rule applies to "click X" / "focus X" / "open X" when X is already focused in the snapshot.

SEARCH / LOCATION FORM — TYPE → CLICK SUGGESTION → CLICK APPLY.
A "(disabled)" ref is UNCLICKABLE — clicking wastes 5s on a Playwright timeout.
When you typed into a search/location/combobox field and the submit button
(Apply / Search / Confirm) is disabled, your NEXT action MUST be
browser.click on a "(suggestion)" ref (or any role: option / menuitem /
listitem / link in the dropdown), NOT the disabled button, NOT pressing enter.

  Snapshot:
    [e86] textbox "Location"
    [e91] option "Marietta, GA, United States" (suggestion)
    [e90] button "Apply" (disabled)
  Last action: browser.type e86 "Marietta, GA"
    Wrong: browser.click e90       ← it's disabled, this hangs for 5s
    Wrong: press enter             ← submit is via the button, not enter
    Right: browser.click e91       ← Apply un-disables on the next snapshot

When in doubt about which option matches the typed text, escalate via VISION_NEEDED.

ESCALATE TO VISION when ANY of these:
  • The snapshot doesn't name the element you'd need (canvas-rendered apps, custom controls).
  • The user's intent involves visual judgment (colors, layout, "does this look right").
  • Your last action ran but the snapshot is unchanged — something silent failed (but if you're still on the welcome page, navigate instead).
  • You'd be guessing about which [eN] to pick. Better to escalate than to click randomly.

When in doubt, escalate. The vision agent is slower but more reliable, and the team can swap back to you on the next step once it unsticks.

FORMAT RULES:
  • One line. No prose, no markdown, no JSON, no quotes around the whole line.
  • DO NOT emit <think>...</think> reasoning blocks — reply with the action ONLY. Reasoning blocks burn the response budget before any visible content emerges, leaving the router with an empty response and forcing fall-through to the slow vision path.
  • Use the simple verb form: \`browser.type e7 "search"\` — NOT \`browser.type({"ref":"e7","text":"search"})\`.
  • Do not chain actions. ONE action per step. Press-enter chaining is fine within type.

Examples (good):
  browser.navigate https://www.facebook.com/marketplace/category/search?query=1997%20toyota%20camry
  browser.click e12
  browser.type e7 "dell se2719hr" and press enter
  browser.scroll page down
  browser.read
  DONE
  VISION_NEEDED no listings element in the snapshot, page may still be loading

Note: Marketplace's "city slug" URL form (/marketplace/<city>/search) is REWRITTEN by the site to /marketplace/category/search/. Don't try the city-slug form — it always redirects. Use /marketplace/category/search and apply the city via the on-page Location filter (a textbox that opens an autocomplete you click into).

Examples (BAD — never emit these):
  Click on e12.                          ← prose
  browser.click({"ref":"e12"})           ← JSON-style
  browser.click e12 then browser.read    ← chained
  VISION_NEEDED I'm on the welcome page  ← navigate instead`;

/** Tight cap: we want the router prompt to fit cleanly in a small model's
 *  context window without crowding out the question. The vision path will
 *  see the full snapshot if escalation happens. */
const SNAPSHOT_LIMIT = 14_000;

/**
 * Normalize a URL for "did the site redirect us?" comparison.
 *
 * Returns null on parse failure (caller treats null === null as "no
 * comparison possible" and skips the redirect hint).
 *
 * Equality after canonicalize:
 *   • protocol-relative differences (http vs https) ignored,
 *   • trailing slashes ignored,
 *   • host case ignored,
 *   • query-param ORDER ignored (so price=2500-3000&query=X equals
 *     query=X&price=2500-3000 — sites often re-shuffle these).
 *   • fragment ignored.
 *
 * What still differs (so the hint fires):
 *   • host changes (facebook.com → m.facebook.com),
 *   • PATH changes (/marketplace/marietta/search → /marketplace/category/search),
 *   • query param VALUES (different filters than requested).
 */
export function canonicalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    // Sort params so order-only differences don't trigger a false redirect.
    const params = [...u.searchParams.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    );
    const search = params.length
      ? "?" + params.map(([k, v]) => `${k}=${v}`).join("&")
      : "";
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return `${u.host.toLowerCase()}${path}${search}`;
  } catch {
    return null;
  }
}

/** Likewise for history. The router only needs the last few steps to spot
 *  loops; ancient history is dead weight. */
const HISTORY_LIMIT = 6;

export function createOllamaRouter(cfg: RouterConfig = {}): RouterClient {
  const ollama = new Ollama({
    host:
      cfg.host ??
      process.env.ROUTER_HOST ??
      process.env.OLLAMA_HOST ??
      "http://127.0.0.1:11434",
  });
  const model = cfg.model ?? process.env.ROUTER_MODEL ?? "qwen3.5:0.8b";
  // 4s default. With think:false (set per-request below) the model emits
  // the action line directly in 300-800ms; 4s is comfortable headroom for
  // a slow first-load or a larger snapshot. Earlier bumps to 6s and 8s
  // were a workaround for the <think>-block-eats-the-budget bug — that's
  // fixed at the source now, so we can return to a tight cap that keeps
  // the "fast path" actually fast.
  const timeoutMs =
    cfg.timeoutMs ?? Number(process.env.ROUTER_TIMEOUT_MS ?? 4_000);

  function parseDecision(raw: string): RouterDecision {
    // Strip Qwen3 reasoning blocks first.
    let text = raw.replace(/<think>[\s\S]*?<\/think>/g, "");
    const openIdx = text.indexOf("<think>");
    if (openIdx !== -1) text = text.slice(0, openIdx);
    text = text.trim();

    // Take only the first non-empty line — the model occasionally appends
    // commentary even though we forbid it.
    const firstLine = (text.split("\n").find((l) => l.trim()) ?? "").trim();
    if (!firstLine) {
      return { kind: "skip", reason: "router emitted empty response" };
    }

    if (/^DONE\b/i.test(firstLine)) return { kind: "done" };

    if (/^VISION_NEEDED\b/i.test(firstLine)) {
      const reason =
        firstLine.replace(/^VISION_NEEDED\s*/i, "").trim() || "no reason given";
      return { kind: "vision_needed", reason };
    }

    if (/^browser\./i.test(firstLine)) {
      return { kind: "action", action: firstLine };
    }

    // Anything else — the model didn't follow the format. Treat as a soft
    // escalate so the vision path picks up.
    return {
      kind: "vision_needed",
      reason: `router emitted unrecognized line: ${firstLine.slice(0, 100)}`,
    };
  }

  return {
    async decide({ task, history, snapshot, snapshotUnchanged, signal }) {
      // If the user pressed Stop while we're racing, don't even start.
      if (signal?.aborted) {
        return { kind: "skip", reason: "cancelled before router call" };
      }

      const recent = history.slice(-HISTORY_LIMIT);
      const historyBlock =
        recent.length === 0
          ? "(none — this is step 1)"
          : recent.map((h, i) => `${i + 1}. ${h}`).join("\n");

      const ax = snapshot.ax;
      const trimmed =
        ax.length > SNAPSHOT_LIMIT
          ? ax.slice(0, SNAPSHOT_LIMIT) + "\n…(truncated — escalate to vision if you need the rest)"
          : ax;

      const stuckHint = snapshotUnchanged
        ? "\nIMPORTANT: your previous action did NOT change the page. Either return DONE if the goal is met, or escalate via VISION_NEEDED. Repeating the same action will be blocked."
        : "";

      // Redirect detection: if the last action was browser.navigate <X>
      // but the current URL is NOT X (after canonicalizing trailing
      // slashes and protocol), the site rewrote our URL. Re-emitting
      // the same navigate would loop until anti-loop guard #1 kills the
      // run. We strip the URL from history's last entry, normalize
      // both sides (lowercase host, drop trailing slash and trailing
      // "/"), and inject an explicit warning when they don't match.
      let redirectHint = "";
      const lastAction = recent.at(-1) ?? "";
      const navMatch = lastAction.match(/^browser\.navigate\s+(\S+)/i);
      if (navMatch) {
        const requested = canonicalizeUrl(navMatch[1]!);
        const actual = canonicalizeUrl(snapshot.url);
        if (requested && actual && requested !== actual) {
          redirectHint =
            `\nIMPORTANT: your previous browser.navigate to "${navMatch[1]}" was REDIRECTED — ` +
            `the site rewrote it to "${snapshot.url}". DO NOT re-emit the same navigate, ` +
            `you will loop. Either work with this redirected page (use its on-page search/filters), ` +
            `or VISION_NEEDED. Never retry the URL the site already rejected.`;
        }
      }

      const userMsg =
        `USER GOAL: ${task}\n\n` +
        `Active tab: ${snapshot.title} (${snapshot.url})\n` +
        `Snapshot (interactive elements with [eN] refs):\n${trimmed}\n\n` +
        `Recent action history:\n${historyBlock}${stuckHint}${redirectHint}\n\n` +
        `Decide the SINGLE next action now.`;

      try {
        // Cancellable timeout race. Aborts on either: model timeout OR the
        // caller's AbortSignal flipping (Stop pressed).
        const ctrl = new AbortController();
        const onExternal = () => ctrl.abort();
        signal?.addEventListener("abort", onExternal, { once: true });
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);

        let result: { message: { content: string } };
        try {
          result = (await ollama.chat({
            model,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: userMsg },
            ],
            // think: false — disable Qwen3 reasoning at the API level.
            // qwen3.5:0.8b emits a 5-9s <think> block on every prompt by
            // default, which was the entire reason the router kept
            // returning "empty response" (the think tokens consumed both
            // the time budget AND the response budget before any visible
            // action emerged). Asking nicely in the system prompt didn't
            // work — the model thinks anyway. Setting think:false at the
            // request level disables it cleanly. Same mechanism Holo3
            // uses via chat_template_kwargs.enable_thinking:false.
            // With reasoning off, the same call returns in ~300-800ms and
            // num_predict:96 is plenty for one short browser.* line.
            think: false,
            // Low temperature: we want decisive verb-picking, not creativity.
            options: { temperature: 0.1, num_predict: 96 },
          })) as { message: { content: string } };
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onExternal);
        }

        return parseDecision(result.message.content ?? "");
      } catch (e) {
        if (signal?.aborted) {
          return { kind: "skip", reason: "router cancelled" };
        }
        // Timeout / model not pulled / Ollama down — silently degrade. The
        // loop falls through to Holo3 without a hint.
        return {
          kind: "skip",
          reason: `router error: ${e instanceof Error ? e.message : String(e)}`,
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
