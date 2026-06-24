/**
 * BrowserClient — structured-DOM control of an agent-managed Chrome
 * instance, currently implemented via playwright-core's persistent
 * context. Parallel to ProviderClient (which handles vision/grounding)
 * and screen.ts (which does OS-level mouse/keyboard).
 *
 * The point of this abstraction is hybrid control: when Chrome is the
 * active surface, we can read an accessibility snapshot (5–20KB
 * structured text) instead of guessing pixel coordinates, scroll the
 * actual page viewport (sidestepping the cursor-position scroll bug in
 * nut-js), and click locators by aria-ref instead of approximate (x, y).
 *
 * Vision stays primary. BrowserClient is opt-in per step — the loop only
 * surfaces browser.* verbs to the planner when `available()` returns true,
 * and falls back to the existing screenshot-grounded flow otherwise.
 *
 * No-op when Chrome can't be launched (not installed, profile locked,
 * etc.): `available()` returns false so we never block the loop on
 * browser state.
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
   * Programmatically attach files to a `<input type="file">` element by
   * its aria-ref locator. BYPASSES the native OS file picker entirely —
   * the input's `change` event fires as if the user selected the files
   * in a Finder/Explorer dialog. Use this for ANY "upload a file from
   * disk" intent on the web (profile photos, listing photos, document
   * attachments, etc.). Faster, deterministic, and avoids the slow /
   * brittle vision-grounded path through a native file dialog.
   *
   * The ref must come from a recent `snapshot()` and resolve to either
   * the `<input type="file">` itself or a wrapper that hosts it (a
   * `<label for=…>` or styled button — Playwright auto-resolves both).
   * Paths must be absolute on the host filesystem.
   */
  setInputFiles(ref: string, paths: string[]): Promise<void>;

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

  /**
   * Run a JS expression string in the active page's context and return its
   * JSON-serializable result. Direct DOM access — the escape hatch for what the
   * AX snapshot / readText can't do: pull every `<input value>` + photo url in
   * one pass (fast deep read), or locate the field nearest a visible label
   * (robust selectors on forms with empty/duplicate accessible names). Optional
   * — drivers that can't eval omit it; callers must feature-detect.
   */
  evaluate?(expression: string): Promise<unknown>;

  /**
   * Capture a PNG screenshot of the CONTROLLED tab's CSS viewport (not
   * the OS screen). Returned base64 + DEVICE-pixel dims feed the vision
   * model when a step's deterministic resolver ladder all misses
   * (per-step vision self-heal). Browser-local capture is the whole point
   * — an OS-screen grab is unreliable here because other app windows
   * (Dia / Claude / Grammarly) overlap Chrome and steal coordinate clicks.
   *
   * Proven through the Playwriter relay: Playwright `page.screenshot` is
   * forwarded by the relay (unlike `page.accessibility`, which is dropped
   * — that's why snapshot() uses a DOM walker). width/height are the PNG's
   * raw pixel dims, i.e. DEVICE pixels (Retina = 2× CSS); callers scale by
   * `imgW / window.innerWidth` to convert grounded coords back to CSS px.
   *
   * Optional — only the Playwriter client implements it. AGP/managed
   * drivers that lack a live Page omit it; vision-heal then falls through
   * to the existing fail-stop throw. Returns null when no tab is attached.
   */
  screenshot?(): Promise<{ pngB64: string; width: number; height: number } | null>;

  /** Navigate the active tab. */
  navigate(url: string): Promise<void>;

  /** Open a NEW tab and make it the agent's current page (optionally navigating
   *  it). Lets the agent work in its OWN tab instead of clobbering whatever the
   *  user has open. Optional — not all backends implement it. */
  newTab?(url?: string): Promise<void>;

  /**
   * Enumerate every Chrome tab the user has attached the Playwriter
   * extension to (i.e., every tab in the relay's primary context).
   * Welcome tabs (auto-created chrome-extension://…/src/welcome.html
   * pages) are filtered out — they're never the user's intent.
   *
   * Used by the orchestrator when `browser_snapshot` returns an
   * unexpected URL: list the attached tabs, then `switchTab(...)` to
   * the right one. Multi-tab attachment is normal whenever the user
   * has clicked the green Playwriter icon on more than one tab.
   */
  listTabs(): Promise<TabInfo[]>;

  /**
   * Switch the "active" tab — the one that subsequent snapshot/click/
   * type/etc. operations target. Match by absolute index from
   * `listTabs()`, by URL substring (`urlIncludes`), or by case-
   * insensitive regex pattern. Calls `bringToFront()` on the matched
   * page so it's visually focused too.
   *
   * Throws if no tab matches; the orchestrator should call
   * `listTabs()` first to see what's available.
   */
  switchTab(opts: SwitchTabOptions): Promise<TabInfo>;

  /**
   * Is the CONTROLLED tab the one actually visible on screen?
   * (document.visibilityState === "visible"). When false, the loop's
   * screenshots show a DIFFERENT tab than browser_* actions operate on
   * — a verifier/planner trap unless surfaced. Optional: only the
   * Playwriter client implements it.
   */
  isActive?(): Promise<boolean>;

  /**
   * Bring the CONTROLLED tab's window+tab to the foreground, so the
   * screenshot/vision stack sees the same page browser_* operates on.
   * Used to recover from the "controlled tab is a hidden background tab
   * (often in another Chrome window)" trap. Best-effort, optional.
   */
  bringToFront?(): Promise<void>;

  /**
   * Report the active tab's window geometry in OS screen space —
   * the coordinate bridge between the DOM stack (Playwriter) and the
   * vision stack (Holo3 screen clicks). Derived in-page from
   * window.screenX/screenY + outer/inner deltas, so it needs no CDP
   * Browser-domain support (which the Playwriter relay can't serve).
   *
   * viewport = the top-left of the page's CSS viewport in LOGICAL
   * screen coordinates (the same space cliclick/nut-js click in), so
   * `screenX = viewport.x + cssX` maps a DOM point to a click point.
   * The estimate assumes symmetric left/right window borders (true on
   * macOS Chrome; the title-bar/toolbar height is derived exactly from
   * the outer-inner delta). Returns null when no page is attached.
   */
  geometry(): Promise<{
    window: { x: number; y: number; width: number; height: number };
    viewport: { x: number; y: number; width: number; height: number };
    devicePixelRatio: number;
  } | null>;

  /**
   * AGP thin-driver hook: the live Playwright `Page` for the controlled
   * tab, returned as an opaque handle (the AGP driver casts it to its own
   * richer Playwright type). Ensures the relay/connection is up first.
   * null when no tab is attached. Optional — only the Playwriter client
   * implements it; the vision-only loop never calls it.
   */
  rawPage?(): Promise<unknown>;

  /**
   * AGP thin-driver hook: the live Playwright `BrowserContext` (opaque).
   * The AGP driver uses it to enumerate / create / switch tabs directly,
   * tracking its own active-page pointer instead of fighting the vision
   * path's `state.page`. null when not connected.
   */
  rawContext?(): Promise<unknown>;

  /** Tear down the relay + Playwright connection on app shutdown. */
  close(): Promise<void>;
}

/** One row of `listTabs()` output. Index is stable for the duration of
 *  the current Chrome process — pass it to `switchTab({ index })` for an
 *  unambiguous match when URL/title might be identical (two listings
 *  with the same name, etc.). */
export interface TabInfo {
  /** Position in `ctx.pages()` — 0-based. */
  index: number;
  url: string;
  title: string;
  /** True when this is the tab the next snapshot/click/type/etc. will
   *  target. Typically exactly one tab is current at a time. */
  isCurrent: boolean;
}

/** Match a tab to switch to. Provide ONE of these (validated in the
 *  implementation; if multiple are passed, `index` wins). */
export interface SwitchTabOptions {
  /** Exact zero-based index from `listTabs()`. */
  index?: number;
  /** Case-insensitive substring of the tab's URL. Most common shape:
   *  `{ urlIncludes: "edit" }` to find a listing edit page. */
  urlIncludes?: string;
  /** Case-insensitive regex pattern, matched against the URL. Use only
   *  when `urlIncludes` isn't expressive enough. */
  pattern?: string;
}
