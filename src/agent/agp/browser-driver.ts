/**
 * CommandExecutor — the AGP thin-driver's execution engine.
 *
 * Long-polls the server brain's driver command queue and executes each
 * command against the user's real Chrome (the live Playwright `Page` from
 * playwriter), then posts the result back. This is the holo3-agent analog
 * of the HoloTab extension's `lib/agent/driver-executor.js`, re-targeted
 * from chrome.debugger/CDP onto Playwright's high-level Page API (which
 * works over the Playwriter CDP relay where raw CDP Input dispatch does
 * not).
 *
 * Grounding is dual, exactly like the extension:
 *   • VISION  — `screenshot_png_bytes` / `webpage_metadata` feed the model
 *     an image; it replies with `click_at {x,y}` in SCREENSHOT-PIXEL space,
 *     which we divide by devicePixelRatio to get the CSS px Playwright's
 *     mouse uses.
 *   • A11Y    — `observe` / `get_a11y_snapshot` return an extension-format
 *     accessibility outline with `[ref=eN]` tokens; the model replies with
 *     `click_element {ref}`, resolved via the `data-holo-ref` attribute.
 *
 * The executor owns no planning — it is a pure command pump.
 */

import {
  A11Y_SNAPSHOT_MAX_CHARS,
  DOM_STABLE_QUIESCE_MS,
  DOM_STABLE_TIMEOUT_MS,
  DRIVER_LONG_POLL_SECONDS,
  DRIVER_POLL_INTERVAL_MS,
  NAVIGATION_TIMEOUT_MS,
  NEW_TAB_SETTLE_MS,
} from "./constants";
import type { AgpClient, DriverCommand } from "./client";

const IS_MAC = process.platform === "darwin";

// ---------------------------------------------------------------------------
// Loose Playwright typings (the relay returns full Playwright objects; we
// only shape-type the methods we touch, mirroring playwriter.ts's approach).
// ---------------------------------------------------------------------------
interface PwLocator {
  click(opts?: { timeout?: number; clickCount?: number; button?: string }): Promise<void>;
  fill(text: string, opts?: { timeout?: number }): Promise<void>;
  selectOption(value: unknown, opts?: { timeout?: number }): Promise<string[]>;
  innerText(opts?: { timeout?: number }): Promise<string>;
  setInputFiles(paths: string | string[]): Promise<void>;
  hover(opts?: { timeout?: number }): Promise<void>;
  dragTo(target: PwLocator, opts?: { timeout?: number }): Promise<void>;
  press(key: string, opts?: { timeout?: number }): Promise<void>;
  count(): Promise<number>;
  scrollIntoViewIfNeeded(opts?: { timeout?: number }): Promise<void>;
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  screenshot(opts?: { type?: string }): Promise<Buffer>;
}
interface PwMouse {
  move(x: number, y: number, opts?: { steps?: number }): Promise<void>;
  down(opts?: { button?: string; clickCount?: number }): Promise<void>;
  up(opts?: { button?: string; clickCount?: number }): Promise<void>;
  click(x: number, y: number, opts?: { button?: string; clickCount?: number }): Promise<void>;
  wheel(dx: number, dy: number): Promise<void>;
}
interface PwKeyboard {
  press(key: string, opts?: { delay?: number }): Promise<void>;
  type(text: string, opts?: { delay?: number }): Promise<void>;
  insertText(text: string): Promise<void>;
  down(key: string): Promise<void>;
  up(key: string): Promise<void>;
}
interface PwPage {
  url(): string;
  title(): Promise<string>;
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  goBack(opts?: { timeout?: number }): Promise<unknown>;
  goForward(opts?: { timeout?: number }): Promise<unknown>;
  reload(opts?: { timeout?: number }): Promise<unknown>;
  evaluate<T = unknown>(fn: string | ((arg?: unknown) => T), arg?: unknown): Promise<T>;
  screenshot(opts?: { type?: string; fullPage?: boolean }): Promise<Buffer>;
  mouse: PwMouse;
  keyboard: PwKeyboard;
  locator(selector: string): PwLocator;
  bringToFront(): Promise<void>;
  isClosed(): boolean;
  waitForLoadState?(state?: string, opts?: { timeout?: number }): Promise<void>;
  on(event: string, handler: (arg: unknown) => void): void;
}
interface PwContext {
  pages(): PwPage[];
  newPage(): Promise<PwPage>;
}

/** Minimal accessor surface the executor needs from the browser client. */
export interface DriverBrowser {
  rawPage?(): Promise<unknown>;
  rawContext?(): Promise<unknown>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Key alias map → Playwright key names. Mirrors driver-executor.js's table.
const KEY_ALIASES: Record<string, string> = {
  universal_command: IS_MAC ? "Meta" : "Control",
  command: "Meta",
  cmd: "Meta",
  win: "Meta",
  option: "Alt",
  opt: "Alt",
  ctrl: "Control",
  control: "Control",
  shift: "Shift",
  alt: "Alt",
  meta: "Meta",
  del: "Delete",
  esc: "Escape",
  return: "Enter",
  enter: "Enter",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  pgup: "PageUp",
  pgdn: "PageDown",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  home: "Home",
  end: "End",
};

function mapKey(k: string): string {
  if (!k) return k;
  const lower = k.toLowerCase();
  if (KEY_ALIASES[lower]) return KEY_ALIASES[lower];
  // Single printable char passes through; multi-char unknown keys too.
  return k.length === 1 ? k : k[0]!.toUpperCase() + k.slice(1);
}

/** Map a chord like ["universal_command","a"] → "Meta+a" for Playwright. */
function mapChord(keys: string[]): string {
  return keys.map(mapKey).join("+");
}

/** Parse PNG width/height from the IHDR chunk (bytes 16-23, big-endian). */
function pngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  // PNG signature check (first 8 bytes).
  if (buf[0] !== 0x89 || buf[1] !== 0x50) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// ---------------------------------------------------------------------------
// In-page scripts.
// ---------------------------------------------------------------------------

/** DOM-quiesce wait: resolve once the DOM is silent for QUIESCE ms, capped
 *  by TIMEOUT ms. Faithful port of cdp.js waitForPageStable. */
const STABLE_SCRIPT = `(() => new Promise((resolve) => {
  const QUIESCE = ${DOM_STABLE_QUIESCE_MS}, CAP = ${DOM_STABLE_TIMEOUT_MS};
  let timer = null;
  const done = () => { try { obs.disconnect(); } catch(e){} resolve(true); };
  const bump = () => { if (timer) clearTimeout(timer); timer = setTimeout(done, QUIESCE); };
  const obs = new MutationObserver(bump);
  try { obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true }); } catch(e) { resolve(true); return; }
  bump();
  setTimeout(done, CAP);
}))()`;

/** Page metadata for webpage_metadata / screenshot_and_metadata. */
const META_SCRIPT = `(() => [
  document.body ? document.body.scrollWidth : 0,
  document.body ? document.body.scrollHeight : 0,
  window.pageXOffset, window.pageYOffset,
  window.innerWidth, window.innerHeight, window.devicePixelRatio || 1,
])()`;

/**
 * Accessibility outline in the extension's `[ref=eN]` format, tagging each
 * interactive element with data-holo-ref for later resolution. Approximates
 * accessibility.js's CDP-AXTree output (roles, names, flags, options) using
 * a DOM walk — the only mechanism available over the Playwriter relay.
 */
const AX_SNAPSHOT_SCRIPT = `(() => {
  const MAX_CHARS = ${A11Y_SNAPSHOT_MAX_CHARS};
  const interactiveSel = [
    'a[href]','button','input:not([type=hidden])','select','textarea',
    '[role="button"]','[role="link"]','[role="textbox"]','[role="searchbox"]',
    '[role="checkbox"]','[role="radio"]','[role="menuitem"]','[role="tab"]',
    '[role="combobox"]','[role="option"]','[role="switch"]','[contenteditable="true"]',
    'h1','h2','h3',
  ].join(',');
  function nameOf(el) {
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return aria;
    const lb = el.getAttribute && el.getAttribute('aria-labelledby');
    if (lb) { const n = document.getElementById(lb); if (n && n.textContent) return n.textContent; }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
      return el.placeholder || el.value || el.name || el.type || '';
    return ((el.innerText || el.textContent || '')).trim().slice(0, 100);
  }
  function roleOf(el) {
    const r = el.getAttribute && el.getAttribute('role');
    if (r) return r;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'submit' || t === 'button') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      return 'textbox';
    }
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    return tag;
  }
  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }
  function disabled(el) {
    if (el.disabled) return true;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
    return getComputedStyle(el).pointerEvents === 'none';
  }
  document.querySelectorAll('[data-holo-ref]').forEach(e => e.removeAttribute('data-holo-ref'));
  const els = Array.from(document.querySelectorAll(interactiveSel)).filter(visible);
  const lines = [];
  let counter = 0, chars = 0;
  for (const el of els) {
    if (chars >= MAX_CHARS) { lines.push('... (truncated)'); break; }
    const role = roleOf(el);
    const name = nameOf(el).replace(/\\s+/g, ' ').trim().slice(0, 100);
    let line;
    if (role === 'heading') {
      const lvl = el.tagName && /^H([1-6])$/.exec(el.tagName);
      line = '- heading' + (lvl ? ' (h' + lvl[1] + ')' : '') + (name ? ' "' + name + '"' : '');
    } else {
      const ref = 'e' + counter++;
      el.setAttribute('data-holo-ref', ref);
      let flags = '';
      if (disabled(el)) flags += ' [disabled]';
      if (el.getAttribute && el.getAttribute('aria-checked') === 'true') flags += ' [checked]';
      let opts = '';
      if (el.tagName === 'SELECT') {
        const o = Array.from(el.options || []).slice(0, 15).map(o => (o.text || o.value || '').trim()).filter(Boolean);
        if (o.length) opts = ' options=[' + o.join(', ') + ']';
      }
      const val = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.value ? ': "' + String(el.value).slice(0, 80) + '"' : '';
      line = '- ' + role + (name ? ' "' + name + '"' : '') + ' [ref=' + ref + ']' + flags + val + opts;
    }
    lines.push(line);
    chars += line.length + 1;
  }
  return {
    url: location.href,
    title: document.title || '',
    text: lines.join('\\n') || '(no interactive elements visible)',
  };
})()`;

interface ExecutorState {
  page: PwPage | null;
  scale: number; // devicePixelRatio
  imgW: number;
  imgH: number;
  mouse: { x: number; y: number };
  lastAxLines: string[] | null;
  consoleLogs: string[];
}

export interface CommandExecutorOpts {
  /** Called with a one-line trace of each executed command (for the UI/log). */
  onCommand?: (name: string, args: Record<string, unknown>) => void;
  /** Hard cap on commands executed before the executor self-stops. */
  maxCommands?: number;
}

export class CommandExecutor {
  private readonly client: AgpClient;
  private readonly browser: DriverBrowser;
  private readonly trajectoryId: string;
  private readonly opts: CommandExecutorOpts;
  private running = false;
  private abort: AbortController | null = null;
  private executed = 0;
  private readonly attachedPages = new WeakSet<object>();
  private readonly memory = new Map<string, unknown>();
  private s: ExecutorState = {
    page: null,
    scale: 1,
    imgW: 0,
    imgH: 0,
    mouse: { x: 0, y: 0 },
    lastAxLines: null,
    consoleLogs: [],
  };

  constructor(
    client: AgpClient,
    browser: DriverBrowser,
    trajectoryId: string,
    opts: CommandExecutorOpts = {},
  ) {
    this.client = client;
    this.browser = browser;
    this.trajectoryId = trajectoryId;
    this.opts = opts;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    void this.pumpLoop();
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
  }

  get commandCount(): number {
    return this.executed;
  }

  // ---- the long-poll command pump ----------------------------------------
  private async pumpLoop(): Promise<void> {
    while (this.running) {
      let cmds: DriverCommand[] | null = null;
      const t0 = Date.now();
      try {
        cmds = await this.client.getDriverCommands(
          this.trajectoryId,
          DRIVER_LONG_POLL_SECONDS,
          this.abort?.signal,
        );
      } catch (e) {
        if (!this.running || this.abort?.signal.aborted) break;
        const msg = (e as Error).message || "";
        if (msg.includes("auth error")) break;
        console.warn("[agp-driver] poll error:", msg);
        await sleep(DRIVER_POLL_INTERVAL_MS * 2);
        continue;
      }
      if (!cmds || cmds.length === 0) {
        // Min-100ms floor so an instant 204 can't busy-spin.
        const elapsed = Date.now() - t0;
        if (elapsed < 100) await sleep(100 - elapsed);
        continue;
      }
      for (const cmd of cmds) {
        if (!this.running) break;
        const result = await this.runOne(cmd);
        try {
          await this.client.postDriverResult(
            cmd.id,
            cmd.command_uid,
            result,
            this.abort?.signal,
          );
        } catch (e) {
          if (this.abort?.signal.aborted) break;
          console.warn(`[agp-driver] failed to deliver result for ${cmd.name}:`, (e as Error).message);
        }
        if (cmd.name === "destroy") {
          this.stop();
          break;
        }
        if (this.opts.maxCommands && this.executed >= this.opts.maxCommands) {
          console.warn(`[agp-driver] hit maxCommands=${this.opts.maxCommands}, stopping`);
          this.stop();
          break;
        }
      }
    }
  }

  private async runOne(cmd: DriverCommand): Promise<{ result: unknown; error: string | null }> {
    this.executed++;
    const args = cmd.args || {};
    this.opts.onCommand?.(cmd.name, args);
    try {
      const result = (await this.dispatch(cmd.name, args)) ?? null;
      return { result, error: null };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[agp-driver] command "${cmd.name}" failed:`, msg);
      return { result: null, error: msg };
    }
  }

  // ---- page access + helpers ----------------------------------------------
  private async page(): Promise<PwPage> {
    if (this.s.page && !this.s.page.isClosed()) return this.s.page;
    const raw = (await this.browser.rawPage?.()) as PwPage | null | undefined;
    if (!raw) throw new Error("No active Chrome tab. Click the Playwriter extension on a tab.");
    this.s.page = raw;
    this.attachConsole(raw);
    return raw;
  }

  private async ctx(): Promise<PwContext | null> {
    return ((await this.browser.rawContext?.()) as PwContext | null | undefined) ?? null;
  }

  private attachConsole(page: PwPage): void {
    if (this.attachedPages.has(page as object)) return;
    this.attachedPages.add(page as object);
    try {
      page.on("console", (msg: unknown) => {
        try {
          const m = msg as { type?: () => string; text?: () => string };
          const line = `[${m.type?.() ?? "log"}] ${m.text?.() ?? ""}`;
          this.s.consoleLogs.push(line);
          if (this.s.consoleLogs.length > 200) this.s.consoleLogs.shift();
        } catch {
          /* ignore */
        }
      });
    } catch {
      /* console capture is best-effort */
    }
  }

  private resetRefs(): void {
    this.s.lastAxLines = null;
  }

  private async waitStable(page: PwPage): Promise<void> {
    try {
      await page.evaluate(STABLE_SCRIPT);
    } catch {
      /* never fail an action on the settle wait */
    }
  }

  /** Convert screenshot-pixel coords from the brain to CSS px for Playwright. */
  private toCss(v: unknown): number {
    return Number(v) / (this.s.scale || 1);
  }

  private async capture(page: PwPage): Promise<string> {
    await this.waitStable(page);
    const buf = await page.screenshot({ type: "png", fullPage: false });
    const dims = pngDimensions(buf);
    if (dims) {
      this.s.imgW = dims.width;
      this.s.imgH = dims.height;
      try {
        const innerW = (await page.evaluate<number>("window.innerWidth")) || dims.width;
        this.s.scale = innerW > 0 ? dims.width / innerW : 1;
      } catch {
        this.s.scale = 1;
      }
    }
    return buf.toString("base64");
  }

  private async metadata(page: PwPage): Promise<Record<string, unknown>> {
    const [scrollW, scrollH, scrollX, scrollY, innerW, innerH, dpr] =
      (await page.evaluate<number[]>(META_SCRIPT)) ?? [0, 0, 0, 0, 0, 0, 1];
    const scale = this.s.scale || dpr || 1;
    const tabs = await this.tabIds();
    let title = "";
    try {
      title = await page.title();
    } catch {
      /* ignore */
    }
    return {
      mouse_position: [this.s.mouse.x, this.s.mouse.y],
      screen_size: [this.s.imgW || Math.round(innerW * scale), this.s.imgH || Math.round(innerH * scale)],
      tabs,
      active_tab: tabs[0] ?? "1",
      url: page.url(),
      title,
      page_size: [Math.round(scrollW * scale), Math.round(scrollH * scale)],
      scroll_position: [Math.round(scrollX * scale), Math.round(scrollY * scale)],
    };
  }

  private async tabIds(): Promise<string[]> {
    const ctx = await this.ctx();
    if (!ctx) return ["1"];
    return ctx
      .pages()
      .filter((p) => !p.isClosed())
      .map((_, i) => String(i + 1));
  }

  private async axSnapshot(page: PwPage): Promise<{ url: string; title: string; text: string }> {
    return await page.evaluate<{ url: string; title: string; text: string }>(AX_SNAPSHOT_SCRIPT);
  }

  /** Incremental diff vs the previous snapshot (port of computeSnapshotDiff). */
  private diffSnapshot(text: string): { out: string; isDiff: boolean } {
    const lines = text.split("\n");
    const prev = this.s.lastAxLines;
    this.s.lastAxLines = lines;
    if (!prev) return { out: text, isDiff: false };
    if (prev.length === lines.length && prev.every((l, i) => l === lines[i])) {
      return { out: "[No changes since last snapshot]", isDiff: true };
    }
    const diff: string[] = [];
    let unchanged = 0;
    for (let i = 0; i < Math.max(prev.length, lines.length); i++) {
      const a = prev[i];
      const b = lines[i];
      if (a === b) {
        unchanged++;
        continue;
      }
      if (unchanged > 0) {
        diff.push(`[${unchanged} unchanged lines]`);
        unchanged = 0;
      }
      if (a != null && b != null) diff.push(`~ ${b}`);
      else if (b != null) diff.push(`+ ${b}`);
      else diff.push(`- ${a}`);
    }
    if (unchanged > 0) diff.push(`[${unchanged} unchanged lines]`);
    // If more than 60% of lines changed, send the full snapshot instead.
    if (diff.length > lines.length * 0.6) return { out: text, isDiff: false };
    return { out: diff.join("\n"), isDiff: true };
  }

  private locFor(args: Record<string, unknown>, refKey = "ref", selKey = "selector"): PwLocator | null {
    const ref = args[refKey];
    const sel = args[selKey];
    if (typeof ref === "string" && ref) return this.s.page!.locator(`[data-holo-ref="${ref}"]`);
    if (typeof sel === "string" && sel) return this.s.page!.locator(sel);
    return null;
  }

  // ---- the command switch -------------------------------------------------
  private async dispatch(name: string, a: Record<string, unknown>): Promise<unknown> {
    const page = await this.page();
    switch (name) {
      // --- navigation ---
      case "goto": {
        if (!a.url) throw new Error("Missing required argument: url");
        await page.goto(String(a.url), { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
        await this.waitStable(page);
        this.resetRefs();
        return null;
      }
      case "current_url":
        return page.url();
      case "back":
        await page.goBack({ timeout: NAVIGATION_TIMEOUT_MS }).catch(() => {});
        await this.waitStable(page);
        this.resetRefs();
        return null;
      case "forward":
        await page.goForward({ timeout: NAVIGATION_TIMEOUT_MS }).catch(() => {});
        await this.waitStable(page);
        this.resetRefs();
        return null;
      case "refresh":
        await page.reload({ timeout: NAVIGATION_TIMEOUT_MS }).catch(() => {});
        await this.waitStable(page);
        this.resetRefs();
        return null;

      // --- observation: vision ---
      case "screenshot_png_bytes":
        return await this.capture(page);
      case "screenshot_and_metadata": {
        const b64 = await this.capture(page);
        return { screenshot_b64: b64, metadata: await this.metadata(page) };
      }
      case "webpage_metadata":
        if (!this.s.imgW || !this.s.imgH) await this.capture(page);
        return await this.metadata(page);
      case "get_screen_size":
        if (this.s.imgW && this.s.imgH) return [this.s.imgW, this.s.imgH];
        await this.capture(page);
        return [this.s.imgW, this.s.imgH];
      case "get_mouse_position":
        return [this.s.mouse.x, this.s.mouse.y];

      // --- observation: a11y / text ---
      case "observe":
      case "observe_with_tabs": {
        const snap = await this.axSnapshot(page);
        const { out, isDiff } = a.incremental === false
          ? { out: snap.text, isDiff: false }
          : this.diffSnapshot(snap.text);
        const [scrollW, scrollH, scrollX, scrollY, innerW, innerH] =
          (await page.evaluate<number[]>(META_SCRIPT)) ?? [0, 0, 0, 0, 0, 0, 1];
        const observe = {
          snapshot: out,
          is_diff: isDiff,
          meta: {
            url: snap.url,
            title: snap.title,
            viewport: [innerW, innerH],
            scroll: [scrollX, scrollY],
            page_height: scrollH,
            page_width: scrollW,
          },
          has_visual_content: false,
        };
        if (name === "observe_with_tabs") {
          const tabs = await this.tabIds();
          return { observe, tabs, active_tab: tabs[0] ?? "1" };
        }
        return observe;
      }
      case "get_a11y_snapshot":
      case "get_html":
      case "get_viewport_html": {
        const snap = await this.axSnapshot(page);
        this.s.lastAxLines = snap.text.split("\n");
        return snap.text;
      }
      case "get_element_text": {
        const loc = this.locFor(a);
        if (!loc) throw new Error("Missing target: provide a ref or selector.");
        return await loc.innerText({ timeout: 3000 });
      }
      case "reader_mode":
      case "extract_markdown":
        return await this.readerText(page);
      case "extract_table":
        return await this.extractTable(page, typeof a.selector === "string" ? a.selector : "table");
      case "get_logs":
        return this.s.consoleLogs.slice(-(Number(a.max_entries) || 20));
      case "find_in_page": {
        const q = JSON.stringify(String(a.query || ""));
        return (
          (await page.evaluate<boolean>(`window.find(${q}, false, false, true, false, true, false)`)) ?? false
        );
      }

      // --- vision actions (screenshot-pixel coords ÷ dpr) ---
      case "click_at": {
        const x = this.toCss(a.x);
        const y = this.toCss(a.y);
        await page.mouse.click(x, y);
        this.s.mouse = { x: Number(a.x), y: Number(a.y) };
        return null;
      }
      case "double_click":
        await page.mouse.click(this.toCss(this.s.mouse.x), this.toCss(this.s.mouse.y), { clickCount: 2 });
        return null;
      case "mouse_move_to":
        await page.mouse.move(this.toCss(a.x), this.toCss(a.y));
        this.s.mouse = { x: Number(a.x), y: Number(a.y) };
        return null;
      case "mouse_press":
        await page.mouse.down({ button: (a.button as string) || "left" });
        return null;
      case "mouse_release":
        await page.mouse.up({ button: (a.button as string) || "left" });
        return null;
      case "write_at": {
        await page.mouse.click(this.toCss(a.x), this.toCss(a.y));
        this.s.mouse = { x: Number(a.x), y: Number(a.y) };
        if (a.overwrite !== false) await this.selectAll(page);
        await page.keyboard.type(String(a.text || ""));
        if (a.enter) await page.keyboard.press("Enter");
        return null;
      }
      case "input_text":
        if (a.text == null) throw new Error("Missing required argument: text");
        await page.keyboard.type(String(a.text));
        return null;
      case "press_key":
        if (!a.key) throw new Error("Missing required argument: key");
        await page.keyboard.press(mapKey(String(a.key)));
        return null;
      case "release_key":
        if (!a.key) throw new Error("Missing required argument: key");
        await page.keyboard.up(mapKey(String(a.key)));
        return null;
      case "press_keys":
      case "press_and_release_keys": {
        const keys = (a.keys as string[]) || [];
        if (keys.length) await page.keyboard.press(mapChord(keys));
        return null;
      }
      case "scroll": {
        const dx = Number(a.dx) || 0;
        const dy = Number(a.dy) || 0;
        if (dx || dy) await page.mouse.wheel(dx, dy);
        return null;
      }
      case "scroll_at": {
        await page.mouse.move(this.toCss(a.x), this.toCss(a.y));
        this.s.mouse = { x: Number(a.x), y: Number(a.y) };
        const dx = Number(a.dx) || 0;
        const dy = Number(a.dy) || 0;
        if (dx || dy) await page.mouse.wheel(dx, dy);
        return null;
      }
      case "scroll_page": {
        const dx = Number(a.dx) || 0;
        const dy = Number(a.dy) || 0;
        await page.evaluate(`window.scrollBy(${dx}, ${dy})`);
        return true;
      }
      case "drag_and_drop": {
        const ox = this.toCss(a.origin_x);
        const oy = this.toCss(a.origin_y);
        const tx = this.toCss(a.target_x);
        const ty = this.toCss(a.target_y);
        const button = (a.button as string) || "left";
        await page.mouse.move(ox, oy);
        await page.mouse.down({ button });
        const steps = 10;
        for (let i = 1; i <= steps; i++) {
          await page.mouse.move(ox + ((tx - ox) * i) / steps, oy + ((ty - oy) * i) / steps);
        }
        await page.mouse.up({ button });
        this.s.mouse = { x: Number(a.target_x), y: Number(a.target_y) };
        return null;
      }

      // --- a11y / ref actions ---
      case "click_element": {
        const loc = this.locFor(a);
        if (!loc) throw new Error("Missing target: provide a ref from the latest observation, or a CSS selector.");
        await loc.click({ timeout: 4000 });
        return null;
      }
      case "type_element": {
        const loc = this.locFor(a);
        if (!loc) throw new Error("Missing target: provide a ref from the latest observation, or a CSS selector.");
        await loc.click({ timeout: 4000 });
        if (a.clear !== false) await loc.fill("");
        await loc.fill(String(a.text || ""));
        if (a.submit) await loc.press("Enter");
        return null;
      }
      case "hover_element": {
        const loc = this.locFor(a);
        if (!loc) throw new Error("Missing target: provide a ref or selector.");
        await loc.hover({ timeout: 4000 });
        return null;
      }
      case "select_element": {
        const loc = this.locFor(a);
        if (!loc) throw new Error("Missing target: provide a ref or selector.");
        const value = a.value ?? a.text;
        const picked = await loc.selectOption(
          typeof value === "string" ? { label: value } : value,
          { timeout: 4000 },
        ).catch(async () => await loc.selectOption(String(value), { timeout: 4000 }));
        return Array.isArray(picked) ? picked.join(", ") : picked;
      }
      case "fill_form": {
        const fields = (a.fields as Array<Record<string, unknown>>) || [];
        if (!fields.length) throw new Error("No fields provided.");
        let filled = 0;
        const skipped: string[] = [];
        for (const f of fields) {
          const loc = this.locFor(f);
          if (!loc) {
            skipped.push(String(f.label || f.ref || f.selector || "(no target)"));
            continue;
          }
          try {
            await loc.click({ timeout: 4000 });
            if (f.clear !== false) await loc.fill("");
            await loc.fill(String(f.text || ""));
            filled++;
            if (f.tab) await page.keyboard.press("Tab");
          } catch (e) {
            skipped.push(`${f.label || f.ref || f.selector}: ${(e as Error).message}`);
          }
        }
        return skipped.length ? { filled, total: fields.length, skipped } : { filled, total: fields.length };
      }
      case "drag_element": {
        const start = this.locFor(a, "start_ref", "start_selector");
        const end = this.locFor(a, "end_ref", "end_selector");
        if (!start || !end) throw new Error("drag_element needs start and end ref/selector.");
        await start.dragTo(end, { timeout: 5000 });
        return null;
      }
      case "screenshot_element": {
        const loc = this.locFor(a);
        if (!loc) throw new Error("Missing target: provide a ref or selector.");
        const buf = await loc.screenshot({ type: "png" });
        return buf.toString("base64");
      }
      case "set_input_files": {
        const loc = this.locFor(a);
        if (!loc) throw new Error("Missing target: provide a ref or selector.");
        const paths = (a.paths as string[]) || (a.path ? [String(a.path)] : []);
        await loc.setInputFiles(paths);
        return null;
      }

      // --- waits ---
      case "wait_for":
        return await this.waitFor(page, a);

      // --- tabs ---
      case "get_active_tab": {
        const tabs = await this.tabIds();
        return tabs[0] ?? "1";
      }
      case "get_tabs":
        return await this.tabIds();
      case "get_tab_title":
        return await page.title();
      case "new_tab":
      case "open_new_tab": {
        const ctx = await this.ctx();
        if (!ctx) throw new Error("No browser context for new_tab.");
        const np = await ctx.newPage();
        if (a.url) await np.goto(String(a.url), { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS }).catch(() => {});
        await sleep(NEW_TAB_SETTLE_MS);
        this.s.page = np;
        this.attachConsole(np);
        this.resetRefs();
        const tabs = await this.tabIds();
        return name === "open_new_tab" ? { tab_id: tabs[tabs.length - 1] ?? "1", title: await np.title().catch(() => "") } : (tabs[tabs.length - 1] ?? "1");
      }
      case "switch_tab_by_id": {
        const ctx = await this.ctx();
        if (!ctx) throw new Error("No browser context.");
        const idx = Number(a.tab_id) - 1;
        const pages = ctx.pages().filter((p) => !p.isClosed());
        const target = pages[idx];
        if (!target) throw new Error(`No tab ${a.tab_id} (have ${pages.length}).`);
        await target.bringToFront().catch(() => {});
        this.s.page = target;
        this.attachConsole(target);
        this.resetRefs();
        return null;
      }
      case "close_active_tab":
      case "close_tab": {
        const ctx = await this.ctx();
        if (!ctx) throw new Error("No browser context.");
        const pages = ctx.pages().filter((p) => !p.isClosed());
        if (pages.length <= 1) throw new Error("Cannot close the only tab. Open a new tab first.");
        const target =
          name === "close_tab" && a.tab_id != null ? pages[Number(a.tab_id) - 1] : this.s.page;
        if (!target) throw new Error("Target tab not found.");
        const closable = target as unknown as { close?: () => Promise<void> };
        await closable.close?.();
        this.s.page = pages.find((p) => p !== target && !p.isClosed()) ?? null;
        this.resetRefs();
        return null;
      }

      // --- scripting ---
      case "execute_script": {
        const script = String(a.script || "");
        const fnArgs = (a.args as unknown[]) || [];
        return await page.evaluate(
          (payload: unknown) => {
            const { script: s, args: ar } = payload as { script: string; args: unknown[] };
            // eslint-disable-next-line no-new-func
            const fn = new Function(...["__a"], `return (function(...args){ ${s} }).apply(null, __a)`);
            return fn(ar);
          },
          { script, args: fnArgs },
        );
      }

      // --- session memory (in-process; not persisted across runs) ---
      case "memory_put":
        if (typeof a.key === "string") this.memory.set(a.key, a.entry);
        return null;
      case "memory_get":
        return typeof a.key === "string" ? (this.memory.get(a.key) ?? null) : null;
      case "memory_delete":
        return typeof a.key === "string" ? this.memory.delete(a.key) : false;
      case "memory_list": {
        const prefix = typeof a.prefix === "string" ? a.prefix : "";
        const out: Record<string, unknown> = {};
        for (const [k, v] of this.memory) if (k.startsWith(prefix)) out[k] = v;
        return out;
      }

      case "destroy":
        return null;
      default:
        console.warn(`[agp-driver] unknown command: ${name}`);
        throw new Error(`Unknown command: ${name}`);
    }
  }

  // ---- helpers used by the switch -----------------------------------------
  private async selectAll(page: PwPage): Promise<void> {
    await page.evaluate(`(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return;
      if (typeof el.select === 'function' && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) el.select();
      else if (el.isContentEditable) document.execCommand('selectAll', false, null);
    })()`).catch(() => {});
  }

  private async readerText(page: PwPage): Promise<string> {
    return await page.evaluate<string>(`(() => {
      const root = document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
      return root ? (root.innerText || '').trim().slice(0, 50000) : '';
    })()`);
  }

  private async extractTable(page: PwPage, selector: string): Promise<unknown> {
    return await page.evaluate(
      (sel: unknown) => {
        const table = document.querySelector(sel as string);
        if (!table) return { error: "No table found" };
        const headers = Array.from(table.querySelectorAll("thead th, thead td, tr:first-child th")).map(
          (h) => (h as HTMLElement).innerText.trim(),
        );
        const rows: string[][] = [];
        for (const tr of Array.from(table.querySelectorAll("tbody tr, tr"))) {
          const cells = Array.from(tr.querySelectorAll("td, th")).map((c) => (c as HTMLElement).innerText.trim());
          if (cells.length && cells.some((c) => c)) rows.push(cells);
        }
        if (headers.length && rows.length && rows[0]!.every((c, i) => c === headers[i])) rows.shift();
        return { headers, rows, total_rows: rows.length };
      },
      selector,
    );
  }

  private async waitFor(page: PwPage, a: Record<string, unknown>): Promise<unknown> {
    const budget = (Number(a.time) || 10) * 1000;
    const deadline = Date.now() + budget;
    const text = a.text as string | undefined;
    const textGone = a.text_gone as string | undefined;
    const selector = a.selector as string | undefined;
    const selectorGone = a.selector_gone as string | undefined;
    if (!text && !textGone && !selector && !selectorGone) {
      await sleep(budget);
      return { waited: true, elapsed: budget };
    }
    const start = Date.now();
    for (;;) {
      if (text || textGone) {
        const body = (await page.evaluate<string>("document.body ? document.body.innerText : ''").catch(() => "")) || "";
        if (text && body.includes(text)) return { found: true, elapsed: Date.now() - start };
        if (textGone && !body.includes(textGone)) return { gone: true, elapsed: Date.now() - start };
      }
      if (selector) {
        const present = await page
          .evaluate<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`)
          .catch(() => false);
        if (present) return { found: true, elapsed: Date.now() - start };
      }
      if (selectorGone) {
        const gone = await page
          .evaluate<boolean>(`!document.querySelector(${JSON.stringify(selectorGone)})`)
          .catch(() => false);
        if (gone) return { gone: true, elapsed: Date.now() - start };
      }
      if (Date.now() >= deadline) break;
      await sleep(200);
    }
    return { timeout: true, elapsed: Date.now() - start };
  }
}
