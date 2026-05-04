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
  width: number;
  height: number;
}

export async function size(): Promise<{ width: number; height: number }> {
  const w = await nutScreen.width();
  const h = await nutScreen.height();
  return { width: w, height: h };
}

export async function screenshot(): Promise<Screenshot> {
  const { width, height } = await size();
  const region = new Region(0, 0, width, height);
  const img = await nutScreen.grabRegion(region);
  // nut-js returns its own image; encode to PNG via toRGB + sharp-less path:
  // The library exposes `image.toRGB()` raw bytes. We rely on its toRGB() helper
  // through the screen.captureRegion signature when available, else fallback.
  const png = await imageToPng(img);
  return { png, width, height };
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

export async function scroll(amount: number): Promise<void> {
  // amount: positive scrolls up, negative down
  if (amount === 0) return;
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
