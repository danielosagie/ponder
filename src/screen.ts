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

// Use console.error so the line stays out of stdout — important for
// CLI consumers piping output (e.g. `ponder show <id> --json | jq`).
// It's purely informational; never load-bearing.
if (cliclickPath) {
  console.error(
    `[screen] cliclick detected at ${cliclickPath} — BACKGROUND MODE: ` +
      "agent clicks fire at coordinates without moving your cursor.",
  );
} else if (process.platform === "darwin") {
  console.error(
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
  /** Logical width of the captured display (NOT the user's whole desktop).
   *  This is the coordinate system click coords use, NOT the PNG byte
   *  dimensions — on Retina the PNG is `width * scaleFactor` pixels wide. */
  width: number;
  /** Logical height of the captured display. PNG is `height * scaleFactor`
   *  pixels tall on Retina. */
  height: number;
  /** Capture-region X origin in screen-space LOGICAL coords. 0 for a
   *  full-frame capture of the primary display; the display origin on
   *  multi-monitor captures; the WINDOW origin (any value, including
   *  negative) for captureWindowDirect / cropped shots. loop.ts adds it
   *  to grounded click coords before firing cliclick so the click lands
   *  at the right screen position. */
  offsetX: number;
  /** Capture-region Y origin in screen-space logical coords — see
   *  offsetX. */
  offsetY: number;
  /**
   * Ratio of PNG physical pixels to logical pixels — derived from the
   * PNG's IHDR dims on EVERY capture path (2026-06-10). 2 on Retina, 1
   * on non-HiDPI displays. Historical trap: nut-js was long documented
   * as "always returns logical" and this field was hardcoded 1 on that
   * path; measured reality is nut-js returns NATIVE pixels, and the
   * mislabel made maybeCropToTargetApp slice the wrong region (the
   * misclick complex fixed 2026-06-10). Do not assume any path is
   * logical-resolution — trust this field, it is measured.
   *
   * Crop-callers MUST multiply logical bounds by this scale factor when
   * slicing the PNG, otherwise they get the top-left ¼ of the intended
   * region (the 2026-05-13 regression).
   *
   * Vision-grounding callers don't have to worry about this — they pass
   * `screen: [width, height]` (logical) to provider.ground; the model
   * answers on a 0-1000 grid which is rescaled to logical coords.
   */
  scaleFactor: number;
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
 * Bring a macOS process to the front (Z-order top) so subsequent
 * screenshots actually capture its pixels rather than whatever was
 * occluding it. Used by the loop's targetApp crop path — without
 * this, cropping at `targetApp`'s bounds captures whatever app is
 * RENDERED at those coords (Ponder's own UI, Cursor IDE, etc.) when
 * the target is buried. Verified May-11 failure mode.
 *
 * Routes through the Holo3 bridge's /window/raise endpoint when
 * available (the bridge has macOS Accessibility granted by the user;
 * a tsx child process spawned by Claude Code does NOT). Returns
 * `true` on success, `false` on any error or non-darwin. Never throws.
 *
 * Fast (~30ms when bridge is healthy + perms granted). Worth calling
 * before each maybeCropToTargetApp run.
 */
/**
 * Get the URL + title of the front tab of a macOS browser. Routes
 * through the Holo3 bridge's /browser/url endpoint (which has the
 * Accessibility / Automation grant). Returns null on any failure —
 * caller treats null as "no browser state available" and the loop
 * proceeds without URL context.
 *
 * Supports "Google Chrome" and "Safari" (Firefox lacks reliable
 * AppleScript URL access). Browsers not in that list return null.
 *
 * Used by the loop's per-step think() and verify() calls so the
 * brain sees what page it's actually on — closes the May-11 false-
 * positive DONE class where the verifier rubber-stamped a wrong-
 * page state because it couldn't see the URL.
 */
export async function getBrowserUrl(
  processName: string,
): Promise<{ url: string; title: string } | null> {
  if (process.platform !== "darwin") return null;
  if (/["\\\n\r]/.test(processName)) return null;
  const bridgePort = Number(process.env.PONDER_BRIDGE_PORT ?? 7900);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    try {
      const res = await fetch(
        `http://127.0.0.1:${bridgePort}/browser/url`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ processName }),
          signal: ctrl.signal,
        },
      );
      if (res.ok) {
        const j = (await res.json()) as
          | { url: string; title: string; fallback?: string }
          | { error: string };
        if ("error" in j) return null;
        // Accept BOTH the full-URL response (Automation perm granted)
        // AND the title-only fallback (only Accessibility perm). The
        // verifier and brain prompts use whatever fields are present.
        const hasUrl = typeof j.url === "string" && j.url.length > 0;
        const hasTitle = typeof j.title === "string" && j.title.length > 0;
        if (hasUrl || hasTitle) {
          return { url: j.url ?? "", title: j.title ?? "" };
        }
      }
    } finally {
      clearTimeout(t);
    }
  } catch {
    // Bridge unreachable
  }
  return null;
}

export async function raiseMacApp(processName: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  if (/["\\\n\r]/.test(processName)) return false;
  const bridgePort = Number(process.env.PONDER_BRIDGE_PORT ?? 7900);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    try {
      const res = await fetch(
        `http://127.0.0.1:${bridgePort}/window/raise`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ processName }),
          signal: ctrl.signal,
        },
      );
      if (res.ok) {
        const j = (await res.json()) as { ok?: boolean; error?: string };
        return j.ok === true;
      }
    } finally {
      clearTimeout(t);
    }
  } catch {
    // Bridge unreachable — fall through to local osascript.
  }
  // Local fallback. Only works when the spawning process itself has
  // Accessibility granted (rare for tsx-from-Claude-Code, common for
  // a terminal-launched tool that the user granted perms to).
  try {
    await execFileAsync(
      "/usr/bin/osascript",
      ["-e", `tell application "${processName}" to activate`],
      { timeout: 1500 },
    );
    return true;
  } catch {
    return false;
  }
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

/**
 * Find the display whose bounds contain (or best match) the given
 * screen-space rectangle. Used by the loop's targetApp crop path:
 * when the target app's window is on a DIFFERENT display than the
 * cursor (so `screen.screenshot()` captured the wrong frame), we
 * call this to find the right display and re-capture there via
 * `captureViaDesktopCapturer`.
 *
 * Returns null in non-Electron contexts or when the Electron screen
 * API is unavailable.
 */
export function findDisplayForRect(rect: {
  x: number;
  y: number;
  width: number;
  height: number;
}): ElectronDisplay | null {
  const e = getElectron();
  if (!e?.screen) return null;
  try {
    type ScreenWithMatching = {
      getDisplayMatching?: (rect: {
        x: number;
        y: number;
        width: number;
        height: number;
      }) => ElectronDisplay;
    };
    const screen = e.screen as typeof e.screen & ScreenWithMatching;
    const match = screen.getDisplayMatching?.(rect);
    return match ?? null;
  } catch {
    return null;
  }
}

/**
 * Best-effort: the display containing the frontmost app's main
 * window. On macOS we ask System Events via osascript (the bridge
 * process has Accessibility granted; other processes return null).
 *
 * Why this exists: `getFocusedDisplay` historically returned the
 * cursor's display, which is the WRONG one when the user's cursor
 * is on Display A (desktop wallpaper) while their active app is
 * maximized on Display B (or on a different Space of Display A
 * where the visible content is the wallpaper). Vision-grounded
 * tools then got a screenshot of the wallpaper instead of the app,
 * grounded against random pixels, and clicked nothing useful.
 *
 * Cached per-second so we don't spawn an osascript per screenshot
 * — that would add ~50-150ms to every vision call. macOS frontmost
 * doesn't change faster than a human can switch apps.
 *
 * Returns null on non-darwin, on perm denial, or any error. Caller
 * falls back to the cursor's display.
 */
let _frontWinCache: { display: ElectronDisplay | null; at: number } | null = null;
const FRONT_WIN_TTL_MS = 1000;
function getFrontmostWindowDisplay(): ElectronDisplay | null {
  if (process.platform !== "darwin") return null;
  const e = getElectron();
  if (!e?.screen) return null;
  if (_frontWinCache && Date.now() - _frontWinCache.at < FRONT_WIN_TTL_MS) {
    return _frontWinCache.display;
  }
  try {
    // execFileSync is synchronous; we cap it at 200ms so a perm-denied
    // hang doesn't stall the screenshot path.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const script =
      `tell application "System Events"\n` +
      `  set frontApp to name of first application process whose frontmost is true\n` +
      `  tell process frontApp\n` +
      `    if (count of windows) is 0 then return "0,0,0,0"\n` +
      `    set p to position of front window\n` +
      `    set s to size of front window\n` +
      `    return (item 1 of p as integer) & "," & (item 2 of p as integer) & "," & (item 1 of s as integer) & "," & (item 2 of s as integer)\n` +
      `  end tell\n` +
      `end tell`;
    const out = execFileSync("/usr/bin/osascript", ["-e", script], {
      timeout: 200,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // AppleScript's & on integers produces a LIST with comma-strings.
    // Pull signed integers out via regex (same pattern as /window/bounds
    // in electron/main.ts).
    const nums = (out.match(/-?\d+/g) ?? []).map(Number);
    if (nums.length < 4 || nums.some((n) => !Number.isFinite(n))) {
      _frontWinCache = { display: null, at: Date.now() };
      return null;
    }
    const [x, y, width, height] = nums as [number, number, number, number];
    if (width <= 0 || height <= 0) {
      _frontWinCache = { display: null, at: Date.now() };
      return null;
    }
    const display = findDisplayForRect({ x, y, width, height });
    _frontWinCache = { display, at: Date.now() };
    return display;
  } catch {
    _frontWinCache = { display: null, at: Date.now() };
    return null;
  }
}

function getFocusedDisplay(): ElectronDisplay | null {
  const e = getElectron();
  if (!e?.screen) return null;
  // Prefer the frontmost window's display (macOS Accessibility-gated).
  // Falls back to the cursor's display on non-darwin or perm failure.
  const front = getFrontmostWindowDisplay();
  if (front) return front;
  try {
    const pt = e.screen.getCursorScreenPoint();
    return e.screen.getDisplayNearestPoint(pt);
  } catch {
    return null;
  }
}

export async function captureViaDesktopCapturer(
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
    // Retina/HiDPI handling (2026-05-13): Electron's NativeImage on
    // macOS encodes `.toPNG()` at the NATIVE pixel resolution (e.g.
    // 3024×1964 for a 1512×982 logical display) regardless of the
    // `thumbnailSize` hint or any `.resize({...})` call — internally
    // it serializes the highest-resolution NSImage representation.
    //
    // Rather than fight the API (lossy CPU resize via sips), we
    // surface the actual ratio as `scaleFactor` on the returned
    // Screenshot. Every consumer that touches the PNG bytes (crop in
    // maybeCropToTargetApp) multiplies logical coords by scaleFactor
    // before slicing. Consumers that only do logical-coord math
    // (click translation, provider.ground screen=[logical]) ignore
    // scaleFactor entirely.
    //
    // Detect the actual PNG size by reading the IHDR chunk: 8-byte
    // signature + 4-byte chunk length + 4-byte 'IHDR' + 4-byte width
    // (big-endian) at offset 16, then height at offset 20.
    const png = matching.thumbnail.toPNG();
    const pngWidth = png.readUInt32BE(16);
    const pngHeight = png.readUInt32BE(20);
    const scaleX = pngWidth / d.bounds.width;
    const scaleY = pngHeight / d.bounds.height;
    // On macOS scale factors are uniform (1, 2, or 3). If x and y
    // disagree we still proceed with the average; never crashes.
    const scaleFactor = (scaleX + scaleY) / 2;
    return {
      png,
      width: d.bounds.width,
      height: d.bounds.height,
      offsetX: d.bounds.x,
      offsetY: d.bounds.y,
      scaleFactor,
    };
  } catch (e) {
    console.warn(
      `[screen] desktopCapturer failed (${e instanceof Error ? e.message : String(e)}) — falling back to nut-js primary`,
    );
    return null;
  }
}

// Logical size of the MAIN display, with a 10s cache. Sourced from the
// out-of-process winlist helper first (CGDisplayBounds, no libnut), then
// nut-js size(), then a 2x-Retina assumption against the PNG dims. Used
// by the screencapture-first capture path below.
let _mainDisplayLogical: { w: number; h: number; at: number } | null = null;
async function mainDisplayLogicalSize(
  pngW: number,
  pngH: number,
): Promise<{ w: number; h: number }> {
  if (_mainDisplayLogical && Date.now() - _mainDisplayLogical.at < 10_000) {
    return { w: _mainDisplayLogical.w, h: _mainDisplayLogical.h };
  }
  try {
    const snap = await winlistSnapshot();
    const main = snap?.displays.find((d) => d.x === 0 && d.y === 0);
    if (main && main.width > 0 && main.height > 0) {
      _mainDisplayLogical = { w: main.width, h: main.height, at: Date.now() };
      return { w: main.width, h: main.height };
    }
  } catch {
    /* fall through */
  }
  try {
    const { width, height } = await size();
    _mainDisplayLogical = { w: width, h: height, at: Date.now() };
    return { w: width, h: height };
  } catch {
    // Last resort: assume 2x Retina (every supported Mac since 2016).
    return { w: Math.round(pngW / 2), h: Math.round(pngH / 2) };
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
    // captureViaDesktopCapturer logged the reason; fall through to the
    // primary-display paths below.
  }

  // ── screencapture-first (2026-06-10) ──────────────────────────────
  // libnut's _captureScreen SIGBUS-crashed the Electron app twice today
  // (memmove overrun in copyMMBitmapFromDisplayInRect — crash reports
  // Electron-2026-06-10-{143712,145058}.ips). A native fault inside the
  // process is uncatchable and killed the whole agent mid-run with no
  // stack trace. /usr/sbin/screencapture runs OUT of process — the
  // worst case is a failed exec we catch and fall back from, never a
  // crash. Output is native-Retina PNG; scaleFactor measured from IHDR
  // like every other capture path. ~150-250ms, comparable to libnut.
  if (process.platform === "darwin") {
    try {
      const os = await import("node:os");
      const path = await import("node:path");
      const fsp = await import("node:fs/promises");
      const tmp = path.join(
        os.tmpdir(),
        `ponder-frame-${process.pid}-${Date.now()}.png`,
      );
      try {
        await execFileAsync("/usr/sbin/screencapture", ["-x", tmp], {
          timeout: 10_000,
        });
        const png = await fsp.readFile(tmp);
        if (png.length >= 24 && png.readUInt32BE(0) === 0x89504e47) {
          const pngW = png.readUInt32BE(16);
          const pngH = png.readUInt32BE(20);
          const { w, h } = await mainDisplayLogicalSize(pngW, pngH);
          const scaleFactor = (pngW / w + pngH / h) / 2;
          return {
            png,
            width: w,
            height: h,
            offsetX: 0,
            offsetY: 0,
            scaleFactor,
          };
        }
      } finally {
        await fsp.unlink(tmp).catch(() => {});
      }
    } catch (e) {
      console.error(
        `[screen] screencapture-first failed (${e instanceof Error ? e.message.split("\n")[0] : String(e)}) — falling back to nut-js capture (in-process, crash-prone).`,
      );
    }
  }

  // Fallback: primary display via nut-js. No multi-monitor offset.
  //
  // Retina/HiDPI (2026-06-10): nut-js was long assumed to return logical
  // pixels ("no Retina double-up, scaleFactor is 1"). Measured reality on
  // macOS: grabRegion returns NATIVE pixels — a 1512×982 logical display
  // yields a 3024×1964 PNG — while `size()` reports logical. Hardcoding
  // scaleFactor:1 here made maybeCropToTargetApp slice logical-coord
  // rects out of a native PNG (wrong region, half size → ~100% mis-
  // grounding on cropped steps). Derive the true factor from the PNG's
  // IHDR dims, same as captureViaDesktopCapturer above.
  const { width, height } = await size();
  const region = new Region(0, 0, width, height);
  const img = await nutScreen.grabRegion(region);
  const png = await imageToPng(img);
  let scaleFactor = 1;
  if (png.length >= 24 && png.readUInt32BE(0) === 0x89504e47) {
    const pngWidth = png.readUInt32BE(16);
    const pngHeight = png.readUInt32BE(20);
    scaleFactor = (pngWidth / width + pngHeight / height) / 2;
  }
  return { png, width, height, offsetX: 0, offsetY: 0, scaleFactor };
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

/**
 * Move the pointer to (x, y) WITHOUT clicking — hover menus, tooltips,
 * and reveal-on-hover controls (macOS traffic lights, row action
 * buttons). Also used by scroll-at-target to aim the wheel.
 */
export async function hover(x: number, y: number): Promise<void> {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (cliclickPath) {
    await cliclickRun(`m:${ix},${iy}`);
    return;
  }
  await mouse.move(straightTo(new Point(ix, iy)));
}

export async function click(
  x: number,
  y: number,
  opts: {
    button?: "left" | "right";
    double?: boolean;
    triple?: boolean;
    /** Modifier keys HELD during the click — shift+click multi-select,
     *  cmd+click open-in-new-tab / add-to-selection, alt/ctrl variants.
     *  cliclick names: cmd, shift, alt, ctrl. */
    modifiers?: Array<"cmd" | "shift" | "alt" | "ctrl">;
  } = {},
): Promise<void> {
  const ix = Math.round(x);
  const iy = Math.round(y);

  if (cliclickPath) {
    // cliclick mode — WITH a pointer-move + dwell BEFORE the click.
    //
    // Measured 2026-06-10 (deterministic 5-button probe on the SwiftUI
    // Calculator, no model in the loop): a bare `c:x,y` teleport-click
    // registered only 2/5 — SwiftUI controls drop synthetic clicks that
    // arrive without a preceding pointer-move (the control never saw a
    // hover/enter event, so the down/up at a "teleported" location is
    // ignored). `m:x,y w:200 c:x,y` registered 5/5 across rounds. This
    // was the LAST cause of the loop's intermittent "click changed
    // nothing" failures after coordinates and Z-order were proven right.
    //
    // Tradeoff: the user's cursor now physically moves to the target
    // (the original cliclick promise was a parked cursor). A click that
    // doesn't click is worth less than a still cursor. Set
    // PONDER_CLICK_DWELL_MS=0 to restore the legacy no-move teleport
    // click for surfaces that tolerate it.
    const dwell = Math.max(
      0,
      Number(process.env.PONDER_CLICK_DWELL_MS ?? 200),
    );
    const pre = dwell > 0 ? [`m:${ix},${iy}`, `w:${dwell}`] : [];
    // Modifier-held clicks: wrap the click in kd:/ku: pairs so the
    // modifier is physically down during the press (shift+click range
    // select, cmd+click multi-select / open-in-new-tab).
    if (opts.modifiers && opts.modifiers.length > 0) {
      const mods = opts.modifiers.join(",");
      const cmd =
        opts.button === "right" ? "rc" : opts.double ? "dc" : "c";
      await cliclickRun(...pre, `kd:${mods}`, `${cmd}:${ix},${iy}`, `ku:${mods}`);
      return;
    }
    if (opts.triple) {
      // No `tc:` shortcut in cliclick — chain three c: commands. macOS
      // aggregates consecutive same-pixel clicks within ~500ms into a real
      // multi-click event, so this lands as a triple-click (selects all in a
      // single-line field, the paragraph in a multi-line text area). Paired
      // with a follow-up `type X`, the type replaces the field's contents.
      await cliclickRun(
        ...pre,
        `c:${ix},${iy}`,
        `c:${ix},${iy}`,
        `c:${ix},${iy}`,
      );
      return;
    }
    const cmd =
      opts.button === "right" ? "rc" : opts.double ? "dc" : "c";
    await cliclickRun(...pre, `${cmd}:${ix},${iy}`);
    return;
  }

  // Foreground fallback: animate the OS cursor (your real mouse) to the
  // target, hover briefly so the click is obviously visible, then fire.
  await mouse.move(straightTo(new Point(ix, iy)));
  await sleep(POST_MOVE_HOVER_MS);
  const NUT_MOD: Record<string, Key> = {
    cmd: Key.LeftCmd,
    shift: Key.LeftShift,
    alt: Key.LeftAlt,
    ctrl: Key.LeftControl,
  };
  const heldMods = (opts.modifiers ?? [])
    .map((m) => NUT_MOD[m])
    .filter((k): k is Key => k !== undefined);
  for (const k of heldMods) await keyboard.pressKey(k);
  try {
    if (heldMods.length > 0) {
      if (opts.button === "right") await mouse.rightClick();
      else if (opts.double) await mouse.doubleClick(Button.LEFT);
      else await mouse.leftClick();
      return;
    }
  } finally {
    for (const k of heldMods.reverse()) await keyboard.releaseKey(k);
  }
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

// ---------------------------------------------------------------------------
// Direct window capture (occlusion-proof) — 2026-06-10.
//
// The crop path (loop.ts maybeCropToTargetApp) slices the target's rect out
// of a full-screen capture, which means it captures whatever is RENDERED
// there. raiseMacApp + recapture defends against ordinary Z-order burial,
// but is helpless against floating windows (e.g. the iOS Simulator pins
// itself at CGWindowLevel 8 — above every layer-0 window). Observed live:
// the crop returned the Simulator's pixels at Calculator's coords and the
// model grounded "the 7 button" onto the Simulator — the May-11 incident
// class, recurring.
//
// `screencapture -l<windowId>` captures the WINDOW'S OWN backing store:
// native-resolution, pixel-exact, and immune to occlusion entirely. The
// window id comes from CGWindowListCopyWindowInfo via a tiny Swift helper
// (JXA's ObjC bridge segfaults on this call), compiled once to
// ~/.ponder/bin/ponder-winlist (~50ms/exec thereafter; the one-time
// swiftc compile is ~5-15s and logged).
//
// The same window list also gives DETERMINISTIC occlusion detection: any
// window earlier in the list (CGWindowList is front-to-back) that
// intersects the target and sits below the system-chrome layers (<20) is
// an occluder. Grounding is safe regardless (we capture the window's own
// pixels), but CLICKS land on whatever is physically on top — so callers
// surface the occluder list to the log/history instead of misclicking
// silently.
// ---------------------------------------------------------------------------

export interface MacWindowInfo {
  id: number;
  owner: string;
  name: string;
  layer: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

const WINLIST_SWIFT = `import CoreGraphics
import Foundation
var windows: [[String: Any]] = []
let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
if let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] {
  for w in list {
    guard let b = w[kCGWindowBounds as String] as? [String: Any] else { continue }
    windows.append([
      "id": w[kCGWindowNumber as String] as? Int ?? 0,
      "owner": w[kCGWindowOwnerName as String] as? String ?? "",
      "name": w[kCGWindowName as String] as? String ?? "",
      "layer": w[kCGWindowLayer as String] as? Int ?? -1,
      "x": b["X"] as? Double ?? 0,
      "y": b["Y"] as? Double ?? 0,
      "w": b["Width"] as? Double ?? 0,
      "h": b["Height"] as? Double ?? 0,
    ])
  }
}
// Display bounds — lets the caller refuse partially off-screen windows
// (screencapture -l happily returns the full backing store, including
// pixels the user cannot see or click).
var displays: [[String: Any]] = []
var ids = [CGDirectDisplayID](repeating: 0, count: 16)
var count: UInt32 = 0
if CGGetActiveDisplayList(16, &ids, &count) == .success {
  for i in 0..<Int(count) {
    let b = CGDisplayBounds(ids[i])
    displays.append([
      "x": b.origin.x, "y": b.origin.y,
      "w": b.size.width, "h": b.size.height,
    ])
  }
}
let data = try JSONSerialization.data(withJSONObject: ["windows": windows, "displays": displays])
print(String(data: data, encoding: .utf8)!)
`;

// undefined = not yet probed; null = unavailable on this machine (no
// swiftc / compile failed) — probed once per process.
let winlistBinPromise: Promise<string | null> | undefined;

async function ensureWinlistBinary(): Promise<string | null> {
  if (winlistBinPromise) return winlistBinPromise;
  winlistBinPromise = (async () => {
    const os = await import("node:os");
    const path = await import("node:path");
    const fsp = await import("node:fs/promises");
    const { createHash } = await import("node:crypto");
    try {
      const dir = path.join(os.homedir(), ".ponder", "bin");
      await fsp.mkdir(dir, { recursive: true });
      const bin = path.join(dir, "ponder-winlist");
      const hash = createHash("sha256")
        .update(WINLIST_SWIFT)
        .digest("hex")
        .slice(0, 12);
      const stamp = path.join(dir, `.ponder-winlist.${hash}`);
      const haveStamp = await fsp
        .access(stamp)
        .then(() => true)
        .catch(() => false);
      const haveBin = await fsp
        .access(bin)
        .then(() => true)
        .catch(() => false);
      if (!haveStamp || !haveBin) {
        const src = path.join(dir, "ponder-winlist.swift");
        await fsp.writeFile(src, WINLIST_SWIFT);
        console.error(
          "[screen] compiling window-list helper (one-time, ~5-15s): swiftc → ~/.ponder/bin/ponder-winlist",
        );
        await execFileAsync("/usr/bin/swiftc", ["-O", src, "-o", bin], {
          timeout: 120_000,
        });
        // Clear stale stamps from previous source versions, then stamp.
        for (const f of await fsp.readdir(dir)) {
          if (f.startsWith(".ponder-winlist.") && f !== path.basename(stamp)) {
            await fsp.unlink(path.join(dir, f)).catch(() => {});
          }
        }
        await fsp.writeFile(stamp, "");
      }
      return bin;
    } catch (e) {
      console.error(
        `[screen] window-list helper unavailable (${e instanceof Error ? e.message.split("\n")[0] : String(e)}) — direct window capture disabled, falling back to screen-crop.`,
      );
      return null;
    }
  })();
  return winlistBinPromise;
}

interface WinlistSnapshot {
  windows: MacWindowInfo[];
  displays: Array<{ x: number; y: number; width: number; height: number }>;
}

async function winlistSnapshot(): Promise<WinlistSnapshot | null> {
  if (process.platform !== "darwin") return null;
  const bin = await ensureWinlistBinary();
  if (!bin) return null;
  try {
    const { stdout } = await execFileAsync(bin, [], { timeout: 3_000 });
    const parsed = JSON.parse(stdout) as {
      windows?: Array<Record<string, unknown>>;
      displays?: Array<Record<string, unknown>>;
    };
    return {
      windows: (parsed.windows ?? []).map((w) => ({
        id: Number(w.id ?? 0),
        owner: String(w.owner ?? ""),
        name: String(w.name ?? ""),
        layer: Number(w.layer ?? -1),
        x: Number(w.x ?? 0),
        y: Number(w.y ?? 0),
        width: Number(w.w ?? 0),
        height: Number(w.h ?? 0),
      })),
      displays: (parsed.displays ?? []).map((d) => ({
        x: Number(d.x ?? 0),
        y: Number(d.y ?? 0),
        width: Number(d.w ?? 0),
        height: Number(d.h ?? 0),
      })),
    };
  } catch (e) {
    console.error(
      `[screen] winlistSnapshot failed (${e instanceof Error ? e.message.split("\n")[0] : String(e)})`,
    );
    return null;
  }
}

/** Enumerate on-screen windows front-to-back. Null when the helper is
 *  unavailable (non-darwin, no Swift toolchain). */
export async function listMacWindows(): Promise<MacWindowInfo[] | null> {
  const snap = await winlistSnapshot();
  return snap ? snap.windows : null;
}

/**
 * Capture `targetApp`'s frontmost window directly via its window id —
 * native resolution, immune to occlusion. Returns the standard Screenshot
 * shape (offsetX/Y = window origin in global logical coords, so the
 * existing click-translation math works unchanged) plus the window id and
 * the list of windows currently overlapping it (front-to-back).
 *
 * Null on any failure (helper unavailable, app has no on-screen window,
 * screencapture denied) — callers fall back to the screen-crop path.
 */
export async function captureWindowDirect(
  targetApp: string,
): Promise<(Screenshot & { windowId: number; occluders: string[] }) | null> {
  if (process.platform !== "darwin") return null;
  const snap = await winlistSnapshot();
  if (!snap) return null;
  const wins = snap.windows;
  const target = wins.find(
    (w) =>
      w.layer === 0 &&
      w.owner === targetApp &&
      w.width >= 40 &&
      w.height >= 40,
  );
  if (!target) return null;

  // Refuse partially off-screen windows. screencapture -l happily
  // returns the FULL backing store — including pixels the user can't
  // see or click — so grounded coords could land outside any display.
  // Bailing here drops the caller into the legacy crop path, whose fit
  // checks restore the old safe bail-to-uncropped behavior. Corners
  // (2px tolerance) must each land on some display.
  if (snap.displays.length > 0) {
    const onSomeDisplay = (px: number, py: number): boolean =>
      snap.displays.some(
        (d) =>
          px >= d.x - 2 &&
          px <= d.x + d.width + 2 &&
          py >= d.y - 2 &&
          py <= d.y + d.height + 2,
      );
    const fullyOnScreen =
      onSomeDisplay(target.x, target.y) &&
      onSomeDisplay(target.x + target.width, target.y) &&
      onSomeDisplay(target.x, target.y + target.height) &&
      onSomeDisplay(target.x + target.width, target.y + target.height);
    if (!fullyOnScreen) {
      console.error(
        `[screen] captureWindowDirect("${targetApp}") skipped: window ${Math.round(target.width)}×${Math.round(target.height)}@(${Math.round(target.x)},${Math.round(target.y)}) is partially off-screen — falling back to screen-crop.`,
      );
      return null;
    }
  }

  // Front-to-back: everything before `target` that overlaps it is on top
  // of it. Layers >= 20 are system chrome (Dock 20, menu bar/status 24-25,
  // Control Center) — not meaningful occluders for grounding purposes.
  const idx = wins.indexOf(target);
  const area = target.width * target.height;
  const occluders = wins
    .slice(0, idx)
    .filter((w) => {
      if (w.owner === targetApp || w.layer >= 20) return false;
      const ix = Math.max(
        0,
        Math.min(w.x + w.width, target.x + target.width) -
          Math.max(w.x, target.x),
      );
      const iy = Math.max(
        0,
        Math.min(w.y + w.height, target.y + target.height) -
          Math.max(w.y, target.y),
      );
      return ix * iy >= area * 0.04; // ≥4% overlap — ignore edge grazes
    })
    .map(
      (w) =>
        `${w.owner}${w.name ? ` "${w.name}"` : ""} (layer ${w.layer}, ${Math.round(w.width)}×${Math.round(w.height)})`,
    );

  const os = await import("node:os");
  const path = await import("node:path");
  const fsp = await import("node:fs/promises");
  const tmp = path.join(
    os.tmpdir(),
    `ponder-windowshot-${process.pid}-${Date.now()}.png`,
  );
  try {
    // -x no sound, -o no shadow (shadow would pad the PNG beyond the
    // window bounds and break the scaleFactor math).
    await execFileAsync(
      "/usr/sbin/screencapture",
      ["-x", "-o", "-l", String(target.id), tmp],
      { timeout: 10_000 },
    );
    const png = await fsp.readFile(tmp);
    if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) return null;
    const pngW = png.readUInt32BE(16);
    const pngH = png.readUInt32BE(20);
    const scaleFactor = (pngW / target.width + pngH / target.height) / 2;
    return {
      png,
      width: Math.round(target.width),
      height: Math.round(target.height),
      offsetX: Math.round(target.x),
      offsetY: Math.round(target.y),
      scaleFactor,
      windowId: target.id,
      occluders,
    };
  } catch (e) {
    console.error(
      `[screen] captureWindowDirect("${targetApp}") failed (${e instanceof Error ? e.message.split("\n")[0] : String(e)})`,
    );
    return null;
  } finally {
    await (await import("node:fs/promises")).unlink(tmp).catch(() => {});
  }
}

/**
 * Which window is frontmost at a screen point (logical coords)? Used by
 * the loop's pre-click occlusion re-check: capture-time raising doesn't
 * guarantee click-time Z-order — the user (or another app) can come
 * back on top during the ~2s of model time between capture and click,
 * and the CGEvent then lands on THEIR window. ~60-120ms via the
 * compiled winlist helper. Null when the helper is unavailable or no
 * window contains the point. Ignores system chrome (layer >= 20).
 */
export async function frontWindowAtPoint(
  x: number,
  y: number,
): Promise<MacWindowInfo | null> {
  const wins = await listMacWindows();
  if (!wins) return null;
  for (const w of wins) {
    if (w.layer >= 20) continue;
    if (x >= w.x && x <= w.x + w.width && y >= w.y && y <= w.y + w.height) {
      return w; // front-to-back order — first hit is the top window
    }
  }
  return null;
}

/**
 * One-snapshot pre-click readiness check: what covers the click point,
 * and which app is active (frontmost layer-0 window's owner). Both
 * matter for CGEvent delivery: a covering window swallows the click
 * outright, and an INACTIVE target can consume the first click as a
 * window-activation click without pressing the control under it
 * (classic macOS first-click behavior — observed live: clicks 4s apart
 * at the same Calculator button, first no-op, retry registers).
 */
export async function clickObstruction(
  targetApp: string,
  x: number,
  y: number,
): Promise<{ coveredBy: string | null; activeApp: string | null } | null> {
  const wins = await listMacWindows();
  if (!wins) return null;
  let coveredBy: string | null = null;
  for (const w of wins) {
    if (w.layer >= 20) continue;
    if (x >= w.x && x <= w.x + w.width && y >= w.y && y <= w.y + w.height) {
      coveredBy = w.owner === targetApp ? null : w.owner;
      break; // front-to-back — first hit is the top window at the point
    }
  }
  const front = wins.find((w) => w.layer === 0);
  return { coveredBy, activeApp: front ? front.owner : null };
}
