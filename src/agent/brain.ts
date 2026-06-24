import type { ProviderClient } from "./types";
import type { BrowserSnapshot } from "./browser/types";

/**
 * One reasoning step. When `browserSnapshot` is present, we splice it into
 * the task text so the planner sees a structured representation of the
 * active Chrome tab alongside the screenshot. The planner can then choose
 * either pixel-grounded actions ("click on the search bar") OR structured
 * browser.* actions ("browser.click e12") — the latter are more reliable
 * for web pages because they don't depend on coordinate accuracy.
 *
 * Snapshot trimming: the model has finite context. We hard-cap the
 * snapshot at SNAPSHOT_LIMIT chars; in practice 5–20KB is plenty for the
 * interactive elements and the rest is decorative. Logged so we can spot
 * truncation in dev.
 */
// 8,000 chars (was 20,000): the Modal llama-server runs 8192 ctx per
// slot, and a 12KB+ snapshot (basketball-reference, news sites) plus
// the ~4k-token screenshot blew it — every plan/step call 500'd with
// "exceeds the available context size" (live 2026-06-10). 8KB of refs
// is plenty for the brain to pick an [eN]; the verifier already uses
// the same cap.
const SNAPSHOT_LIMIT = 8_000;
// The hosted composite planner (Gemini-class, ~1M ctx) does NOT share
// Modal's ceiling — capping it at 8KB starved it of refs on real pages
// (live 2026-06-10: /you/selling snapshot was 8.2KB; the tail past the
// cap held the per-listing controls, and the planner toggle-clicked the
// one menu ref it could see until the ban fired).
const SNAPSHOT_LIMIT_COMPOSITE = 24_000;

export async function think(
  provider: ProviderClient,
  args: {
    task: string;
    history: string[];
    screenshotB64: string;
    screen: [number, number];
    signal?: AbortSignal;
    /** When the agent-managed Chrome instance is reachable, this carries
     *  the accessibility tree so the planner can choose
     *  browser.click/browser.scroll/browser.type. Absent → vision-only. */
    browserSnapshot?: BrowserSnapshot;
    /** When the local CLI router escalated to vision for this step, its
     *  one-sentence reason ("no listings element in snapshot, page may
     *  still be loading"). Spliced into the user message so Holo3 isn't
     *  starting cold — it knows what the team's other half tried. */
    routerHint?: string;
    /** Optional browser URL + title from the AppleScript probe
     *  (src/screen.ts getBrowserUrl). Surfaced even when
     *  `browserSnapshot` is null (which is the case for Ponder MCP-
     *  forwarded calls where Playwriter isn't wired). Lets the brain
     *  see "where am I" before deciding the next step — closes the
     *  May-11 misframe class where agent_do clicked the wrong
     *  sidebar item and falsely declared DONE because it couldn't
     *  see the URL was wrong. */
    currentUrl?: { url: string; title: string };
  },
): Promise<{
  /** The next action sentence (same contract as before). */
  action: string;
  /** Pre-grounded click point from the combined step() path, in
   *  screenshot-LOGICAL space (same space ground() answers in), or null
   *  when the split path ran / the verb is keyboard-only / the combined
   *  reply omitted coords. Callers use it to skip the ground call. */
  coords: { x: number; y: number } | null;
}> {
  let task = args.task;

  // ── TASK PRIORITY preamble ────────────────────────────────────────
  // Always prepended to every brain call. Addresses two failure modes
  // surfaced by the t4-honda-crv-spreadsheet-research bench (Runs 1
  // and 2, 2026-05-11):
  //
  //   Run 1: Brain hallucinated a "Facebook password reminder dialog"
  //   on a screen that was a FB photo viewer. Grounder fabricated
  //   coords for the imaginary button (413,838 → 708,598 → 419,838),
  //   coord-scatter guard bailed at step 3. Never reached Excel.
  //
  //   Run 2: Setup put Chrome on about:blank but there was a stale
  //   "Little Amps Coffee Roaster" tab. Brain decided to clean up
  //   tabs instead of opening Excel as the task's first instruction
  //   said. Same coord 3 times → same-action guard bailed at step 3.
  //   Never reached Excel.
  //
  // Both runs share a root cause: brain reacted to VISIBLE screen
  // state instead of following the TASK TEXT ordering. The preamble
  // below tells the brain: task text is authoritative; ignore
  // unrelated visible state; if step 1 of the task isn't visible,
  // OPEN/SWITCH to it before doing anything else.
  //
  // Kept tight (~20 lines) because the small model loses focus on
  // long preambles. Rules 1-2 are from the 2026-05-11 honda-crv
  // bench Runs 1-2.
  //
  // A Rule 3 ("after Spotlight, emit `wait 2s` once") was tried in
  // Run 4 to fix the Class D post-Spotlight screenshot race, then
  // removed in Run 5 because the small model dropped the conditional
  // and emitted `wait 2s` UNCONDITIONALLY as the very first action,
  // bailing by no-op-spam in 20s without ever launching anything.
  // The Class D race is now handled deterministically in loop.ts via
  // SPOTLIGHT_LAUNCH_SETTLE_MS — no preamble cost, no brain cooperation.
  // Tightened from the original 20-line version (2026-05-13). The
  // earlier preamble was ~231 tokens of instruction text prepended to
  // every brain call, plausibly degrading grounding accuracy on the
  // small vision model. The same two bench-evidenced rules can be
  // expressed in 4 lines (~55 tokens) without losing the protection;
  // the verbose rationale lives in the comment block above.
  // Rule 3 is conditional (the brain.ts comment above warns conditional
  // rules can be dropped by the small model). It is SAFE here only
  // because loop.ts gates every INFEASIBLE on verifyInfeasible() — an
  // unconditional / premature INFEASIBLE gets rejected for lack of a
  // concrete blocker and the loop keeps going, so the worst case is one
  // wasted verifier call, not a falsely-abandoned task.
  const TASK_PRIORITY_PREAMBLE =
    `[TASK PRIORITY]\n` +
    `1. Task text > screen state. Do task steps in the order written. If step 1 names an app that isn't visible, open it (open app "Name" — or cmd+space → type → enter as fallback) BEFORE anything else; ignore unrelated tabs/dialogs.\n` +
    `2. If a described element produced no screen change in your last action, it's not there — change the description (or strategy), don't re-emit.\n` +
    `3. Only if the task is truly impossible — a permission-denied / read-only / error dialog or a system message blocks it (NOT merely a hard or fiddly step) — reply exactly: INFEASIBLE: <one-line reason>. Never use this to give up on a hard-but-doable task.\n` +
    `\n` +
    `[TASK TEXT]\n`;
  task = TASK_PRIORITY_PREAMBLE + task;

  // Always-prepend browser state when we have a URL but no Playwriter
  // snapshot — gives the brain at least the page identity even without
  // an AX tree. When BOTH are available, the browserSnapshot block
  // below carries the same URL more verbosely; we skip the dup.
  if (args.currentUrl && !args.browserSnapshot) {
    const urlForHints = (args.currentUrl.url || "").toLowerCase();
    const titleForHints = (args.currentUrl.title || "").toLowerCase();
    const onFacebookMarketplace =
      urlForHints.includes("facebook.com/marketplace") ||
      titleForHints.includes("marketplace");
    // CONSTRUCTABLE-URL HINT (keyboard sequence): when the brain is on
    // a site with a well-known URL pattern for the target action, hint
    // the keyboard fast-path: cmd+l (focus URL bar), type the target
    // URL, press enter. 3 keyboard actions but each is reliable (no
    // grounding precision needed) AND avoids the sidebar-misclick
    // failure mode entirely. The browser.navigate verb won't work in
    // Ponder MCP-forwarded flat mode because Playwriter isn't wired
    // (browser=null), but keyboard primitives all route through the
    // bridge's /screen/hotkey + /screen/type which DO work.
    let constructableHint = "";
    if (onFacebookMarketplace) {
      // Worked example with CONCRETE URL — earlier softer phrasing
      // ("type the URL <pattern> replacing <term>") produced wrong
      // behavior: brain typed just "bulbasaur" into the URL bar
      // which Chrome interpreted as a Google search. Brain needs
      // a fully-formed example string to copy. Always cite the
      // FULL constructed URL with the user's literal query already
      // substituted in.
      constructableHint =
        `\n\n[FAST PATH AVAILABLE — keyboard nav to constructed URL]\n` +
        `You're on Facebook Marketplace. SEARCH TASKS can be done\n` +
        `in 2 actions WITHOUT clicking a search bar:\n` +
        `\n` +
        `  Step A: press cmd+l\n` +
        `          (this focuses the URL bar)\n` +
        `  Step B: type the EXACT TEXT below (it is a complete URL):\n` +
        `          https://www.facebook.com/marketplace/search?query=YOUR_QUERY_HERE\n` +
        `          and press enter\n` +
        `\n` +
        `For step B, REPLACE 'YOUR_QUERY_HERE' with the search term\n` +
        `from the user's task (URL-encode spaces as +). For example,\n` +
        `to search for "bulbasaur", type the COMPLETE string:\n` +
        `  https://www.facebook.com/marketplace/search?query=bulbasaur\n` +
        `\n` +
        `DO NOT type just the search term alone — that goes to Google.\n` +
        `Type the FULL URL beginning with "https://".\n` +
        `\n` +
        `This is faster than the click-the-sidebar approach AND\n` +
        `immune to vision grounding misses (no coords needed).\n` +
        `\n` +
        `KNOWN MARKETPLACE URLS (use the one matching the task):\n` +
        `  • search listings:   https://www.facebook.com/marketplace/search?query=...\n` +
        `  • the USER'S OWN listings ("my listings", "products I'm\n` +
        `    selling", editing your own items):\n` +
        `    https://www.facebook.com/marketplace/you/selling\n` +
        `Do NOT search the public marketplace for the user's own items —\n` +
        `their listings live under /you/selling.\n`;
    }
    task =
      `[Browser state — for state-awareness only, do NOT emit actions about this:]\n` +
      `  URL:   ${args.currentUrl.url}\n` +
      `  Title: ${args.currentUrl.title}\n` +
      `Use this to decide if your prior action LANDED — if the URL changed to ` +
      `a results / detail / success page, emit DONE. If the URL didn't change ` +
      `after a click/type/key action, the action didn't fire — pick a different ` +
      `target.${constructableHint}\n\n` +
      task;
  }
  if (args.browserSnapshot) {
    const ax = args.browserSnapshot.ax;
    const snapshotLimit =
      provider.name === "composite" ? SNAPSHOT_LIMIT_COMPOSITE : SNAPSHOT_LIMIT;
    const trimmed =
      ax.length > snapshotLimit
        ? ax.slice(0, snapshotLimit) + "\n…(truncated)"
        : ax;
    // Append, don't replace. The original task (with TASK_PRIORITY
    // preamble already prepended at the top of this function) stays
    // the user's intent; the snapshot is supporting context. Note we
    // use `task` here (which carries the preamble), not `args.task`
    // (which would silently drop it).
    task =
      `${task}\n\n` +
      `[CHROME ACTIVE — you may use browser.* actions]\n` +
      `Page: ${args.browserSnapshot.title} (${args.browserSnapshot.url})\n` +
      `Interactive elements (refs in [eN]):\n${trimmed}\n` +
      `[end snapshot]\n\n` +
      `Available browser.* verbs (PREFERRED for web tasks):\n` +
      `  browser.navigate <url>         (open a URL — use this when the current tab is the Playwriter welcome page or any page that doesn't expose what you need)\n` +
      `  browser.click <ref>            (e.g. browser.click e12)\n` +
      `  browser.type <ref> "text"      (optionally "and press enter")\n` +
      `  browser.scroll page down       (use for full-page scrolls — sidesteps cursor bugs)\n` +
      `  browser.scroll page up\n` +
      `  browser.scroll <ref> down      (scroll a specific element/sidebar)\n` +
      `  browser.read [<ref>]           (read element or whole page text)\n` +
      `Use browser.scroll page down for whole-page scrolls — it scrolls the\n` +
      `document viewport instead of whatever's under the cursor. BUT if it\n` +
      `changes nothing (many app-like pages keep their lists in a NESTED\n` +
      `scroll container that window scrolling can't reach), switch to the\n` +
      `grounded form: scroll down at <description of the list/pane>.\n` +
      `If the snapshot URL is chrome-extension://…/welcome.html, your FIRST step\n` +
      `should be browser.navigate <url> — the welcome tab is just a launchpad.\n` +
      (/facebook\.com/i.test(args.browserSnapshot.url)
        ? `\nFACEBOOK URL MAP: the user's OWN listings ("my listings", items\n` +
          `they are selling, editing their own items) live at\n` +
          `https://www.facebook.com/marketplace/you/selling — go there\n` +
          `directly; do NOT search the public marketplace for them.\n`
        : ``) +
      `\n` +
      `CLI BIAS — default to keyboard/CLI verbs (~70% of actions):\n` +
      `browser.navigate, browser.type, hotkey, press. Reserve browser.click for\n` +
      `the ~30% of steps where you must pick a SPECIFIC item from a list (a\n` +
      `search-result card, a dropdown suggestion, a listing tile). If the\n` +
      `user's task specifies a different ratio (e.g. "use cli 90% of the time"),\n` +
      `HONOR THAT verbatim — they know their workflow.\n` +
      `\n` +
      `SCOPE CHECK — when typing a search query, identify which textbox first:\n` +
      `  • Address bar (browser-level): named "Address and search bar" /\n` +
      `    "Search Google or type a URL", or pre-filled with the page URL.\n` +
      `    USE THIS only to navigate to a different site — and prefer\n` +
      `    browser.navigate <url> directly when the destination is known.\n` +
      `  • Page search (site-level): named "Search Marketplace", "Search\n` +
      `    products", "Search YouTube", "Search messages", etc. USE THIS to\n` +
      `    search INSIDE the current site (this is what you usually want).\n` +
      `A page may have multiple search bars; pick the one whose name matches\n` +
      `the goal. For Marketplace listings, use "Search Marketplace", not the\n` +
      `generic top-of-page Facebook search.\n` +
      `\n` +
      `SEARCH / LOCATION FORM — TYPE → CLICK SUGGESTION → CLICK APPLY.\n` +
      `A "(disabled)" ref is UNCLICKABLE — clicking wastes 5s on a Playwright timeout.\n` +
      `When you typed into a search/location/combobox field and the submit button\n` +
      `(Apply / Search / Confirm) is disabled, your NEXT action MUST be\n` +
      `browser.click on a "(suggestion)" ref (or any role: option / menuitem /\n` +
      `listitem / link in the dropdown), NOT the disabled button, NOT pressing enter.\n` +
      `\n` +
      `  Snapshot:\n` +
      `    [e86] textbox "Location"\n` +
      `    [e91] option "Marietta, GA, United States" (suggestion)\n` +
      `    [e90] button "Apply" (disabled)\n` +
      `  Last action: browser.type e86 "Marietta, GA"\n` +
      `    Wrong: browser.click e90       ← it's disabled, this hangs for 5s\n` +
      `    Wrong: press enter             ← submit is via the button, not enter\n` +
      `    Right: browser.click e91       ← Apply un-disables on the next snapshot\n` +
      `\n` +
      `When the goal mentions a location/search/category filter, expect this\n` +
      `TYPE → CLICK SUGGESTION → CLICK APPLY three-step pattern.`;
  }

  if (args.routerHint) {
    // The CLI router tried first and gave up. We tell Holo3 exactly why so
    // it doesn't waste a step trying the same thing the router already
    // failed at. Position this AFTER the snapshot so it reads as recent
    // context.
    task +=
      `\n\n[CLI ROUTER ESCALATED — reason: ${args.routerHint}]\n` +
      `The fast local agent could not proceed from the snapshot alone. ` +
      `Use the screenshot to find what the router missed.`;
  }

  // ── Combined plan+ground (2026-06-10) ────────────────────────────────
  // When the provider supports step() (Modal /step), ONE model call
  // returns the action AND its click point — halving per-step model time
  // vs the sequential plan→ground pair. Gated by PONDER_COMBINED_STEP
  // (default on; set "off" to force the split path). Any defect in the
  // combined reply (error, bare-verb action) falls back to plan() for
  // this step, so the worst case is exactly the old behavior.
  const combinedEnabled =
    (process.env.PONDER_COMBINED_STEP ?? "on").toLowerCase() !== "off";
  if (combinedEnabled && typeof provider.step === "function") {
    console.log(
      `[brain] → ${provider.name}.step history=${args.history.length} screen=${args.screen[0]}x${args.screen[1]}` +
        (args.browserSnapshot ? ` snapshot=${args.browserSnapshot.ax.length}b` : "") +
        (args.routerHint ? ` routerHint="${args.routerHint.slice(0, 60)}"` : ""),
    );
    try {
      const s = await provider.step({
        task,
        history: args.history,
        screenshotB64: args.screenshotB64,
        screen: args.screen,
        signal: args.signal,
      });
      // Bare-verb guard: grammar-constrained greedy decoding sometimes
      // emits just the verb ("click", "press") — useless for history/
      // recipes and unparseable for keyboard verbs. Treat as a combined-
      // path miss and re-plan via the split path.
      const bare =
        /^(click|double(?:\s+click)?|right\s+click|triple\s+click|press|hotkey|type|drag|scroll|wait)$/i.test(
          s.action.trim(),
        );
      if (!bare) {
        console.log(
          `[brain] ← action="${s.action}" coords=${s.x !== null && s.y !== null ? `(${s.x},${s.y})` : "null"}${s.usage ? ` usage=${JSON.stringify(s.usage)}` : ""}`,
        );
        return {
          action: s.action,
          coords:
            s.x !== null && s.y !== null ? { x: s.x, y: s.y } : null,
        };
      }
      console.log(
        `[brain] combined step returned bare verb "${s.action}" — falling back to split plan for this step`,
      );
    } catch (e) {
      console.log(
        `[brain] combined step failed (${e instanceof Error ? e.message.split("\n")[0] : String(e)}) — falling back to split plan`,
      );
    }
  }

  console.log(
    `[brain] → ${provider.name}.plan history=${args.history.length} screen=${args.screen[0]}x${args.screen[1]}` +
      (args.browserSnapshot ? ` snapshot=${args.browserSnapshot.ax.length}b` : "") +
      (args.routerHint ? ` routerHint="${args.routerHint.slice(0, 60)}"` : ""),
  );
  const { action, usage } = await provider.plan({
    task,
    history: args.history,
    screenshotB64: args.screenshotB64,
    screen: args.screen,
    signal: args.signal,
  });
  console.log(
    `[brain] ← action="${action}"${usage ? ` usage=${JSON.stringify(usage)}` : ""}`,
  );
  return { action, coords: null };
}

// Actions that NEVER need pixel coordinates. The browser.* family is here
// because every browser.* verb resolves via aria-ref, not (x, y) — so we
// must short-circuit the grounding step the same way we do for type/press.
const KEYBOARD_ONLY =
  /^(type\s+|press\s+|hotkey\s+|scroll\s+|wait\s+|done|note\s+|open\s+app\s+|browser\.)/i;

export function needsCoordinates(action: string): boolean {
  const a = action.trim();
  // "scroll up|down at/in/on <target>" aims the wheel at a SPECIFIC
  // element (nested panes, sidebars) — it needs grounding even though
  // plain "scroll up|down" is keyboard-only.
  if (/^scroll\s+(up|down)\s+(at|in|on)\b/i.test(a)) return true;
  return !KEYBOARD_ONLY.test(a);
}

// Allow-list of action verbs the executor knows how to dispatch. Used to
// validate the brain's output BEFORE we burn a grounding round-trip on
// it — without this, the loop tries to vision-ground arbitrary prose
// like "The last step was incorrect. The current step is:" (seen in the
// Bulbasaur trace, where the brain echoed prompt boilerplate as if it
// were an action) and either wastes 5–10s on a nonsense ground or
// resolves it to a random click coordinate.
//
// `^…\b` so partial matches at the START of the line count, regardless
// of trailing modifiers ("type \"foo\"", "press enter", "click on the
// search bar", etc.). Anything that doesn't lead with one of these is
// treated as invalid — the loop pushes a `[note: …]` to history and
// re-prompts, bailing after two consecutive invalids.
const VALID_ACTION_VERB =
  /^(?:click\b|double\s+click\b|triple\s+click\b|right\s+click\b|(?:cmd|command|shift|alt|option|ctrl|control)[\s_-]*click\b|hover\b|type\b|press\b|hotkey\b|drag\b|scroll\b|wait\b|note\b|open\s+app\b|done\b|infeasible\b|browser\.)/i;

export function isValidAction(action: string): boolean {
  return VALID_ACTION_VERB.test(action.trim());
}

// DONE detection is line-anchored on the trimmed action so phrases like
// "I'm DONE looking" or "Browser DONE loading" don't slip through. The
// brain's system prompt tells it to emit DONE alone — we honor that
// contract here. Trailing punctuation / explanatory comment after DONE
// is allowed ("DONE", "DONE.", "DONE — uploaded the file") but DONE
// must be the first token.
export function isDone(action: string): boolean {
  return /^DONE\b/i.test(action.trim());
}

// INFEASIBLE detection, line-anchored like isDone. The brain emits
// `INFEASIBLE: <reason>` when a concrete barrier (permission denied,
// read-only, system "can't do that" dialog) makes the task impossible.
// loop.ts gates this on verifyInfeasible() before terminating, so a
// loose or premature INFEASIBLE doesn't strand a doable task.
export function isInfeasible(action: string): boolean {
  return /^INFEASIBLE\b/i.test(action.trim());
}

/** Pull the one-line reason out of an `INFEASIBLE: <reason>` action.
 *  Falls back to a generic string when the model emits a bare token. */
export function infeasibleReason(action: string): string {
  const m = action.trim().match(/^INFEASIBLE\s*[:\-]?\s*(.+)$/is);
  const reason = m?.[1]?.trim();
  return reason && reason.length > 0 ? reason : "no reason given";
}

/**
 * Recognize a drag action and split it into source + target descriptions.
 * Both endpoints are grounded separately so the model can describe each in
 * natural language ("drag the file to the trash") instead of returning two
 * coordinates pre-resolved.
 *
 * Accepted forms:
 *   drag X to Y
 *   drag from X to Y
 *   drag X onto Y
 *   drag and drop X to Y
 *
 * Returns null for non-drag actions so the caller can fall through to the
 * normal single-coord flow.
 */
export function parseDragAction(
  action: string,
): { from: string; to: string } | null {
  const m = action
    .trim()
    .match(/^drag(?:\s+and\s+drop)?\s+(?:from\s+)?(.+?)\s+(?:to|onto|into)\s+(.+?)\.?$/i);
  if (!m) return null;
  const from = m[1]?.trim();
  const to = m[2]?.trim();
  if (!from || !to) return null;
  return { from, to };
}

/**
 * Parse the various shapes of `browser.*` action verbs the planner may
 * emit. Returns a tagged-union so the executor can dispatch with one
 * switch.
 *
 *   browser.click e12
 *   browser.type e7 "search text"
 *   browser.type e7 "search text" and press enter
 *   browser.scroll page down
 *   browser.scroll page up 800
 *   browser.scroll e3 down
 *   browser.read
 *   browser.read e9
 */
export type BrowserAction =
  | { kind: "click"; ref: string }
  | { kind: "type"; ref: string; text: string; submit?: boolean }
  | { kind: "scroll_page"; dir: "up" | "down"; amount?: number }
  | { kind: "scroll_element"; ref: string; dir: "up" | "down"; amount?: number }
  | { kind: "read"; ref?: string }
  | { kind: "navigate"; url: string };

// Refs are ALWAYS [eN] snapshot tags. Live failure: the planner emitted
// `browser.click "Modal"` (an accessible NAME instead of a ref); the raw
// string flowed into a CSS attribute selector and Playwright threw
// `'[data-holo-ref=""Modal""]' is not a valid selector` — 9 identical
// crashes in one run because the error taught the model nothing. A
// name-form ref now fails parsing, and the loop's invalid-action note
// tells the planner to use the snapshot ref or a vision click.
const VALID_REF = /^e\d+$/i;

export function parseBrowserAction(action: string): BrowserAction | null {
  const a = action.trim();
  if (!/^browser\./i.test(a)) return null;

  let m: RegExpMatchArray | null;

  // browser.navigate <url>
  // Models sometimes wrap the URL in quotes or angle brackets — strip those
  // so we accept the natural shapes. Also prepend https:// when the model
  // emits a bare host like `facebook.com/marketplace`; goto() requires a
  // protocol and treats schema-less strings as relative paths.
  m = a.match(/^browser\.navigate\s+(.+)$/i);
  if (m) {
    let url = m[1]!.trim().replace(/^[<"'`]+|[>"'`.,;]+$/g, "");
    if (!/^[a-z]+:\/\//i.test(url) && !url.startsWith("about:")) {
      url = `https://${url}`;
    }
    return { kind: "navigate", url };
  }

  // browser.click <ref>
  m = a.match(/^browser\.click\s+(\S+)/i);
  if (m) {
    if (!VALID_REF.test(m[1]!)) return null; // name-form ref — see VALID_REF
    return { kind: "click", ref: m[1]! };
  }

  // browser.type <ref> "text" [and press enter|then press enter]
  m = a.match(
    /^browser\.type\s+(\S+)\s+["“'](?<text>[^"”']*)["”']\s*(?:(?:and|then)\s+press\s+(?<key>\w+))?/i,
  );
  if (m?.groups) {
    if (!VALID_REF.test(m[1]!)) return null; // name-form ref — see VALID_REF
    return {
      kind: "type",
      ref: m[1]!,
      text: m.groups.text,
      submit: /^enter$/i.test(m.groups.key ?? ""),
    };
  }

  // browser.scroll page down [N]  /  browser.scroll page up [N]
  m = a.match(/^browser\.scroll\s+page\s+(up|down)(?:\s+(\d+))?/i);
  if (m) {
    return {
      kind: "scroll_page",
      dir: m[1]!.toLowerCase() as "up" | "down",
      amount: m[2] ? parseInt(m[2], 10) : undefined,
    };
  }

  // browser.scroll <ref> up|down [N]
  m = a.match(/^browser\.scroll\s+(\S+)\s+(up|down)(?:\s+(\d+))?/i);
  if (m) {
    if (!VALID_REF.test(m[1]!)) return null; // name-form ref — see VALID_REF
    return {
      kind: "scroll_element",
      ref: m[1]!,
      dir: m[2]!.toLowerCase() as "up" | "down",
      amount: m[3] ? parseInt(m[3], 10) : undefined,
    };
  }

  // browser.read [<ref>]
  m = a.match(/^browser\.read(?:\s+(\S+))?/i);
  if (m) return { kind: "read", ref: m[1] };

  return null;
}
