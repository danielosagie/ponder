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
import { deflateSync } from "node:zlib";
import type { ClickOpts, Screenshot, ScreenAdapter } from "./types";

const execFileAsync = promisify(execFile);

mouse.config.mouseSpeed = 600;
mouse.config.autoDelayMs = 50;

const POST_MOVE_HOVER_MS = 180;

// ---------------------------------------------------------------------------
// Background-mode driver: cliclick (https://github.com/BlueM/cliclick)
//
// nut-js fundamentally moves the OS cursor before each click — there is no
// "click at (x, y) without moving the cursor" API. cliclick posts CGEvent
// clicks via macOS's HID event tap WITHOUT moving the visible cursor. If
// installed (`brew install cliclick`), we route click/type/key through it.
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

async function size(): Promise<{ width: number; height: number }> {
  const w = await nutScreen.width();
  const h = await nutScreen.height();
  return { width: w, height: h };
}

async function screenshot(): Promise<Screenshot> {
  const { width, height } = await size();
  const region = new Region(0, 0, width, height);
  const img = await nutScreen.grabRegion(region);
  const png = await imageToPng(img);
  return { png, width, height };
}

async function imageToPng(img: unknown): Promise<Buffer> {
  // nut-js's `Image.toRGB()` returns `Promise<Image>`, NOT a buffer — the
  // bytes live on the returned image's `.data`.
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

  let rgbImg: NutImage;
  try {
    rgbImg = src.toRGB ? await src.toRGB() : src;
  } catch {
    rgbImg = src;
  }

  const buf = Buffer.isBuffer(rgbImg.data)
    ? rgbImg.data
    : Buffer.from(rgbImg.data as unknown as ArrayBufferLike);

  const usedToRGB = src.toRGB != null && rgbImg !== src;
  const rgb = usedToRGB
    ? ensureRgb24(buf, rgbImg.width, rgbImg.height, rgbImg.channels)
    : bgrToRgb(buf, rgbImg.width, rgbImg.height, rgbImg.channels);

  return encodePng(rgbImg.width, rgbImg.height, rgb);
}

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

function bgrToRgb(buf: Buffer, w: number, h: number, channels?: number): Buffer {
  const stride = channels ?? (buf.length === w * h * 4 ? 4 : 3);
  const out = Buffer.alloc(w * h * 3);
  for (let i = 0, o = 0; i < buf.length && o < out.length; i += stride, o += 3) {
    out[o] = buf[i + 2];
    out[o + 1] = buf[i + 1];
    out[o + 2] = buf[i];
  }
  return out;
}

function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 3;
  const filtered = Buffer.alloc((stride + 1) * height);
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

async function click(x: number, y: number, opts: ClickOpts = {}): Promise<void> {
  const ix = Math.round(x);
  const iy = Math.round(y);

  if (cliclickPath) {
    if (opts.triple) {
      await cliclickRun(`c:${ix},${iy}`, `c:${ix},${iy}`, `c:${ix},${iy}`);
      return;
    }
    const cmd = opts.button === "right" ? "rc" : opts.double ? "dc" : "c";
    await cliclickRun(`${cmd}:${ix},${iy}`);
    return;
  }

  await mouse.move(straightTo(new Point(ix, iy)));
  await sleep(POST_MOVE_HOVER_MS);
  if (opts.triple) {
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

async function drag(
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
    await cliclickRun(`dd:${sx},${sy}`, `m:${dx},${dy}`, `du:${dx},${dy}`);
    return;
  }
  await mouse.drag([new Point(sx, sy), new Point(dx, dy)]);
}

async function move(x: number, y: number): Promise<void> {
  if (cliclickPath) return;
  await mouse.move(straightTo(new Point(Math.round(x), Math.round(y))));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function typeText(text: string): Promise<void> {
  await keyboard.type(text);
}

async function pressCombo(combo: string): Promise<void> {
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

async function scroll(amount: number): Promise<void> {
  if (amount === 0) return;

  // Recenter cursor before scrolling so the wheel hits the main content area
  // (avoids "scroll the sidebar instead of the listings" on common layouts).
  try {
    const { width, height } = await size();
    const tx = Math.round(width * 0.66);
    const ty = Math.round(height * 0.5);
    if (cliclickPath) {
      await cliclickRun(`m:${tx},${ty}`);
    } else {
      await mouse.move(straightTo(new Point(tx, ty)));
    }
  } catch (e) {
    console.warn(
      `[screen] scroll recenter failed (${e instanceof Error ? e.message : String(e)}) — scrolling at current cursor`,
    );
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

export function createNutScreenAdapter(): ScreenAdapter {
  return {
    screenshot,
    size,
    click,
    drag,
    move,
    typeText,
    pressCombo,
    scroll,
    sleep,
    backgroundMode: BACKGROUND_MODE,
  };
}
