/**
 * BrowserClient — structured-DOM control of the user's actual Chrome session
 * via Playwriter's CDP relay. Parallel to ProviderClient (which handles
 * vision/grounding) and screen.ts (which does OS-level mouse/keyboard).
 *
 * The point of this abstraction is hybrid control: when the user has
 * Playwriter's Chrome extension active on a tab, we can read an accessibility
 * snapshot (5–20KB structured text) instead of guessing pixel coordinates,
 * scroll the actual page viewport (sidestepping the cursor-position scroll bug
 * in nut-js), and click locators by aria-ref instead of approximate (x, y).
 *
 * Vision stays primary. BrowserClient is opt-in per step — the loop only
 * surfaces browser.* verbs to the planner when `available()` returns true,
 * and falls back to the existing screenshot-grounded flow otherwise.
 *
 * No-op when the extension isn't connected: `available()` returns false
 * within a short probe window so we never block the loop on Chrome state.
 */

export interface BrowserSnapshot {
  /** Current tab URL. */
  url: string;
  /** Current tab title. */
  title: string;
  /**
   * Accessibility-tree text with `aria-ref=eN` locators inline. Roughly
   * Vimium-style — the planner reads this and emits actions like
   * `browser.click e12`. Typically 5–20KB; we trim to a hard ceiling before
   * sending to the planner so prompt cost stays bounded.
   */
  ax: string;
}

export interface BrowserClient {
  /**
   * Probe whether the relay is reachable AND a tab is "green" (extension
   * clicked, debugger attached). Returns false (without throwing) on any
   * failure so the loop can transparently fall back to vision-only.
   */
  available(): Promise<boolean>;

  /** Capture a structured snapshot of the active tab. */
  snapshot(): Promise<BrowserSnapshot>;

  /**
   * Click an element by its aria-ref locator (e.g. "e12"). The ref must
   * come from a recent `snapshot()` — the page may have re-rendered since.
   */
  click(ref: string): Promise<void>;

  /**
   * Type text into a focused locator. If `submit` is true, presses Enter
   * after typing — useful for search boxes and forms.
   */
  type(ref: string, text: string, opts?: { submit?: boolean }): Promise<void>;

  /**
   * Scroll a specific element by its ref. Use for sidebars, modals, lists
   * — anything that has its own scroll container.
   */
  scrollElement(
    ref: string,
    dir: "up" | "down",
    amount?: number,
  ): Promise<void>;

  /**
   * Scroll the page's main viewport via `window.scrollBy`. This is the fix
   * for the "cursor parked over sidebar → nut-js scrolls sidebar" bug — it
   * targets the document, not whatever's under the OS cursor.
   */
  scrollPage(dir: "up" | "down", amount?: number): Promise<void>;

  /**
   * Read the visible text of a specific element, or of the whole document
   * body if no ref is given. Used by the extractor to harvest page content
   * for the report-back step.
   */
  readText(ref?: string): Promise<string>;

  /** Navigate the active tab. */
  navigate(url: string): Promise<void>;

  /** Tear down the relay + Playwright connection on app shutdown. */
  close(): Promise<void>;
}
