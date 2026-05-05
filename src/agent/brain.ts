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
    /** When the active tab in Chrome is reachable via Playwriter, this
     *  carries the accessibility tree so the planner can choose
     *  browser.click/browser.scroll/browser.type. Absent → vision-only. */
    browserSnapshot?: BrowserSnapshot;
  },
): Promise<string> {
  let task = args.task;
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
      `  browser.click <ref>            (e.g. browser.click e12)\n` +
      `  browser.type <ref> "text"      (optionally "and press enter")\n` +
      `  browser.scroll page down       (use for full-page scrolls — sidesteps cursor bugs)\n` +
      `  browser.scroll page up\n` +
      `  browser.scroll <ref> down      (scroll a specific element/sidebar)\n` +
      `  browser.read [<ref>]           (read element or whole page text)\n` +
      `Use browser.scroll page down for any page scroll on a web page —\n` +
      `it scrolls the actual viewport instead of whatever's under the cursor.`;
  }

  console.log(
    `[brain] → ${provider.name}.plan history=${args.history.length} screen=${args.screen[0]}x${args.screen[1]}` +
      (args.browserSnapshot ? ` snapshot=${args.browserSnapshot.ax.length}b` : ""),
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

export function isDone(action: string): boolean {
  return /\bDONE\b/i.test(action);
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
  | { kind: "read"; ref?: string };

export function parseBrowserAction(action: string): BrowserAction | null {
  const a = action.trim();
  if (!/^browser\./i.test(a)) return null;

  let m: RegExpMatchArray | null;

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
