import {
  mouse,
  keyboard,
  Button,
  Key,
  Point,
  straightTo,
  screen as nutScreen,
  Region,
} from "@nut-tree-fork/nut-js";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Mouse speed (px/sec) — slow enough that the cursor visibly travels to the
// target instead of teleporting. The reference repo (PromptEngineer48/holo3-demo
// `main.py:342`) uses pyautogui with `duration=0.3`, which is similar visual
// pacing for a typical 800px diagonal. Lower this if you want faster, raise
// for "show off" demos.
mouse.config.mouseSpeed = 600;
// Per-event pause after each click/key — keeps action execution legible and
// gives the OS time to process focus changes before the next thought.
mouse.config.autoDelayMs = 50;

// How long to hover over the target after the cursor arrives, before firing
// the click. Makes the action obviously visible and matches demo behavior
// (`time.sleep(0.2)` between moveTo and click).
const POST_MOVE_HOVER_MS = 180;

// ---------------------------------------------------------------------------
// Background-mode driver: cliclick (https://github.com/BlueM/cliclick)
//
// nut-js fundamentally moves the OS cursor before each click — there is no
// "click at (x, y) without moving the cursor" API. That means during an agent
// task the user's mouse is hijacked.
//
// cliclick is a small CLI utility that posts CGEvent clicks at coordinates
// directly via macOS's HID event tap, WITHOUT moving the visible cursor.
// `cliclick c:x,y` and `cliclick t:hello` operate in the background. If the
// user has it installed (`brew install cliclick`), we route click/type/key
// through it so the agent's actions don't fight the user's mouse. Otherwise
// we fall back to nut-js (current behavior, hijacks the cursor).
//
// Detection runs once at module init. Logged so the user can see which mode
// they're in from the boot output.
// ---------------------------------------------------------------------------
let cliclickPath: string | null = null;
try {
  const found = execFileSync("/usr/bin/which", ["cliclick"], {
    encoding: "utf-8",
  }).trim();
  if (found) cliclickPath = found;
} catch {
  cliclickPath = null;
}

export const BACKGROUND_MODE = cliclickPath !== null;

if (cliclickPath) {
  console.log(
    `[screen] cliclick detected at ${cliclickPath} — BACKGROUND MODE: ` +
      "agent clicks fire at coordinates without moving your cursor.",
  );
} else if (process.platform === "darwin") {
  console.log(
    "[screen] cliclick not found. Agent will move your cursor on each " +
      "click (foreground mode). Run `brew install cliclick` to switch to " +
      "background mode where your mouse stays put.",
  );
}

async function cliclickRun(...args: string[]): Promise<void> {
  if (!cliclickPath) throw new Error("cliclick path not resolved");
  await execFileAsync(cliclickPath, args);
}

export interface Screenshot {
  png: Buffer;
  /** Logical width of the captured display (NOT the user's whole desktop). */
  width: number;
  /** Logical height of the captured display. */
  height: number;
  /** Display-bounds X in screen-space. 0 for primary / single-display setups.
   *  On multi-monitor setups where the focused display is to the RIGHT of the
   *  primary, this is the primary's width; loop.ts adds it to grounded click
   *  coords before firing cliclick so the click lands on the right monitor. */
  offsetX: number;
  /** Display-bounds Y in screen-space. Non-zero when the focused display is
   *  ABOVE the primary in the macOS arrangement (rare). */
  offsetY: number;
}

export async function size(): Promise<{ width: number; height: number }> {
  const w = await nutScreen.width();
  const h = await nutScreen.height();
  return { width: w, height: h };
}

// ---------------------------------------------------------------------------
// macOS window-bounds query (Accessibility API via osascript)
//
// Used by `agent_click_sequence` when the caller passes `targetApp` —
// the tool crops the screenshot to that app's front window before
// grounding, defending against the "embedded-screenshot decoy" hazard
// (a chat client showing a screenshot of the target app on the same
// display as the real app — the vision model can ground against the
// picture instead of the real window). See bench/cases/calculator-
// mouse-math.md "Known gotcha" for the original incident.
//
// Reliability caveat: this uses `tell process "<name>"` from System
// Events, which requires Accessibility permissions for the spawning
// process (tsx / node). When perms are missing, osascript exits with
// `errOSAStatusError -1719` and we return null. Caller MUST treat
// null as "fall back to uncropped grounding" — never fail the
// sequence on a missing window. The decoy is a probabilistic hazard,
// not a correctness barrier; cropping is an optimization.
// ---------------------------------------------------------------------------

export interface WindowBounds {
  /** Screen-space x of the window's top-left corner. */
  x: number;
  /** Screen-space y of the window's top-left corner. */
  y: number;
  /** Window width in logical pixels. */
  width: number;
  /** Window height in logical pixels. */
  height: number;
}

/**
 * Query the bounds of the FRONT window of the given macOS process.
 *
 * `processName` is the System Events process name — usually the same
 * as the `.app` bundle name without ".app" (e.g. "Calculator", "Finder",
 * "Safari", "Google Chrome"). Case-sensitive.
 *
 * Resolution order:
 *   1. Holo3 Electron bridge at 127.0.0.1:7900/window/bounds. The
 *      bridge has macOS Accessibility perms granted by the user (it's
 *      what the user adds in System Settings → Privacy → Accessibility).
 *      Routing the query through it sidesteps the perms gap when this
 *      module runs from a tsx process (Claude Code's MCP child) that
 *      DOES NOT have those perms — without this proxy, osascript would
 *      hang for 2 minutes waiting on the user to dismiss a perms prompt
 *      that never appears for a child process.
 *   2. Local osascript fallback — for environments where the bridge
 *      isn't running (smoke tests, doctor scripts, future headless
 *      contexts). Same code as before; gated by a 2s timeout.
 *
 * Returns null on any error: process not running, no window open,
 * perms denied at every layer, non-darwin platform, malformed
 * processName. Never throws.
 */
export async function getMacWindowBounds(
  processName: string,
): Promise<WindowBounds | null> {
  if (process.platform !== "darwin") return null;
  // Defensive: a maliciously-shaped processName could escape AppleScript
  // string quoting. Reject anything with quotes/backslashes/newlines —
  // legitimate macOS process names don't have any of those.
  if (/["\\\n\r]/.test(processName)) return null;

  // 1) Bridge proxy. Cheap probe: 1.5s budget. Bridge resolves perms-
  //    granted queries in ~50ms; if the bridge is down or slow, fall
  //    through to the local path.
  const bridgePort = Number(process.env.PONDER_BRIDGE_PORT ?? 7900);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    try {
      const res = await fetch(
        `http://127.0.0.1:${bridgePort}/window/bounds`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ processName }),
          signal: ctrl.signal,
        },
      );
      if (res.ok) {
        const j = (await res.json()) as
          | { x: number; y: number; width: number; height: number }
          | { error: string; detail?: string };
        if ("error" in j) {
          // Salvage path for the OLD bridge build that has the
          // split-on-comma parser bug — when AppleScript serialized
          // the integer-list as "690, ,, 334, ,, 230, ,, 408", the
          // bridge returned `{error:"parse_failed", detail:<raw>}`
          // instead of the parsed bounds. We can recover by pulling
          // signed integers out of `detail` ourselves. Avoids
          // requiring a second Electron restart for users who
          // already restarted to pick up the route. Newer bridges
          // (with the regex parser) won't hit this branch — they
          // return the parsed bounds directly.
          if (
            j.error === "parse_failed" &&
            typeof j.detail === "string"
          ) {
            const nums = (j.detail.match(/-?\d+/g) ?? []).map(Number);
            if (
              nums.length >= 4 &&
              nums.every((n) => Number.isFinite(n)) &&
              nums[2]! > 0 &&
              nums[3]! > 0
            ) {
              return {
                x: nums[0]!,
                y: nums[1]!,
                width: nums[2]!,
                height: nums[3]!,
              };
            }
          }
          // Real error (missing, nowindow, perms denied at the
          // bridge level). No point falling back to local osascript
          // — it can only do worse, and hanging on a perms prompt
          // would block the sequence.
          return null;
        }
        if (
          typeof j.x === "number" &&
          typeof j.y === "number" &&
          j.width > 0 &&
          j.height > 0
        ) {
          return { x: j.x, y: j.y, width: j.width, height: j.height };
        }
        return null;
      }
      // Non-2xx — fall through to local. The bridge being up but
      // returning 4xx/5xx is rare and worth retrying via the local
      // path before giving up entirely.
    } finally {
      clearTimeout(t);
    }
  } catch {
    // Bridge unreachable (not running, port closed, ECONNREFUSED).
    // Try the local osascript path so non-bridge contexts still work.
  }

  // 2) Local osascript fallback. Same script the bridge runs; works
  //    only when the spawning process itself has Accessibility perms
  //    (rare for tsx/Node spawned by Claude Code, common for tests
  //    run from a terminal that DOES have perms granted).
  const script = `tell application "System Events"
  if not (exists process "${processName}") then return "missing"
  tell process "${processName}"
    if (count of windows) is 0 then return "nowindow"
    set p to position of front window
    set s to size of front window
    return (item 1 of p as integer) & "," & (item 2 of p as integer) & "," & (item 1 of s as integer) & "," & (item 2 of s as integer)
  end tell
end tell`;

  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/osascript",
      ["-e", script],
      { timeout: 2000 },
    );
    const out = stdout.trim();
    if (out === "missing" || out === "nowindow") return null;
    // AppleScript's `&` on integers builds a list ({n, ",", n, ...}) which
    // renders as "690, ,, 334, ,, 230, ,, 408" — split-on-comma fails. Pull
    // signed integers directly via regex; first 4 in order are x,y,w,h.
    const nums = (out.match(/-?\d+/g) ?? []).map(Number);
    if (nums.length < 4 || nums.some((n) => !Number.isFinite(n))) {
      return null;
    }
    const [x, y, w, h] = nums as [number, number, number, number];
    if (w <= 0 || h <= 0) return null;
    return { x, y, width: w, height: h };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Multi-monitor support.
//
// nut-js is HARD-CODED to the primary display: `screen.width()` returns the
// primary's width and `screen.grabRegion(0,0,w,h)` only sees the primary's
// pixel buffer. On a multi-monitor Mac with Chrome on a secondary display,
// the agent screenshots a black/empty primary and emits clicks at the wrong
// monitor — the trace looks like the agent is "blind".
//
// Fix: Electron's `desktopCapturer` IS multi-monitor-aware (each Display gets
// its own source). We use Electron's `screen` module to find which display
// the cursor is on (the "focused" display from the user's POV), then ask
// desktopCapturer for that display's thumbnail at logical resolution.
//
// Trade-off: desktopCapturer is ~200ms vs nut-js ~50ms. So we still use
// nut-js when we're confidently on the primary display (the cursor is at
// (offsetX=0, offsetY=0)) and only pay the slower path when actually needed.
// On a single-display setup this means zero overhead.
//
// Lazy require: `electron` is unavailable in non-Electron contexts (tests,
// future CLI-only entrypoints). If require throws, the focused-display path
// silently degrades to the nut-js primary-only behavior.
// ---------------------------------------------------------------------------

interface ElectronDisplay {
  id: number;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
}
interface ElectronModule {
  screen?: {
    getCursorScreenPoint(): { x: number; y: number };
    getDisplayNearestPoint(pt: { x: number; y: number }): ElectronDisplay;
  };
  desktopCapturer?: {
    getSources(opts: {
      types: string[];
      thumbnailSize?: { width: number; height: number };
    }): Promise<
      Array<{
        display_id: string;
        thumbnail: { toPNG: () => Buffer };
      }>
    >;
  };
}

let cachedElectron: ElectronModule | null | undefined;
function getElectron(): ElectronModule | null {
  if (cachedElectron !== undefined) return cachedElectron;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cachedElectron = require("electron") as ElectronModule;
  } catch {
    cachedElectron = null;
  }
  return cachedElectron;
}

function getFocusedDisplay(): ElectronDisplay | null {
  const e = getElectron();
  if (!e?.screen) return null;
  try {
    const pt = e.screen.getCursorScreenPoint();
    return e.screen.getDisplayNearestPoint(pt);
  } catch {
    return null;
  }
}

async function captureViaDesktopCapturer(
  d: ElectronDisplay,
): Promise<Screenshot | null> {
  const e = getElectron();
  if (!e?.desktopCapturer) return null;
  try {
    const sources = await e.desktopCapturer.getSources({
      types: ["screen"],
      // Logical pixels — desktopCapturer scales the native-resolution
      // capture down to this size. Avoids us having to deal with Retina
      // scaleFactor in the click-coord math (cliclick uses logical pixels
      // matching what we display to the LLM).
      thumbnailSize: { width: d.bounds.width, height: d.bounds.height },
    });
    const matching = sources.find(
      (s) => Number(s.display_id) === d.id,
    );
    if (!matching) return null;
    return {
      png: matching.thumbnail.toPNG(),
      width: d.bounds.width,
      height: d.bounds.height,
      offsetX: d.bounds.x,
      offsetY: d.bounds.y,
    };
  } catch (e) {
    console.warn(
      `[screen] desktopCapturer failed (${e instanceof Error ? e.message : String(e)}) — falling back to nut-js primary`,
    );
    return null;
  }
}

export async function screenshot(): Promise<Screenshot> {
  // Multi-monitor path: figure out which display the cursor is on. On a
  // single-display Mac, `display.bounds.x` and `.y` are both 0, so we
  // skip to the fast nut-js path below. On multi-monitor with the cursor
  // on a secondary display, we go through desktopCapturer.
  const focused = getFocusedDisplay();
  if (focused && (focused.bounds.x !== 0 || focused.bounds.y !== 0)) {
    const shot = await captureViaDesktopCapturer(focused);
    if (shot) {
      return shot;
    }
    // captureViaDesktopCapturer logged the reason; fall through to nut-js
    // which will at least give us SOMETHING (the primary display) instead
    // of crashing the whole step.
  }

  // Fast path: primary display via nut-js. No multi-monitor offset.
  const { width, height } = await size();
  const region = new Region(0, 0, width, height);
  const img = await nutScreen.grabRegion(region);
  // nut-js returns its own image; encode to PNG via toRGB + sharp-less path:
  // The library exposes `image.toRGB()` raw bytes. We rely on its toRGB() helper
  // through the screen.captureRegion signature when available, else fallback.
  const png = await imageToPng(img);
  return { png, width, height, offsetX: 0, offsetY: 0 };
}

async function imageToPng(img: unknown): Promise<Buffer> {
  // nut-js's `Image.toRGB()` returns `Promise<Image>`, NOT a buffer — the
  // bytes live on the returned image's `.data`. Older code assumed it
  // resolved to bytes directly, which produced "Received an instance of Image".
  // See node_modules/@nut-tree-fork/shared/dist/lib/objects/image.class.d.ts.
  type NutImage = {
    width: number;
    height: number;
    data: Buffer;
    channels: number;
    bitsPerPixel?: number;
    toRGB?: () => Promise<NutImage>;
    toBGR?: () => Promise<NutImage>;
    hasAlphaChannel?: boolean;
  };
  const src = img as NutImage;

  // Convert to RGB color mode if the helper exists — this gives us pixels
  // already in the order PNG wants. Fall back to manual BGR→RGB swap if
  // toRGB() isn't available (very old nut-js).
  let rgbImg: NutImage;
  try {
    rgbImg = src.toRGB ? await src.toRGB() : src;
  } catch {
    rgbImg = src;
  }

  const buf = Buffer.isBuffer(rgbImg.data)
    ? rgbImg.data
    : Buffer.from(rgbImg.data as unknown as ArrayBufferLike);

  // PNG color type 2 = RGB (3 channels). Strip alpha if present.
  // If we ended up with BGR (toRGB unavailable), swap channels too.
  const usedToRGB = src.toRGB != null && rgbImg !== src;
  const rgb = usedToRGB
    ? ensureRgb24(buf, rgbImg.width, rgbImg.height, rgbImg.channels)
    : bgrToRgb(buf, rgbImg.width, rgbImg.height, rgbImg.channels);

  return encodePng(rgbImg.width, rgbImg.height, rgb);
}

/** Strip alpha if present and return a 3-byte-per-pixel RGB buffer. */
function ensureRgb24(buf: Buffer, w: number, h: number, channels?: number): Buffer {
  const stride = channels ?? (buf.length === w * h * 4 ? 4 : 3);
  if (stride === 3 && buf.length === w * h * 3) return buf;
  const out = Buffer.alloc(w * h * 3);
  for (let i = 0, o = 0; i < buf.length && o < out.length; i += stride, o += 3) {
    out[o] = buf[i];
    out[o + 1] = buf[i + 1];
    out[o + 2] = buf[i + 2];
  }
  return out;
}

/** Convert BGR(A) → RGB(24). */
function bgrToRgb(buf: Buffer, w: number, h: number, channels?: number): Buffer {
  const stride = channels ?? (buf.length === w * h * 4 ? 4 : 3);
  const out = Buffer.alloc(w * h * 3);
  for (let i = 0, o = 0; i < buf.length && o < out.length; i += stride, o += 3) {
    out[o] = buf[i + 2]; // R = src B
    out[o + 1] = buf[i + 1]; // G = src G
    out[o + 2] = buf[i]; // B = src R
  }
  return out;
}

// Minimal PNG encoder (RGB → PNG) using node:zlib — keeps deps small.
import { deflateSync } from "node:zlib";
function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Filter byte 0 prepended to each row.
  const stride = width * 3;
  const filtered = Buffer.alloc((stride + 1) * height);
  // Use TypedArray.set() instead of Buffer.copy() — works with both Buffer
  // and Uint8Array sources (which is what newer @nut-tree-fork returns).
  for (let y = 0; y < height; y++) {
    filtered[y * (stride + 1)] = 0;
    filtered.set(rgb.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }
  const idatData = deflateSync(filtered);

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idatData),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const c = crc32(Buffer.concat([typeBuf, data]));
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(c, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export async function click(
  x: number,
  y: number,
  opts: { button?: "left" | "right"; double?: boolean; triple?: boolean } = {},
): Promise<void> {
  const ix = Math.round(x);
  const iy = Math.round(y);

  if (cliclickPath) {
    // Background mode: post the click via cliclick. The user's cursor stays
    // exactly where it was — only our buddy's blue agent-cursor visualizes
    // the click. cmd codes:
    //   c:x,y  → left click (no cursor move)
    //   dc:x,y → double click
    //   rc:x,y → right click
    if (opts.triple) {
      // No `tc:` shortcut in cliclick — chain three c: commands. macOS
      // aggregates consecutive same-pixel clicks within ~500ms into a real
      // multi-click event, so this lands as a triple-click (selects all in a
      // single-line field, the paragraph in a multi-line text area). Paired
      // with a follow-up `type X`, the type replaces the field's contents.
      await cliclickRun(`c:${ix},${iy}`, `c:${ix},${iy}`, `c:${ix},${iy}`);
      return;
    }
    const cmd =
      opts.button === "right" ? "rc" : opts.double ? "dc" : "c";
    await cliclickRun(`${cmd}:${ix},${iy}`);
    return;
  }

  // Foreground fallback: animate the OS cursor (your real mouse) to the
  // target, hover briefly so the click is obviously visible, then fire.
  await mouse.move(straightTo(new Point(ix, iy)));
  await sleep(POST_MOVE_HOVER_MS);
  if (opts.triple) {
    // nut-js has no triple-click API; three quick leftClicks at the same
    // point produce the same OS-level multi-click event. 40ms gap is well
    // under macOS's ~500ms multi-click threshold.
    await mouse.leftClick();
    await sleep(40);
    await mouse.leftClick();
    await sleep(40);
    await mouse.leftClick();
    return;
  }
  const btn = opts.button === "right" ? Button.RIGHT : Button.LEFT;
  if (opts.double) await mouse.doubleClick(btn);
  else await mouse.leftClick();
}

/**
 * Press-and-hold left button at (srcX, srcY), drag to (dstX, dstY), release.
 *
 * IMPORTANT: drag is the ONE action that always moves the visible cursor —
 * even in cliclick "background" mode. Drag-down/drag-move/drag-up CGEvents
 * are inherently position-based at the OS layer; there's no way to post them
 * at coordinates while leaving the cursor parked elsewhere. The user's mouse
 * gets hijacked for the duration (~ 200-400ms), then control returns.
 *
 * Both backends do straight-line drags (two-point path). For curved drags
 * we'd extend the path argument; nothing in the agent vocabulary asks for it.
 */
export async function drag(
  srcX: number,
  srcY: number,
  dstX: number,
  dstY: number,
): Promise<void> {
  const sx = Math.round(srcX);
  const sy = Math.round(srcY);
  const dx = Math.round(dstX);
  const dy = Math.round(dstY);

  if (cliclickPath) {
    // cliclick chain: dd:x,y (drag-down = mouseDown w/ drag flag) →
    // m:x,y (move with button held) → du:x,y (drag-up = mouseUp).
    // Ordering matters: drag events expect mouseDown first, then moves,
    // then mouseUp at the release point. cliclick supports multiple
    // commands in a single invocation so this is one process spawn.
    await cliclickRun(`dd:${sx},${sy}`, `m:${dx},${dy}`, `du:${dx},${dy}`);
    return;
  }

  // nut-js: drag(path) presses LEFT at path[0], moves through subsequent
  // points (animated at mouse.config.mouseSpeed), releases at the last.
  await mouse.drag([new Point(sx, sy), new Point(dx, dy)]);
}

export async function move(x: number, y: number): Promise<void> {
  if (cliclickPath) {
    // cliclick `m:x,y` does move the visible cursor; we deliberately don't
    // expose that — bare moves are rare and useless for agent flows. If you
    // need a debug "show me the position" cursor, use the buddy ghost.
    return;
  }
  await mouse.move(straightTo(new Point(Math.round(x), Math.round(y))));
}

/** Sleep helper used by the agent loop's `wait` action. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function typeText(text: string): Promise<void> {
  // nut-js keyboard.type doesn't move the cursor — it only synthesizes
  // key events at the focused field. Background mode for free.
  await keyboard.type(text);
}

export async function pressCombo(combo: string): Promise<void> {
  // "ctrl+shift+t", "cmd+space", "enter"
  const parts = combo
    .toLowerCase()
    .split(/\s*\+\s*/)
    .map(mapKey)
    .filter((k): k is Key => k !== null);
  if (parts.length === 0) return;
  if (parts.length === 1) {
    await keyboard.type(parts[0]);
    return;
  }
  await keyboard.pressKey(...parts);
  await keyboard.releaseKey(...parts);
}

export async function scroll(
  amount: number,
  opts: { recenter?: boolean } = {},
): Promise<void> {
  // amount: positive scrolls up, negative down
  if (amount === 0) return;

  // nut-js's scroll wheel posts events at the OS cursor's current position.
  // After a click, the cursor is parked over whatever was clicked — often a
  // sidebar item. Subsequent scrolls then scroll the SIDEBAR instead of the
  // main content area, and the planner sees no change in the rest of the
  // screen and either repeats or returns DONE without progress. (This is the
  // FB Marketplace failure: click "Selling" at (168, 570) → cursor parked
  // over left sidebar → "scroll down" scrolls the sidebar, not the listings.)
  //
  // Default to moving the cursor to the right two-thirds of the screen
  // (vertically centered) before scrolling so the wheel hits the main
  // content area. Caller can opt out with { recenter: false } if they
  // really want to scroll under the current cursor.
  if (opts.recenter !== false) {
    try {
      const { width, height } = await size();
      const tx = Math.round(width * 0.66);
      const ty = Math.round(height * 0.5);
      if (cliclickPath) {
        // cliclick `m:x,y` moves the visible cursor too — but for scrolls
        // that's the desired behavior (we have to put the wheel SOMEWHERE,
        // and "right side of the main content" is the safe default).
        await cliclickRun(`m:${tx},${ty}`);
      } else {
        await mouse.move(straightTo(new Point(tx, ty)));
      }
    } catch (e) {
      // Recenter is best-effort. If it fails (e.g. no display attached, weird
      // multi-monitor setup) just scroll wherever the cursor is — same
      // behavior as before this fix.
      console.warn(
        `[screen] scroll recenter failed (${e instanceof Error ? e.message : String(e)}) — scrolling at current cursor`,
      );
    }
  }

  if (amount > 0) await mouse.scrollUp(amount);
  else await mouse.scrollDown(-amount);
}

function mapKey(name: string): Key | null {
  const n = name.trim();
  const direct: Record<string, Key> = {
    cmd: Key.LeftSuper,
    command: Key.LeftSuper,
    win: Key.LeftSuper,
    super: Key.LeftSuper,
    ctrl: Key.LeftControl,
    control: Key.LeftControl,
    alt: Key.LeftAlt,
    option: Key.LeftAlt,
    shift: Key.LeftShift,
    enter: Key.Enter,
    return: Key.Return,
    tab: Key.Tab,
    space: Key.Space,
    esc: Key.Escape,
    escape: Key.Escape,
    backspace: Key.Backspace,
    delete: Key.Delete,
    up: Key.Up,
    down: Key.Down,
    left: Key.Left,
    right: Key.Right,
    home: Key.Home,
    end: Key.End,
  };
  if (direct[n]) return direct[n];
  if (n.length === 1) {
    const upper = n.toUpperCase();
    const k = (Key as unknown as Record<string, Key | undefined>)[upper];
    if (k != null) return k;
  }
  return null;
}
