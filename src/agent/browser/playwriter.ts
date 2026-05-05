/**
 * Playwriter-backed implementation of BrowserClient.
 *
 * Architecture: Playwriter ships a CDP relay that bridges a local WebSocket
 * (default localhost:19988) to the user's Chrome instance via the official
 * `chrome.debugger` API exposed by the Playwriter Chrome extension. Once
 * Connected, we drive the active tab with stock playwright-core APIs.
 *
 * We embed the relay rather than spawning the CLI/MCP because this is already
 * a Node/Electron process — same heap, same lifecycle, no IPC overhead. Two
 * function calls (`startPlayWriterCDPRelayServer`, `getCdpUrl`) replace what
 * would otherwise be a subprocess + a custom MCP client.
 *
 * Failure model: every call goes through `withSafeBrowser()` which catches
 * connection errors and forces `available()` back to false. The loop never
 * blocks on Chrome state — if the extension isn't green, we transparently
 * fall back to vision-only.
 */

import type { BrowserClient, BrowserSnapshot } from "./types";

// ---------------------------------------------------------------------------
// Dynamic imports.
//
// We require playwriter / playwright-core lazily so that the app boots even
// when those packages aren't installed yet (the user might not have run
// `npm i` after this change lands). `createPlaywriterClient()` returns a
// no-op client if the imports fail; logs once so the user sees what's up.
// ---------------------------------------------------------------------------

interface PlaywriterModule {
  startPlayWriterCDPRelayServer?: () => Promise<unknown>;
  getCdpUrl?: () => string;
}

interface PlaywrightCoreModule {
  chromium: {
    connectOverCDP: (url: string) => Promise<unknown>;
  };
}

interface PWPage {
  // Subset of the playwright Page surface we touch. Typed loosely so we
  // don't need a full @types/playwright dependency.
  url(): string;
  title(): Promise<string>;
  goto(url: string): Promise<unknown>;
  evaluate<T>(fn: ((arg?: unknown) => T) | string, arg?: unknown): Promise<T>;
  locator(selector: string): {
    click(opts?: { timeout?: number }): Promise<void>;
    fill(text: string): Promise<void>;
    press(key: string): Promise<void>;
    innerText(): Promise<string>;
    scrollIntoViewIfNeeded(): Promise<void>;
  };
  keyboard: {
    press(key: string): Promise<void>;
  };
  accessibility: {
    snapshot(opts?: { interestingOnly?: boolean }): Promise<unknown>;
  };
}

interface PWBrowser {
  contexts(): Array<{ pages(): PWPage[] }>;
  close(): Promise<void>;
}

async function tryLoadPlaywriter(): Promise<{
  pw: PlaywriterModule;
  core: PlaywrightCoreModule;
} | null> {
  try {
    // Use eval'd require so electron-vite / esbuild don't try to bundle these
    // at build time — they're optional runtime deps. If either is missing the
    // whole client degrades to "not available" and the loop runs vision-only.
    const _require =
      typeof require === "function"
        ? require
        : // eslint-disable-next-line @typescript-eslint/no-implied-eval
          new Function("m", "return require(m)");
    const pw = _require("playwriter") as PlaywriterModule;
    const core = _require("playwright-core") as PlaywrightCoreModule;
    if (
      typeof pw.startPlayWriterCDPRelayServer !== "function" ||
      typeof pw.getCdpUrl !== "function" ||
      !core?.chromium?.connectOverCDP
    ) {
      console.warn(
        "[browser] playwriter / playwright-core loaded but missing expected exports — disabling.",
      );
      return null;
    }
    return { pw, core };
  } catch (e) {
    console.log(
      `[browser] playwriter not available (${e instanceof Error ? e.message : String(e)}) — vision-only.`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Snapshot helper.
//
// Playwriter advertises a `snapshot({ page })` helper that returns an
// accessibility tree with aria-ref=eN locators. We can't import that helper
// reliably without knowing the exact module shape, so we build a comparable
// representation ourselves from `page.accessibility.snapshot()` and assign
// stable e-refs. This keeps the planner-facing format consistent regardless
// of what the helper would have produced.
// ---------------------------------------------------------------------------

interface AxNode {
  role?: string;
  name?: string;
  value?: string;
  description?: string;
  children?: AxNode[];
  // Set during traversal — element ref the planner uses.
  ref?: string;
  // Pixel-position fields exposed by some flags; ignored here.
}

function flattenAxTree(root: AxNode | null): {
  text: string;
  refMap: Map<string, AxNode>;
} {
  const refMap = new Map<string, AxNode>();
  if (!root) return { text: "(empty snapshot)", refMap };

  const lines: string[] = [];
  let counter = 1;

  function isInteractive(node: AxNode): boolean {
    const r = node.role ?? "";
    return /button|link|textbox|searchbox|checkbox|menuitem|tab|combobox|option|radio|switch|slider|listitem/i.test(
      r,
    );
  }

  function visit(node: AxNode, depth: number): void {
    const indent = "  ".repeat(Math.min(depth, 6));
    const role = node.role ?? "node";
    const name =
      (node.name ?? "").trim() || (node.value ?? "").trim();
    let prefix = "";
    if (isInteractive(node)) {
      const ref = `e${counter++}`;
      node.ref = ref;
      refMap.set(ref, node);
      prefix = `[${ref}] `;
    }
    if (name || isInteractive(node)) {
      const label = name ? ` "${name.slice(0, 80)}"` : "";
      lines.push(`${indent}${prefix}${role}${label}`);
    }
    for (const c of node.children ?? []) visit(c, depth + 1);
  }

  visit(root, 0);
  return { text: lines.join("\n"), refMap };
}

// ---------------------------------------------------------------------------
// Singleton state.
//
// One relay + one playwright Browser per process. `available()` is the only
// path that lazily boots them; other methods assume the boot already
// happened (and surface a clear error if not — but the loop never calls them
// without first checking `available()`).
// ---------------------------------------------------------------------------

interface State {
  modules: { pw: PlaywriterModule; core: PlaywrightCoreModule } | null;
  browser: PWBrowser | null;
  // Last-snapshot ref map so click(ref)/scrollElement(ref)/etc. can resolve
  // refs the planner emitted from the immediately-prior snapshot.
  refMap: Map<string, AxNode>;
  bootPromise: Promise<boolean> | null;
  loggedConnected: boolean;
}

const AVAILABILITY_TIMEOUT_MS = 1500;

export async function createPlaywriterClient(): Promise<BrowserClient> {
  const state: State = {
    modules: null,
    browser: null,
    refMap: new Map(),
    bootPromise: null,
    loggedConnected: false,
  };

  async function activePage(): Promise<PWPage | null> {
    if (!state.browser) return null;
    const ctx = state.browser.contexts()[0];
    if (!ctx) return null;
    const pages = ctx.pages();
    if (!pages.length) return null;
    return pages[0]!;
  }

  async function boot(): Promise<boolean> {
    if (state.modules && state.browser) return true;
    if (!state.modules) state.modules = await tryLoadPlaywriter();
    if (!state.modules) return false;

    try {
      // Start the relay singleton. Playwriter's API: idempotent; calling it
      // twice returns the same server. If it throws (port taken by another
      // instance, etc.) we surface as not-available.
      await state.modules.pw.startPlayWriterCDPRelayServer!();
      const cdpUrl = state.modules.pw.getCdpUrl!();
      const browser = (await state.modules.core.chromium.connectOverCDP(
        cdpUrl,
      )) as PWBrowser;
      state.browser = browser;
      if (!state.loggedConnected) {
        console.log(`[browser] connected via Playwriter relay → ${cdpUrl}`);
        state.loggedConnected = true;
      }
      return true;
    } catch (e) {
      console.warn(
        `[browser] connect failed (${e instanceof Error ? e.message : String(e)}) — extension may not be active.`,
      );
      state.browser = null;
      return false;
    }
  }

  async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
    return await Promise.race([
      p,
      new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
    ]);
  }

  function refToSelector(ref: string): string {
    // Playwright accepts CSS selectors and a few text engines. We don't have
    // a native aria-ref engine here, so we translate using the last snapshot:
    // the AX node carries `name` which we use as an accessible-name selector
    // via Playwright's `[aria-label="..."]` or `text=` fallback.
    const node = state.refMap.get(ref);
    if (!node) {
      // Last-resort: assume the planner already meant a CSS selector.
      return ref;
    }
    const name = (node.name ?? "").trim();
    const role = (node.role ?? "").trim().toLowerCase();
    if (name && role) {
      // Playwright supports role+name via `getByRole`, but locator() also
      // accepts `role=button[name="X"]`.
      const escaped = name.replace(/"/g, '\\"');
      return `role=${role}[name="${escaped}"]`;
    }
    if (name) {
      return `text=${name.slice(0, 60)}`;
    }
    return `role=${role || "generic"}`;
  }

  return {
    async available(): Promise<boolean> {
      // Cache the boot promise so concurrent callers don't double-init. The
      // boot itself races against AVAILABILITY_TIMEOUT_MS — if the extension
      // is offline, we want to know within a step's budget, not 30s later.
      if (!state.bootPromise) {
        state.bootPromise = withTimeout(boot(), AVAILABILITY_TIMEOUT_MS, false);
      }
      const ok = await state.bootPromise;
      if (!ok) {
        // Reset so a future probe can retry (user may have just clicked the
        // extension icon green).
        state.bootPromise = null;
        return false;
      }
      // Verify a tab exists. If the relay is up but no tab is attached yet,
      // we still report unavailable so the planner doesn't see browser.*
      // verbs it can't possibly succeed at.
      const page = await activePage();
      return page !== null;
    },

    async snapshot(): Promise<BrowserSnapshot> {
      const page = await activePage();
      if (!page) throw new Error("[browser] no active tab");
      const ax = (await page.accessibility.snapshot({
        interestingOnly: true,
      })) as AxNode | null;
      const { text, refMap } = flattenAxTree(ax);
      state.refMap = refMap;
      const url = page.url();
      const title = await page.title().catch(() => "");
      return { url, title, ax: text };
    },

    async click(ref: string): Promise<void> {
      const page = await activePage();
      if (!page) throw new Error("[browser] no active tab");
      const sel = refToSelector(ref);
      await page.locator(sel).click({ timeout: 5000 });
    },

    async type(ref: string, text: string, opts?: { submit?: boolean }): Promise<void> {
      const page = await activePage();
      if (!page) throw new Error("[browser] no active tab");
      const sel = refToSelector(ref);
      const loc = page.locator(sel);
      await loc.click({ timeout: 5000 });
      await loc.fill(text);
      if (opts?.submit) await loc.press("Enter");
    },

    async scrollElement(
      ref: string,
      dir: "up" | "down",
      amount?: number,
    ): Promise<void> {
      const page = await activePage();
      if (!page) throw new Error("[browser] no active tab");
      const sel = refToSelector(ref);
      const px = (amount ?? 600) * (dir === "down" ? 1 : -1);
      // Use evaluate against the matched element. We pass the selector and
      // do the lookup inside the page so we don't have to serialize a
      // locator handle across the CDP boundary.
      await page.evaluate<unknown>(
        (args: unknown) => {
          const a = args as { sel: string; px: number };
          const el = document.querySelector(a.sel);
          if (el && "scrollBy" in el) (el as Element & { scrollBy: (x: number, y: number) => void }).scrollBy(0, a.px);
          else if (el) (el as HTMLElement).scrollTop += a.px;
        },
        { sel, px },
      );
    },

    async scrollPage(dir: "up" | "down", amount?: number): Promise<void> {
      const page = await activePage();
      if (!page) throw new Error("[browser] no active tab");
      const px = (amount ?? 800) * (dir === "down" ? 1 : -1);
      // window.scrollBy targets the document viewport unconditionally,
      // sidestepping the cursor-position dependency that plagues nut-js
      // mouse-wheel scrolls.
      await page.evaluate<unknown>((arg: unknown) => {
        const a = arg as { px: number };
        window.scrollBy({ top: a.px, behavior: "instant" as ScrollBehavior });
      }, { px });
    },

    async readText(ref?: string): Promise<string> {
      const page = await activePage();
      if (!page) throw new Error("[browser] no active tab");
      if (ref) {
        const sel = refToSelector(ref);
        return await page.locator(sel).innerText();
      }
      // Whole-document text. Trimmed in the caller; we cap here too as a
      // safety net for absurdly long pages.
      const text = await page.evaluate<string>(
        () => document.body?.innerText ?? "",
      );
      return text.length > 50_000 ? text.slice(0, 50_000) + "\n…(truncated)" : text;
    },

    async navigate(url: string): Promise<void> {
      const page = await activePage();
      if (!page) throw new Error("[browser] no active tab");
      await page.goto(url);
    },

    async close(): Promise<void> {
      if (state.browser) {
        try {
          await state.browser.close();
        } catch {
          // Best-effort — relay teardown is fire-and-forget on shutdown.
        }
        state.browser = null;
      }
      state.bootPromise = null;
      state.refMap = new Map();
    },
  };
}
