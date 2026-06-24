/**
 * Playwriter-backed BrowserClient — controls the user's main Chrome via
 * the Playwriter Chrome extension + local CDP relay (localhost:19988).
 *
 * Why Playwriter (vs spawning our own Chrome):
 *   • Uses the user's REAL Chrome with their tabs, logins, cookies,
 *     extensions, work in progress. No second Chrome window. No
 *     "log in to FB again." No profile copy.
 *   • The relay binds only to localhost with origin validation, so it's
 *     a low-friction security model.
 *
 * Architecture: we EMBED the relay rather than spawn `playwriter` as a
 * subprocess or wire up an MCP client. `startPlayWriterCDPRelayServer()`
 * boots the WebSocket bridge in-process; `getCdpUrl()` returns the URL
 * playwright-core can `connectOverCDP()` to. From there we drive the
 * active page with stock Playwright APIs.
 *
 * The one user step that Chrome's security model demands:
 *   • Install the Playwriter extension once (Chrome Web Store).
 *   • Click the extension icon on the tab to attach the debugger
 *     (chrome.debugger.attach() requires a user gesture — there is no
 *     way around this in Chrome's design).
 *
 * Everything else is automatic: the relay starts when our app starts;
 * we connect on the first browser-needing step; we surface clear status
 * messages when the user needs to click the extension. The router and
 * loop only see the BrowserClient interface, so the rest of the agent
 * doesn't care whether Chrome is reachable on a given step or not.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pngDimensions } from "../imageops";
import type {
  BrowserClient,
  BrowserSnapshot,
  TabInfo,
  SwitchTabOptions,
} from "./types";

// PLAYWRITER_AUTO_ENABLE: documented in Playwriter's MCP.md as
//   "Auto-create a tab when Playwright connects (no manual extension click needed)."
// Set at module load — BEFORE the dynamic require() in tryLoadModules
// reads playwriter — so the flag is in process.env when the relay reads
// its own config. Without this, the user would have to click the green
// extension icon on a tab themselves before our connect() found anything.
if (!process.env.PLAYWRITER_AUTO_ENABLE) {
  process.env.PLAYWRITER_AUTO_ENABLE = "1";
}

// ---------------------------------------------------------------------------
// Loose Playwright/Playwriter typings.
//
// Both packages ship full TypeScript types but importing them statically
// would force the bundler to resolve them at build time, which we don't
// want for optional runtime deps. Instead we shape-type the few methods
// we touch and load via dynamic require so the app boots even when the
// modules aren't installed yet.
// ---------------------------------------------------------------------------

interface PlaywriterModule {
  startPlayWriterCDPRelayServer?: () => Promise<unknown>;
  // The real signature is `(opts?: { port?, host?, token?, extensionId? }) => string`.
  // We model it as `(opts?) => string` so we can pass an extensionId when the
  // user has multiple Playwriter extensions installed (production + dev) and
  // the relay would otherwise reject the WS handshake with
  // "Multiple extensions connected. Specify extensionId."
  getCdpUrl?: (opts?: { extensionId?: string }) => string;
}

/** Shape returned by GET /extensions/status on the Playwriter relay. */
interface RelayExtensionStatus {
  extensionId: string;
  stableKey?: string | null;
  browser?: string | null;
  profile?: { email?: string; id?: string } | null;
  activeTargets: number;
  playwriterVersion?: string | null;
}

/**
 * Ask the relay which extension *connections* are live. The "extensionId"
 * field returned here is actually the relay's per-connection ID (a random
 * `${time}_${rand}` string), not the Chrome extension's static ID — the
 * relay keys its internal Map by connection, so two Chrome profiles each
 * running the same Web Store extension show up as TWO entries with the same
 * stableKey-prefix `profile:` but different connectionIds.
 *
 * We use this to disambiguate when the relay's auto-fallback can't:
 * `getExtensionConnection(null, {allowFallback:true})` only auto-picks if
 * exactly one extension OR exactly one extension with active targets exists.
 * With AUTO_ENABLE creating a welcome tab on every connection, two profiles
 * each have an active target and the fallback bails — the WS handshake
 * closes with code 4003 "Multiple extensions connected. Specify extensionId."
 *
 * Returns null when the relay isn't responding (we then fall through to the
 * no-extensionId path; works fine in the genuine single-extension case).
 */
async function fetchRelayExtensions(): Promise<RelayExtensionStatus[] | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    try {
      const res = await fetch("http://127.0.0.1:19988/extensions/status", {
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { extensions?: RelayExtensionStatus[] };
      return Array.isArray(body.extensions) ? body.extensions : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/**
 * Pick which connection to bind to when several are live. The relay doesn't
 * expose the underlying Chrome extension ID (it only ships connectionId,
 * stableKey, profile.{id,email}, browser, activeTargets), so we can't
 * literally prefer "production over dev" — we just pick the most useful
 * connection by activity:
 *
 *   1. Connections that already have active targets (tabs we can drive).
 *   2. Failing that, the first connection — they're functionally equivalent.
 *
 * Returning the first one is fine: with PLAYWRITER_AUTO_ENABLE, the relay
 * will auto-create a tab on whichever connection we bind to, so the agent
 * can always make progress.
 */
function pickBestExtension(
  exts: RelayExtensionStatus[],
): RelayExtensionStatus | null {
  if (exts.length === 0) return null;
  const withTargets = exts.filter((e) => (e.activeTargets ?? 0) > 0);
  const pool = withTargets.length > 0 ? withTargets : exts;
  return pool[0] ?? null;
}

interface PlaywrightCoreModule {
  chromium: {
    connectOverCDP: (url: string) => Promise<unknown>;
  };
}

interface PWPage {
  url(): string;
  title(): Promise<string>;
  goto(url: string): Promise<unknown>;
  evaluate<T>(fn: ((arg?: unknown) => T) | string, arg?: unknown): Promise<T>;
  locator(selector: string): {
    click(opts?: { timeout?: number }): Promise<void>;
    fill(text: string): Promise<void>;
    press(key: string): Promise<void>;
    innerText(): Promise<string>;
    // Playwright accepts a single path or an array. We always pass an
    // array so the call site doesn't have to special-case the singular.
    setInputFiles(paths: string | string[]): Promise<void>;
  };
  bringToFront(): Promise<void>;
  isClosed(): boolean;
  screenshot(opts?: {
    type?: "png" | "jpeg";
    fullPage?: boolean;
  }): Promise<Buffer>;
}

interface PWBrowser {
  contexts(): Array<{ pages(): PWPage[]; newPage(): Promise<PWPage> }>;
  close(): Promise<void>;
}

// Module-scope helper: distinguish auto-spawned welcome tabs (created by
// PLAYWRITER_AUTO_ENABLE on every connection where no other targets
// exist) from real user tabs. The welcome page is at
// `chrome-extension://<id>/src/welcome.html` and is functionally a
// drivable about:blank — the agent CAN navigate from it, but the user
// rarely intends to operate ON it. Filtering welcome tabs out of
// `listTabs()` keeps the result list focused on actual work.
//
// Lifted out of `connectIfPossible()`'s closure (where it was
// originally defined) so `listTabs()` / `switchTab()` can use the same
// detection without duplicating the regex.
function isWelcomeTab(p: PWPage): boolean {
  return /^chrome-extension:\/\/[a-z]+\/src\/welcome\.html(?:[?#]|$)/i.test(
    p.url(),
  );
}

/**
 * Resolve a file path tolerantly. The fast path: if the literal path
 * exists on disk, return it as-is. The slow path (only when the
 * literal doesn't exist): scan the parent directory for an entry that
 * matches the target basename UNDER WHITESPACE-AGNOSTIC + UNICODE-NFC
 * + CASE-INSENSITIVE comparison.
 *
 * The motivating case is macOS Screenshot filenames. macOS inserts a
 * NARROW NO-BREAK SPACE (U+202F) between the time and "AM"/"PM"
 * (typographic convention), but the orchestrator routinely re-types
 * paths with a regular ASCII space (U+0020) — they look identical to
 * any reader, including the model itself. Without this resolver,
 * `setInputFiles("/path/to/Screenshot 2026-05-08 at 1.59.53 PM.png")`
 * fails with ENOENT even though the file is sitting RIGHT THERE on
 * Desktop. The harness should solve this so the orchestrator doesn't
 * have to know about U+202F to upload a screenshot.
 *
 * Match function uses three normalizations stacked in order:
 *   1. Unicode NFC composition — handles combining characters.
 *   2. /\\s+/g → " "  — collapses any Unicode whitespace runs to a
 *      single ASCII space. Crucially, /\\s/ matches U+202F and other
 *      Unicode space chars (per JS regex spec).
 *   3. .toLowerCase() — macOS HFS+ / APFS default case-insensitive
 *      mode treats "FILE.PNG" == "file.png".
 *
 * Returns { resolved, viaFuzz } so callers can log the fuzz-match for
 * debugging when the literal path didn't exist.
 *
 * Best-effort: if the parent directory isn't readable, returns the
 * original path unchanged so the caller's downstream error path
 * (Playwright's setInputFiles → ENOENT) still fires with its native
 * message. We don't swallow the error here.
 */
async function resolveFilePathTolerant(
  p: string,
): Promise<{ resolved: string; viaFuzz: boolean }> {
  try {
    await fs.access(p);
    return { resolved: p, viaFuzz: false };
  } catch {
    const dir = path.dirname(p);
    const base = path.basename(p);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return { resolved: p, viaFuzz: false };
    }
    const norm = (s: string): string =>
      s.normalize("NFC").replace(/\s+/g, " ").toLowerCase();
    const target = norm(base);
    for (const entry of entries) {
      if (norm(entry) === target) {
        return { resolved: path.join(dir, entry), viaFuzz: true };
      }
    }
    return { resolved: p, viaFuzz: false };
  }
}

async function tryLoadModules(): Promise<{
  pw: PlaywriterModule;
  core: PlaywrightCoreModule;
} | null> {
  try {
    // Playwriter ships as ESM-only. Electron's main process is bundled as
    // CommonJS, so `require("playwriter")` throws "ERR_REQUIRE_ESM" at
    // runtime. Dynamic import() works in both CJS and ESM contexts.
    //
    // The Function constructor wraps `import()` so electron-vite's
    // bundler doesn't statically analyze it (otherwise it'd inline the
    // module into our CJS bundle and we'd be back where we started).
    // Vite sees `new Function(...)`, can't follow the runtime string,
    // leaves playwriter in node_modules, and Node loads it at runtime as
    // proper ESM.
    const dynamicImport = new Function("m", "return import(m)") as (
      m: string,
    ) => Promise<Record<string, unknown>>;

    const pwMod = await dynamicImport("playwriter");
    const coreMod = await dynamicImport("playwright-core");

    // ESM module namespaces sometimes wrap exports under `.default` for
    // packages that also have a CJS-style default export. Probe both.
    const pwBag = (pwMod.default ?? pwMod) as Record<string, unknown>;
    const coreBag = (coreMod.default ?? coreMod) as Record<string, unknown>;

    const pw: PlaywriterModule = {
      startPlayWriterCDPRelayServer:
        (pwBag.startPlayWriterCDPRelayServer as PlaywriterModule["startPlayWriterCDPRelayServer"]) ??
        (pwMod.startPlayWriterCDPRelayServer as PlaywriterModule["startPlayWriterCDPRelayServer"]),
      getCdpUrl:
        (pwBag.getCdpUrl as PlaywriterModule["getCdpUrl"]) ??
        (pwMod.getCdpUrl as PlaywriterModule["getCdpUrl"]),
    };
    const core: PlaywrightCoreModule = {
      chromium:
        ((coreBag.chromium ?? coreMod.chromium) as PlaywrightCoreModule["chromium"]),
    };

    if (
      typeof pw.startPlayWriterCDPRelayServer !== "function" ||
      typeof pw.getCdpUrl !== "function" ||
      !core?.chromium?.connectOverCDP
    ) {
      console.warn(
        "[browser] modules loaded but missing expected exports — disabling",
      );
      return null;
    }
    return { pw, core };
  } catch (e) {
    console.log(
      `[browser] modules not loadable (${e instanceof Error ? e.message : String(e)}) — vision-only`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Snapshot via DOM walker (page.evaluate).
//
// Why not page.accessibility.snapshot(): when connecting through Playwriter's
// CDP relay, the Page proxy that comes back doesn't expose `accessibility`
// — calls fail with "Cannot read properties of undefined (reading
// 'snapshot')". Empirically confirmed in user logs.
//
// Approach: run a small JS function in the page that walks the DOM, tags
// each interactive element with `data-holo-ref="eN"`, and returns a
// flattened indented-tree representation. The planner/router reads this
// text. Subsequent click/type actions resolve refs back to elements via
// the `[data-holo-ref="eN"]` CSS selector — Playwright handles that
// natively and reliably across all page types (canvas excepted, but
// canvases don't expose interactive a11y elements anyway).
//
// The walker IS executed in the page context, so we serialize it as a
// function. JS injected into the page; no Node deps.
// ---------------------------------------------------------------------------

const SNAPSHOT_SCRIPT = (() => {
  // Defining as a string avoids weird TS-to-page-context closure issues.
  // page.evaluate accepts a string and runs it as the body of an IIFE.
  return `(() => {
    const interactiveSel = [
      'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea',
      '[role="button"]', '[role="link"]', '[role="textbox"]',
      '[role="searchbox"]', '[role="checkbox"]', '[role="radio"]',
      '[role="menuitem"]', '[role="tab"]', '[role="combobox"]',
      '[role="option"]', '[role="switch"]', '[contenteditable="true"]',
    ].join(',');

    function nameOf(el) {
      const aria = el.getAttribute('aria-label');
      if (aria) return aria;
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const lbl = document.getElementById(labelledBy);
        if (lbl && lbl.textContent) return lbl.textContent;
      }
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        return el.placeholder || el.value || el.name || el.type || '';
      }
      const t = (el.innerText || el.textContent || '').trim();
      return t.slice(0, 80);
    }
    function roleOf(el) {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === 'a') return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'input') {
        const t = (el.type || 'text').toLowerCase();
        // file-input gets its own role so it stands out in the snapshot
        // and the orchestrator knows to use browser_set_input_files
        // instead of trying to click it (the native file picker is the
        // wrong tool for an upload-from-disk).
        if (t === 'file') return 'file-input';
        if (t === 'submit' || t === 'button') return 'button';
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        return 'textbox';
      }
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      return tag;
    }
    function isFileInput(el) {
      return el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'file';
    }
    function visible(el) {
      // File inputs are commonly hidden via CSS while a styled label /
      // button forwards user clicks (Facebook, Twitter, Instagram all
      // do this). The element is fully functional even when invisible
      // — Playwright's setInputFiles writes straight to the input — so
      // we surface it in the snapshot anyway. Without this, the
      // orchestrator can't see the [eN] ref to target.
      if (isFileInput(el)) return true;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none';
    }
    // Disabled detection: native disabled attr, aria-disabled, or
    // pointer-events:none. Marking these in the AX text is critical —
    // without it the planner sees a perfectly-named "Apply" button and
    // tries to click it, then Playwright sits on the locator for 5s
    // waiting for it to become enabled and times out (Facebook's
    // Marketplace location filter does this: Apply stays aria-disabled
    // until you pick a suggestion from the autocomplete dropdown).
    function disabled(el) {
      if (el.disabled) return true;
      const aria = el.getAttribute('aria-disabled');
      if (aria === 'true') return true;
      const cs = getComputedStyle(el);
      if (cs.pointerEvents === 'none') return true;
      return false;
    }
    // Suggestion detection: an option/menuitem/listitem inside a listbox/
    // menu/combobox container is an autocomplete dropdown entry. Mirroring
    // the (disabled) flag with a (suggestion) flag gives the planner a
    // stable keyword to anchor on regardless of how clean the accessible-
    // name extraction is. Critical for the SEARCH/LOCATION FORM pattern
    // where the planner needs to pick an option to un-disable Apply.
    function suggestion(el, role) {
      if (role !== 'option' && role !== 'menuitem' && role !== 'listitem') {
        return false;
      }
      let p = el.parentElement;
      // Walk up a bounded number of ancestors — autocomplete containers
      // are typically 1-3 levels above the option. Don't traverse the
      // whole tree (every page has a body element).
      for (let i = 0; i < 6 && p; i++) {
        const r = p.getAttribute('role');
        if (r === 'listbox' || r === 'menu' || r === 'combobox') return true;
        p = p.parentElement;
      }
      return false;
    }

    // Reset previous refs so we don't accumulate stale tags across snapshots.
    document.querySelectorAll('[data-holo-ref]').forEach(e => e.removeAttribute('data-holo-ref'));

    const elements = Array.from(document.querySelectorAll(interactiveSel))
      .filter(visible);

    let counter = 1;
    const lines = [];
    for (const el of elements) {
      const ref = 'e' + counter;
      el.setAttribute('data-holo-ref', ref);
      const role = roleOf(el);
      const name = nameOf(el).trim().replace(/\\s+/g, ' ').slice(0, 80);
      const isDisabled = disabled(el);
      let flags = '';
      if (isDisabled) {
        flags = ' (disabled)';
      } else if (suggestion(el, role)) {
        flags = ' (suggestion)';
      } else if (role === 'file-input') {
        // Discoverability cue: tells the orchestrator to use
        // browser_set_input_files for this ref, NOT browser_click
        // (which would open the native picker we're trying to skip)
        // and NOT agent_do (vision-grounded file dialogs are the
        // single biggest source of upload failures). Surface accept=
        // and the multi-file flag so the orchestrator knows what
        // file(s) to pass.
        const accept = el.getAttribute('accept') || '';
        const multi = el.multiple ? ' multi-file' : '';
        flags = ' (use browser_set_input_files' +
          (accept ? ', accepts=' + accept : '') +
          multi + ')';
      }
      lines.push('[' + ref + '] ' + role + (name ? ' "' + name + '"' : '') + flags);
      counter++;
    }
    return {
      url: location.href,
      title: document.title || '',
      ax: lines.join('\\n') || '(no interactive elements visible)',
    };
  })()`;
})();

// ---------------------------------------------------------------------------
// Singleton relay + Playwright connection.
//
// Lifecycle:
//   • App boot calls createPlaywriterClient() once. Cheap — no I/O yet.
//   • First `available()` probe lazily starts the relay (fast — ~50ms)
//     and tries to connect over CDP.
//   • If no tab is "green" (extension not clicked on any tab), the
//     connect succeeds at the relay level but yields zero contexts/pages.
//     We surface that as not-available + a status message so the user
//     knows to click the extension. Subsequent probes retry the connect
//     so they "just work" the moment the extension goes green.
// ---------------------------------------------------------------------------

interface State {
  modules: { pw: PlaywriterModule; core: PlaywrightCoreModule } | null;
  relayStarted: boolean;
  browser: PWBrowser | null;
  page: PWPage | null;
  /** Refs from the most recent snapshot. We don't actually store anything
   *  per-ref — the data attribute on the live DOM IS the ref store. We
   *  only track the set so we can validate "is e12 a real ref" before
   *  trying to click it. */
  refSet: Set<string>;
  lastStatusKey: string;
  bootPromise: Promise<boolean> | null;
}

const PROBE_TIMEOUT_MS = 1500;

export interface PlaywriterClientConfig {
  /** Surface relay/extension status to the buddy bubble. Optional —
   *  callers without UI can omit. We dedupe identical status messages
   *  internally so a polling caller doesn't spam the bubble. */
  onStatus?: (text: string) => void;
  /**
   * NO-EXTENSION mode (2026-06-17): a CDP endpoint URL of a Chrome the
   * caller launched itself with `--remote-debugging-port` (+ a dedicated
   * user-data-dir). When set, the client skips the Playwriter relay +
   * extension entirely and `connectOverCDP(cdpUrl)` directly — everything
   * downstream (data-holo-ref snapshot, click/type by ref) is identical.
   * This is the "Granola/Notion" path: drive the user's own Chrome with no
   * extension to install and no green-icon gesture.
   */
  cdpUrl?: string;
}

export async function createPlaywriterClient(
  cfg: PlaywriterClientConfig = {},
): Promise<BrowserClient> {
  const state: State = {
    modules: null,
    relayStarted: false,
    browser: null,
    page: null,
    refSet: new Set(),
    lastStatusKey: "",
    bootPromise: null,
  };

  function emitStatus(key: string, text: string): void {
    if (state.lastStatusKey === key) return;
    state.lastStatusKey = key;
    cfg.onStatus?.(text);
    console.log(`[browser] ${text}`);
  }

  async function startRelay(): Promise<boolean> {
    if (!state.modules) state.modules = await tryLoadModules();
    if (!state.modules) {
      emitStatus(
        "no-modules",
        "Browser control unavailable — playwriter / playwright-core not installed.",
      );
      return false;
    }
    if (state.relayStarted) return true;

    // Pre-flight: is :19988 already serving a Playwriter relay? This
    // happens when the user has the Holo3 Electron app running AND the
    // MCP server in Claude Code at the same time — both try to bind
    // the same port. Calling startPlayWriterCDPRelayServer() in that
    // case can hang while the library waits for the port. Probe first
    // and skip the start step if a relay is already up — Playwriter
    // supports multiple Playwright clients sharing one relay.
    const existing = await fetchRelayExtensions();
    if (existing !== null) {
      state.relayStarted = true;
      console.log(
        "[browser] reusing existing Playwriter relay on :19988 " +
          `(${existing.length} extension connection${existing.length === 1 ? "" : "s"})`,
      );
      return true;
    }

    try {
      // PLAYWRITER_AUTO_ENABLE: "Auto-create a tab when Playwright connects
      // (no manual extension click needed)." Confirmed in MCP.md. Without
      // this, the user has to click the green Playwriter icon in their
      // toolbar before our connect() call sees any tabs. With it, we just
      // connect and Playwriter spins up a fresh attached tab on its own.
      // Set BEFORE startPlayWriterCDPRelayServer so the relay reads it.
      if (!process.env.PLAYWRITER_AUTO_ENABLE) {
        process.env.PLAYWRITER_AUTO_ENABLE = "1";
      }
      // Race the start against a 3s deadline. If the library hangs
      // (port collision the probe didn't catch, etc.), we treat it as
      // failed and fall back to "browser unavailable" rather than
      // hanging the whole MCP request indefinitely.
      const started = await Promise.race([
        state.modules.pw
          .startPlayWriterCDPRelayServer!()
          .then(() => true as const)
          .catch(() => "error" as const),
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), 3000),
        ),
      ]);
      if (started === true) {
        state.relayStarted = true;
        console.log(
          `[browser] Playwriter relay started (PLAYWRITER_AUTO_ENABLE=${process.env.PLAYWRITER_AUTO_ENABLE})`,
        );
        return true;
      }
      emitStatus(
        "relay-failed",
        started === "timeout"
          ? "Browser relay failed to start (timed out after 3s — is :19988 owned by another process?)"
          : "Browser relay failed to start.",
      );
      return false;
    } catch (e) {
      emitStatus(
        "relay-failed",
        `Browser relay failed to start: ${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    }
  }

  async function connectIfPossible(): Promise<boolean> {
    if (!state.modules) return false;
    if (state.browser && state.page && !state.page.isClosed()) {
      return true;
    }
    // No-extension path: connect straight to a self-launched Chrome's CDP
    // endpoint. No relay, no extension, no green-icon gesture.
    if (cfg.cdpUrl) {
      try {
        const browser = (await state.modules.core.chromium.connectOverCDP(
          cfg.cdpUrl,
        )) as PWBrowser;
        const ctx = browser.contexts()[0];
        if (!ctx) {
          await browser.close().catch(() => {});
          emitStatus("no-tab", "CDP endpoint has no browser context yet.");
          return false;
        }
        const pages = ctx.pages();
        const real = pages.filter((p) => !isWelcomeTab(p) && !p.isClosed());
        const page = real[0] ?? pages[0] ?? (await ctx.newPage());
        state.browser = browser;
        state.page = page;
        emitStatus("connected", `Connected (no-ext) — ${page.url() || "ready"}.`);
        return true;
      } catch (e) {
        emitStatus(
          "connect-failed",
          `Direct CDP connect failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        state.browser = null;
        state.page = null;
        return false;
      }
    }
    try {
      // When the user has multiple Playwriter extensions installed (very
      // common on dev machines: Web Store production + the unpacked dev
      // extension), the relay's auto-fallback only kicks in if EXACTLY one
      // extension has active targets. With two installed and PLAYWRITER_AUTO_
      // ENABLE creating a welcome tab on the production one, BOTH end up
      // "active" and the WS handshake is closed with code 4003
      // ("Multiple extensions connected. Specify extensionId."). We probe
      // /extensions/status, pick the best candidate (prefer production +
      // active tabs), and pass extensionId on the URL so the relay knows
      // which one we mean. Single-extension installs hit the same code path
      // harmlessly: pickBestExtension() returns the only one and the URL
      // gets a redundant-but-correct extensionId query.
      const extensions = await fetchRelayExtensions();
      const chosen = extensions ? pickBestExtension(extensions) : null;
      if (extensions && extensions.length === 0) {
        // Relay is up, no extension has connected at all.
        emitStatus(
          "no-extension",
          "Open Chrome and install the Playwriter extension, then click its icon on the tab you want me to control.",
        );
        return false;
      }
      const cdpUrl = chosen
        ? state.modules.pw.getCdpUrl!({ extensionId: chosen.extensionId })
        : state.modules.pw.getCdpUrl!();
      const browser = (await state.modules.core.chromium.connectOverCDP(
        cdpUrl,
      )) as PWBrowser;

      const ctx = browser.contexts()[0];
      if (!ctx) {
        // Relay alive but no extension-attached tabs. User hasn't clicked
        // the green icon yet (or all attached tabs were closed).
        await browser.close().catch(() => {});
        emitStatus(
          "no-tab",
          "Click the Playwriter extension icon on the Chrome tab you want me to control (it turns green).",
        );
        return false;
      }
      // Pick the most useful page. PLAYWRITER_AUTO_ENABLE=1 spawns a fresh
      // chrome-extension://<id>/src/welcome.html tab whenever the relay has
      // no other targets — the snapshot is empty (~48b) which previously
      // sent the agent into a `browser.click e1` loop. The welcome page is
      // perfectly drivable though: it just needs a navigate. We prefer a
      // real user tab when one exists (user clicked the extension icon on
      // their own tab), but otherwise we keep the welcome tab AND the agent
      // can use `browser.navigate <url>` to jump to where the task lives.
      // No scary status — silent zero-click experience.
      const pages = ctx.pages();
      const realPages = pages.filter(
        (p) => !isWelcomeTab(p) && !p.isClosed(),
      );
      let page: PWPage;
      if (realPages.length > 0) {
        page = realPages[0]!;
      } else if (pages.length > 0) {
        page = pages[0]!;
      } else {
        page = await ctx.newPage();
      }
      state.browser = browser;
      state.page = page;
      emitStatus(
        "connected",
        `Connected to Chrome — ${page.url() || "ready"}.`,
      );
      return true;
    } catch (e) {
      emitStatus(
        "connect-failed",
        `Connecting to Chrome failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      // Drop refs so we retry from scratch next probe.
      state.browser = null;
      state.page = null;
      return false;
    }
  }

  async function ensureChrome(): Promise<boolean> {
    // No-extension mode skips the relay; just make sure modules are loaded
    // before connectIfPossible() reaches for state.modules.core.chromium.
    if (cfg.cdpUrl) {
      if (!state.modules) state.modules = await tryLoadModules();
      if (!state.modules) return false;
      return await connectIfPossible();
    }
    if (!(await startRelay())) return false;
    return await connectIfPossible();
  }

  async function withTimeout<T>(
    p: Promise<T>,
    ms: number,
    fallback: T,
  ): Promise<T> {
    return await Promise.race([
      p,
      new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
    ]);
  }

  function refToSelector(ref: string): string {
    // Refs are tagged onto live DOM elements as data-holo-ref="eN" by the
    // snapshot script. Resolving back is just a CSS attribute selector —
    // works for ANY element regardless of role/name, sidesteps brittle
    // text-matching, and Playwright's auto-waiting handles transient
    // layout shifts.
    return `[data-holo-ref="${ref}"]`;
  }

  /**
   * Visibly highlights the element with `ref` for ~600ms so the user can SEE
   * which element the agent is acting on BEFORE the click/type/upload fires.
   * Injects a position:fixed overlay with a green outline + glow + optional
   * caption. Self-removes. Fire-and-forget; we await ~180ms after injection
   * so the highlight is on screen by the time the action runs.
   *
   * Why this is a wrapper around page.evaluate (not a CSS class on the
   * element itself): we don't own the page's stylesheet, can't assume a
   * class won't conflict, and the bbox can change between snapshot and
   * action — capturing it inside page.evaluate gives the freshest values.
   *
   * For zero-size refs (typical for hidden file-inputs), we walk up to a
   * visible ancestor (label / button / role=button / parent) so the user
   * still sees something meaningful when the upload kicks off.
   */
  async function highlightRef(
    page: PWPage,
    ref: string,
    label?: string,
  ): Promise<void> {
    const sel = refToSelector(ref);
    try {
      await page.evaluate<unknown>(
        (rawArg: unknown) => {
          const args = rawArg as { sel: string; label: string | null };
          const findVisible = (start: Element | null): Element | null => {
            let cur: Element | null = start;
            for (let i = 0; cur && i < 6; i++) {
              const r = cur.getBoundingClientRect();
              if (r.width > 4 && r.height > 4) return cur;
              cur = cur.parentElement;
            }
            return start;
          };
          try {
            const raw = document.querySelector(args.sel);
            const el = findVisible(raw);
            if (!el) return;
            (el as HTMLElement).scrollIntoView({
              block: "center",
              inline: "center",
              behavior: "instant" as ScrollBehavior,
            });
            const r = el.getBoundingClientRect();
            const overlay = document.createElement("div");
            overlay.setAttribute("data-holo-highlight", "1");
            Object.assign(overlay.style, {
              position: "fixed",
              left: `${Math.max(0, r.left - 4)}px`,
              top: `${Math.max(0, r.top - 4)}px`,
              width: `${Math.max(8, r.width + 8)}px`,
              height: `${Math.max(8, r.height + 8)}px`,
              pointerEvents: "none",
              border: "3px solid #00e676",
              borderRadius: "6px",
              boxShadow:
                "0 0 0 2px rgba(0, 230, 118, 0.35), 0 0 14px rgba(0, 230, 118, 0.55)",
              zIndex: "2147483647",
              transition: "opacity 200ms ease-out",
              opacity: "0",
              background: "rgba(0, 230, 118, 0.08)",
            } as Partial<CSSStyleDeclaration>);
            document.documentElement.appendChild(overlay);
            requestAnimationFrame(() => {
              overlay.style.opacity = "1";
            });
            if (args.label) {
              const cap = document.createElement("div");
              Object.assign(cap.style, {
                position: "absolute",
                left: "0px",
                top: r.top < 28 ? `${r.height + 6}px` : "-22px",
                background: "#00c853",
                color: "white",
                font: "12px/1 -apple-system, BlinkMacSystemFont, sans-serif",
                padding: "4px 6px",
                borderRadius: "4px",
                whiteSpace: "nowrap",
                maxWidth: "320px",
                overflow: "hidden",
                textOverflow: "ellipsis",
              } as Partial<CSSStyleDeclaration>);
              cap.textContent = args.label.slice(0, 80);
              overlay.appendChild(cap);
            }
            window.setTimeout(() => {
              overlay.style.opacity = "0";
              window.setTimeout(() => overlay.remove(), 220);
            }, 550);
          } catch {
            // best-effort — never break the action over a highlight
          }
        },
        { sel, label: label ?? null },
      );
      // Brief on-screen latency so the highlight is visible BEFORE the
      // action fires. ~180ms is short enough not to feel sluggish, long
      // enough to register visually for the user.
      await new Promise((resolve) => setTimeout(resolve, 180));
    } catch {
      // never block the real action over a highlight failure
    }
  }

  async function activePage(): Promise<PWPage | null> {
    if (!(await ensureChrome())) return null;
    return state.page;
  }

  /**
   * Tandem-mode tab sync (2026-06-10): re-point state.page at whichever
   * tab is VISUALLY active in Chrome before snapshotting.
   *
   * Previously snapshot() called page.bringToFront() unconditionally,
   * which silently reverted any tab switch performed by the vision path
   * or the user mid-run — the agent would vision-click a tab, and the
   * very next snapshot yanked the OLD tab back to front, so the two
   * stacks fought each other every step (the "playwriter & vlm out of
   * sync" failure). Now Playwriter FOLLOWS the visible tab instead of
   * fighting it: if state.page is hidden but a sibling tab is visible,
   * adopt the visible one. bringToFront only fires when NOTHING is
   * visible (window minimized / only the welcome tab) — the one case
   * where forcing is correct.
   *
   * visibilityState probes are capped (Promise.race not needed — they
   * resolve in <5ms on attached tabs; a closed page rejects and is
   * skipped).
   */
  async function syncToVisibleTab(page: PWPage): Promise<PWPage> {
    const isVisible = async (p: PWPage): Promise<boolean> => {
      try {
        return (
          (await p.evaluate<unknown>("document.visibilityState")) === "visible"
        );
      } catch {
        return false;
      }
    };
    try {
      if (await isVisible(page)) return page;
      const ctx = state.browser?.contexts()[0];
      const siblings = ctx
        ? ctx.pages().filter((p) => !p.isClosed() && !isWelcomeTab(p))
        : [];
      for (const p of siblings) {
        if (p === page) continue;
        if (await isVisible(p)) {
          emitStatus(
            "tab-follow",
            `Following the visible Chrome tab: ${p.url()}`,
          );
          state.page = p;
          return p;
        }
      }
      // Nothing visible — Chrome minimized or covered. Forcing the
      // current page front is the legacy behavior and correct here.
      await page.bringToFront();
    } catch {
      // best-effort — snapshot still works on a hidden page
    }
    return page;
  }

  return {
    async available(): Promise<boolean> {
      if (!state.bootPromise) {
        state.bootPromise = withTimeout(ensureChrome(), PROBE_TIMEOUT_MS, false);
      }
      const ok = await state.bootPromise;
      // Always reset so the next probe re-attempts (the user may have
      // just clicked the extension, the page may have closed, etc.).
      state.bootPromise = null;
      return ok;
    },

    async snapshot(): Promise<BrowserSnapshot> {
      let page = await activePage();
      if (!page) throw new Error("[browser] no active Chrome tab");
      // Follow (don't fight) tab switches made by the vision path or the
      // user — see syncToVisibleTab above.
      page = await syncToVisibleTab(page);
      // Run the DOM walker IN-PAGE. Returns { url, title, ax } directly so
      // we don't have to call page.url()/title() afterward.
      const result = (await page.evaluate<unknown>(SNAPSHOT_SCRIPT)) as {
        url: string;
        title: string;
        ax: string;
      };
      // Repopulate refSet from the lines we just emitted. Each line starts
      // with "[eN]" so we extract them.
      state.refSet.clear();
      for (const m of result.ax.matchAll(/^\[(e\d+)\]/gm)) {
        state.refSet.add(m[1]!);
      }
      return result;
    },

    async isActive(): Promise<boolean> {
      const page = await activePage();
      if (!page) return false;
      try {
        return (
          (await page.evaluate<unknown>("document.visibilityState")) ===
          "visible"
        );
      } catch {
        return false;
      }
    },

    // Bring the CONTROLLED tab's window+tab to the foreground. Used when
    // the screenshot shows a DIFFERENT tab than browser_* controls (the
    // controlled tab is a background tab, often in another Chrome window).
    // page.bringToFront() activates the tab AND raises its window, so
    // vision actions then hit the real page. Best-effort.
    async bringToFront(): Promise<void> {
      const page = await activePage();
      if (!page) return;
      try {
        await page.bringToFront();
      } catch {
        /* best-effort — caller falls back to browser.* only */
      }
    },

    async geometry(): Promise<{
      window: { x: number; y: number; width: number; height: number };
      viewport: { x: number; y: number; width: number; height: number };
      devicePixelRatio: number;
    } | null> {
      const page = await activePage();
      if (!page) return null;
      try {
        const g = (await page.evaluate<unknown>(
          `({ sx: window.screenX, sy: window.screenY, ow: window.outerWidth,
              oh: window.outerHeight, iw: window.innerWidth,
              ih: window.innerHeight, dpr: window.devicePixelRatio })`,
        )) as {
          sx: number;
          sy: number;
          ow: number;
          oh: number;
          iw: number;
          ih: number;
          dpr: number;
        };
        // Viewport top-left in screen space: horizontal borders are
        // symmetric on macOS Chrome; everything above the viewport
        // (title bar, toolbar, bookmarks) is the remaining outer-inner
        // height delta.
        const borderX = Math.max(0, (g.ow - g.iw) / 2);
        return {
          window: { x: g.sx, y: g.sy, width: g.ow, height: g.oh },
          viewport: {
            x: g.sx + borderX,
            y: g.sy + (g.oh - g.ih) - borderX,
            width: g.iw,
            height: g.ih,
          },
          devicePixelRatio: g.dpr,
        };
      } catch {
        return null;
      }
    },

    async screenshot(): Promise<{
      pngB64: string;
      width: number;
      height: number;
    } | null> {
      const page = await activePage();
      if (!page) return null;
      try {
        // page.screenshot IS forwarded by the Playwriter relay (unlike
        // page.accessibility); browser-driver.ts has used it in prod since
        // 2026-06-18. fullPage:false captures just the CSS viewport.
        const buf = await page.screenshot({ type: "png", fullPage: false });
        const dims = pngDimensions(buf);
        return {
          pngB64: buf.toString("base64"),
          // DEVICE-pixel dims (Retina = 2× CSS). The caller scales by
          // imgW / window.innerWidth to recover CSS px for elementFromPoint.
          width: dims?.width ?? 0,
          height: dims?.height ?? 0,
        };
      } catch {
        return null;
      }
    },

    async click(ref: string): Promise<void> {
      const page = await activePage();
      if (!page) throw new Error("[browser] no active Chrome tab");
      // Brief green-outline highlight so the user can SEE which element the
      // agent is acting on — fire-and-forget overlay with ~180ms lead-in
      // before the click. Never blocks the action if the highlight injection
      // fails. See highlightRef() above for the full rationale.
      await highlightRef(page, ref, `click ${ref}`);
      // 2000ms timeout (was 5000ms): the most common reason a click hangs is
      // that the page repainted between snapshot capture and click execution
      // and the ref is gone from the DOM (Facebook Marketplace's price-range
      // form auto-applies on input change → Apply button vanishes; some
      // dropdowns close on outside-click; etc.). Waiting 5s for an element
      // that isn't coming back is wasted budget. The (disabled) anti-loop
      // guard in loop.ts already short-circuits the other 5s case (clicking
      // an aria-disabled button that's waiting on a prerequisite), so we
      // don't need the long Playwright fallback for that either. 2s still
      // covers the "page is mid-animation, element is briefly detached"
      // case but bails 3s sooner on truly-gone refs.
      await page.locator(refToSelector(ref)).click({ timeout: 2000 });
    },

    async type(
      ref: string,
      text: string,
      opts?: { submit?: boolean },
    ): Promise<void> {
      const page = await activePage();
      if (!page) throw new Error("[browser] no active Chrome tab");
      // Highlight before typing — same UX rationale as click. Truncated label
      // prevents leaking long values (passwords, paragraphs) into the page.
      const labelText = text.length > 24 ? text.slice(0, 24) + "…" : text;
      await highlightRef(page, ref, `type "${labelText}" → ${ref}`);
      const loc = page.locator(refToSelector(ref));
      await loc.click({ timeout: 2000 });
      await loc.fill(text);
      if (opts?.submit) await loc.press("Enter");
    },

    async setInputFiles(ref: string, paths: string[]): Promise<void> {
      const page = await activePage();
      if (!page) throw new Error("[browser] no active Chrome tab");
      // Resolve every path through the whitespace-tolerant resolver
      // before handing them to Playwright. The motivating bug from the
      // first Haiku benchmark run: macOS Screenshot filenames contain a
      // NARROW NO-BREAK SPACE (U+202F) between the time and "AM"/"PM"
      // — but the orchestrator re-types them with a regular ASCII space
      // (U+0020). The strings look identical to any reader, but
      // Playwright's setInputFiles failed with ENOENT because the
      // literal byte sequence didn't match the on-disk name. The
      // resolver scans the parent directory and matches under
      // whitespace-agnostic + Unicode-NFC + case-insensitive comparison,
      // so the upload Just Works without the orchestrator having to
      // know about U+202F.
      const resolved: string[] = [];
      for (const p of paths) {
        const r = await resolveFilePathTolerant(p);
        if (r.viaFuzz) {
          console.log(
            `[browser] setInputFiles: literal path "${p}" not found; fuzz-matched to "${r.resolved}"`,
          );
        }
        resolved.push(r.resolved);
      }
      // Playwright's setInputFiles writes to the underlying <input
      // type="file"> element AND fires the synthetic `change` event
      // the page is listening for, so the styled UI (preview thumbnail,
      // upload progress, etc.) reacts exactly as if the user picked
      // the files in a Finder dialog. Works against:
      //   • the input itself (typical when the orchestrator targets a
      //     ref flagged "file-input" in the snapshot)
      //   • a <label for="…"> that hosts the input (Playwright walks
      //     the for/id link)
      //   • some styled wrapper buttons that delegate to a hidden
      //     input via JS (works when Playwright resolves the input
      //     under the wrapper)
      // The locator can target a hidden / display:none input — that's
      // why the snapshot now surfaces hidden file inputs and tags them
      // with (use browser_set_input_files).
      // Highlight BEFORE the input change fires. The file-input itself is
      // typically zero-size (hidden under a styled "Add photo" button);
      // highlightRef walks up to the nearest visible ancestor so the user
      // sees the actual button glow green when the upload kicks off.
      const fileLabel =
        resolved.length === 1
          ? `upload ${path.basename(resolved[0]!)} → ${ref}`
          : `upload ${resolved.length} files → ${ref}`;
      await highlightRef(page, ref, fileLabel);
      await page.locator(refToSelector(ref)).setInputFiles(resolved);
    },

    async scrollElement(
      ref: string,
      dir: "up" | "down",
      amount?: number,
    ): Promise<void> {
      const page = await activePage();
      if (!page) throw new Error("[browser] no active Chrome tab");
      const sel = refToSelector(ref);
      const px = (amount ?? 600) * (dir === "down" ? 1 : -1);
      await page.evaluate<unknown>(
        (args: unknown) => {
          const a = args as { sel: string; px: number };
          const el = document.querySelector(a.sel);
          if (el && "scrollBy" in el) {
            (el as Element & { scrollBy: (x: number, y: number) => void }).scrollBy(0, a.px);
          } else if (el) {
            (el as HTMLElement).scrollTop += a.px;
          }
        },
        { sel, px },
      );
    },

    async scrollPage(dir: "up" | "down", amount?: number): Promise<void> {
      const page = await activePage();
      if (!page) throw new Error("[browser] no active Chrome tab");
      const px = (amount ?? 800) * (dir === "down" ? 1 : -1);
      await page.evaluate<unknown>(
        (arg: unknown) => {
          const a = arg as { px: number };
          window.scrollBy({ top: a.px, behavior: "instant" as ScrollBehavior });
        },
        { px },
      );
    },

    async evaluate(expression: string): Promise<unknown> {
      const page = await activePage();
      if (!page) throw new Error("[browser] no active Chrome tab");
      // Pass the expression as a STRING (not a closure) so it serializes over
      // the Playwriter relay/CDP unchanged. Caller supplies a self-contained,
      // JSON-returning expression.
      return await page.evaluate(expression);
    },

    async readText(ref?: string): Promise<string> {
      const page = await activePage();
      if (!page) throw new Error("[browser] no active Chrome tab");
      if (ref) return await page.locator(refToSelector(ref)).innerText();
      // Firecrawl-style cleaner. Three things on top of plain
      // document.body.innerText:
      //   1. SKIP nav / header / footer / aside / dialogs / scripts /
      //      svg / iframes / aria-hidden / role=navigation|banner|
      //      contentinfo|complementary|search. These are the bulk of a
      //      Marketplace page that ISN'T listings — without stripping
      //      them, half the closer's budget is "About · Privacy · Terms
      //      · Cookies …" and "Inbox / Notifications / Messenger".
      //   2. PREFER the main content container if one exists (`<main>`,
      //      [role=main], [role=feed]). Falls back to <body>.
      //   3. ANNOTATE links: every <a> gets " (href)" appended after its
      //      text so listing titles connect to their URLs in the text
      //      dump. The closer can then return real clickable URLs, not
      //      just titles ("$2,800 1997 Toyota Camry (https://www.facebook.com/marketplace/item/12345)").
      // We walk the LIVE DOM (not a clone) to keep innerText layout-
      // correct, but emit no mutations — just collect text into an
      // array and join. Pure read-only.
      const text = await page.evaluate<string>(`
        (() => {
          const SKIP_SEL =
            'nav,header,footer,aside,' +
            '[role="navigation"],[role="banner"],[role="contentinfo"],' +
            '[role="complementary"],[role="search"],[role="dialog"],' +
            '[aria-hidden="true"],' +
            'script,style,noscript,svg,iframe,template,link[rel],meta';
          const BLOCK = new Set([
            'DIV','P','SECTION','ARTICLE','LI','TR','TD','TH','BR','HR',
            'H1','H2','H3','H4','H5','H6','UL','OL','BLOCKQUOTE','PRE',
            'MAIN','FIGURE','FORM','LABEL','FIELDSET',
          ]);
          const out = [];
          function walk(node) {
            if (!node) return;
            if (node.nodeType === 3) {
              const v = node.nodeValue;
              if (v && v.trim()) out.push(v);
              return;
            }
            if (node.nodeType !== 1) return;
            // Skip chrome (nav/header/footer/etc.) AND visibility-hidden
            // (CSS display:none / visibility:hidden) elements that the
            // user can't see but innerText would still miss anyway.
            if (node.matches && node.matches(SKIP_SEL)) return;
            // We don't call getComputedStyle (would be 1000s of calls
            // on a long page); rely on the SKIP_SEL list to catch the
            // big offenders.
            const tag = node.tagName;
            const isBlock = BLOCK.has(tag);
            if (isBlock) out.push('\\n');
            for (const child of node.childNodes) walk(child);
            // Annotate links inline: "Title (https://...)".
            if (tag === 'A') {
              const href = node.getAttribute('href');
              if (href && !href.startsWith('javascript:') && !href.startsWith('#')) {
                let abs = href;
                try { abs = new URL(href, location.href).href; } catch (_) {}
                out.push(' (' + abs + ')');
              }
            }
            if (isBlock) out.push('\\n');
          }
          const root =
            document.querySelector('main') ||
            document.querySelector('[role="main"]') ||
            document.querySelector('[role="feed"]') ||
            document.body;
          if (!root) return '';
          walk(root);
          // Collapse runs of whitespace/newlines so we don't burn LLM
          // tokens on the formatting. Keep paragraph breaks.
          return out
            .join('')
            .replace(/[ \\t]+/g, ' ')
            .replace(/ *\\n */g, '\\n')
            .replace(/\\n{3,}/g, '\\n\\n')
            .trim();
        })()
      `);
      return text.length > 50_000
        ? text.slice(0, 50_000) + "\n…(truncated)"
        : text;
    },

    async navigate(url: string): Promise<void> {
      const page = await activePage();
      if (!page) throw new Error("[browser] no active Chrome tab");
      await page.goto(url);
    },

    async newTab(url?: string): Promise<void> {
      const ensured = await activePage();
      if (!ensured || !state.browser) throw new Error("[browser] not connected to Chrome");
      const ctx = state.browser.contexts()[0];
      if (!ctx) throw new Error("[browser] no active Chrome context");
      const page = await ctx.newPage();
      state.page = page; // agent works in its OWN tab — the user's tabs stay put
      if (url) await page.goto(url);
    },

    async listTabs(): Promise<TabInfo[]> {
      // Force connect-if-needed via activePage(); we don't actually use
      // the returned page here (we want ALL pages), but ensureChrome()
      // is what populates state.browser.
      const ensured = await activePage();
      if (!ensured || !state.browser) return [];
      const ctx = state.browser.contexts()[0];
      if (!ctx) return [];
      const allPages = ctx.pages();

      // Title fetches are async and cheap individually but not free in
      // bulk — run them concurrently. Failures fall back to empty
      // string rather than dropping the tab from the listing.
      const titles = await Promise.all(
        allPages.map((p) =>
          p.isClosed()
            ? Promise.resolve("")
            : p.title().catch(() => ""),
        ),
      );

      const tabs: TabInfo[] = [];
      for (let i = 0; i < allPages.length; i++) {
        const p = allPages[i]!;
        if (p.isClosed()) continue;
        if (isWelcomeTab(p)) continue;
        tabs.push({
          index: i,
          url: p.url(),
          title: titles[i] ?? "",
          isCurrent: p === state.page,
        });
      }
      return tabs;
    },

    async switchTab(opts: SwitchTabOptions): Promise<TabInfo> {
      const ensured = await activePage();
      if (!ensured || !state.browser) {
        throw new Error("[browser] not connected to Chrome");
      }
      const ctx = state.browser.contexts()[0];
      if (!ctx) throw new Error("[browser] no active Chrome context");
      const allPages = ctx.pages();

      // Resolve the target page. `index` wins over the others; otherwise
      // urlIncludes (substring, case-insensitive) wins over pattern
      // (regex). Welcome tabs are always excluded — the orchestrator
      // never wants to switch ONTO a welcome page.
      let target: PWPage | null = null;
      let targetIndex = -1;
      let matchReason = "";

      if (typeof opts.index === "number") {
        if (opts.index < 0 || opts.index >= allPages.length) {
          throw new Error(
            `[browser] no tab at index ${opts.index} (have ${allPages.length} tabs total)`,
          );
        }
        const p = allPages[opts.index]!;
        if (p.isClosed()) {
          throw new Error(
            `[browser] tab at index ${opts.index} is closed`,
          );
        }
        if (isWelcomeTab(p)) {
          throw new Error(
            `[browser] tab at index ${opts.index} is a welcome tab; pick a real tab`,
          );
        }
        target = p;
        targetIndex = opts.index;
        matchReason = `index ${opts.index}`;
      } else if (opts.urlIncludes) {
        const needle = opts.urlIncludes.toLowerCase();
        for (let i = 0; i < allPages.length; i++) {
          const p = allPages[i]!;
          if (p.isClosed() || isWelcomeTab(p)) continue;
          if (p.url().toLowerCase().includes(needle)) {
            target = p;
            targetIndex = i;
            matchReason = `urlIncludes "${opts.urlIncludes}"`;
            break;
          }
        }
      } else if (opts.pattern) {
        let regex: RegExp;
        try {
          regex = new RegExp(opts.pattern, "i");
        } catch (e) {
          throw new Error(
            `[browser] invalid regex pattern: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        for (let i = 0; i < allPages.length; i++) {
          const p = allPages[i]!;
          if (p.isClosed() || isWelcomeTab(p)) continue;
          if (regex.test(p.url())) {
            target = p;
            targetIndex = i;
            matchReason = `pattern /${opts.pattern}/i`;
            break;
          }
        }
      } else {
        throw new Error(
          "[browser] switchTab requires one of: index, urlIncludes, pattern",
        );
      }

      if (!target) {
        // Build a useful error: list what IS attached so the orchestrator
        // can pick from it on the next call without a separate listTabs.
        const attached = allPages
          .map((p, i) =>
            p.isClosed() || isWelcomeTab(p) ? null : `  [${i}] ${p.url()}`,
          )
          .filter(Boolean)
          .join("\n");
        throw new Error(
          `[browser] no attached tab matched (criterion: ${matchReason || JSON.stringify(opts)}).\n` +
            `Currently attached:\n${attached || "  (none)"}`,
        );
      }

      state.page = target;
      try {
        await target.bringToFront();
      } catch {
        // best-effort — bringToFront can fail if the user manually
        // disabled the extension on this tab between listTabs and
        // switchTab. The page is still controllable for snapshot/click.
      }
      let title = "";
      try {
        title = await target.title();
      } catch {
        /* best-effort */
      }
      console.log(
        `[browser] switched to tab ${targetIndex} (${matchReason}): ${target.url()}`,
      );
      return {
        index: targetIndex,
        url: target.url(),
        title,
        isCurrent: true,
      };
    },

    // AGP thin-driver hooks. Return the LIVE Playwright objects (full API,
    // not the minimal PWPage/PWBrowser shape-types) so the AGP CommandExecutor
    // can drive mouse/keyboard/screenshot/locators directly. ensureChrome()
    // reuses all the relay + connection + extension-disambiguation logic.
    async rawPage(): Promise<unknown> {
      return await activePage();
    },

    async rawContext(): Promise<unknown> {
      if (!(await ensureChrome())) return null;
      return state.browser?.contexts()[0] ?? null;
    },

    async close(): Promise<void> {
      if (state.browser) {
        try {
          await state.browser.close();
        } catch {
          /* relay teardown is best-effort */
        }
      }
      state.browser = null;
      state.page = null;
      state.bootPromise = null;
      state.refSet.clear();
      // Don't tear down the relay — it's idempotent in case a future
      // available() call wants to retry attaching.
    },
  };
}
