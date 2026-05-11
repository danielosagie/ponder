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
const SNAPSHOT_LIMIT = 20_000;

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
): Promise<string> {
  let task = args.task;
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
      constructableHint =
        `\n\n[FAST PATH AVAILABLE — keyboard nav]\n` +
        `You're on Facebook Marketplace. For searches you can SKIP\n` +
        `clicking the sidebar search bar by using the keyboard:\n` +
        `  Step 1: press cmd+l         (focuses the URL bar)\n` +
        `  Step 2: type the URL "https://www.facebook.com/marketplace/search?query=<term>" and press enter\n` +
        `Replace <term> with the user's query. This is faster than\n` +
        `click-find-search-bar + click-then-type AND immune to\n` +
        `grounding-precision misses. Use it for any search-style task\n` +
        `on a site you know the URL pattern for.\n`;
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
    const trimmed =
      ax.length > SNAPSHOT_LIMIT
        ? ax.slice(0, SNAPSHOT_LIMIT) + "\n…(truncated)"
        : ax;
    // Append, don't replace. The original task stays the user's intent;
    // the snapshot is supporting context. Surrounding markers help the
    // planner see this as auxiliary data rather than a new instruction.
    task =
      `${args.task}\n\n` +
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
      `Use browser.scroll page down for any page scroll on a web page —\n` +
      `it scrolls the actual viewport instead of whatever's under the cursor.\n` +
      `If the snapshot URL is chrome-extension://…/welcome.html, your FIRST step\n` +
      `should be browser.navigate <url> — the welcome tab is just a launchpad.\n` +
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
  return action;
}

// Actions that NEVER need pixel coordinates. The browser.* family is here
// because every browser.* verb resolves via aria-ref, not (x, y) — so we
// must short-circuit the grounding step the same way we do for type/press.
const KEYBOARD_ONLY =
  /^(type\s+|press\s+|hotkey\s+|scroll\s+|wait\s+|done|browser\.)/i;

export function needsCoordinates(action: string): boolean {
  return !KEYBOARD_ONLY.test(action.trim());
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
  /^(?:click\b|double\s+click\b|triple\s+click\b|right\s+click\b|type\b|press\b|hotkey\b|drag\b|scroll\b|wait\b|done\b|browser\.)/i;

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
  if (m) return { kind: "click", ref: m[1]! };

  // browser.type <ref> "text" [and press enter|then press enter]
  m = a.match(
    /^browser\.type\s+(\S+)\s+["“'](?<text>[^"”']*)["”']\s*(?:(?:and|then)\s+press\s+(?<key>\w+))?/i,
  );
  if (m?.groups) {
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
