/**
 * Window factories + cursor-tracking controller.
 *
 * The Overlay is the Clicky-style "trailing chat bubble":
 *   - Frameless + transparent so the rendered .bubble card *is* the visible UI.
 *   - Click-through by default (forward mouse events) — like Clicky's
 *     CompanionResponseOverlay (`ignoresMouseEvents = true`).
 *   - 60fps cursor tracking when in "tail" mode (Clicky's repositionPanelNearCursor).
 *   - Auto-resizes to content via IPC: renderer measures and calls overlay:resize.
 *
 * Two interaction modes (toggled from main.ts via setOverlayInteractive):
 *   - "input"   → setIgnoreMouseEvents(false). User can click + type.
 *   - "tail"    → setIgnoreMouseEvents(true, { forward: true }). Click-through,
 *                 mouse hovers/clicks pass through to the app underneath.
 *
 * Reference (Swift, ported to TS):
 *   /tmp/clicky-ref/leanring-buddy/CompanionResponseOverlay.swift
 *     • cursorOffsetX = 22, cursorOffsetY = 6, overlayMaxWidth = 340
 *     • 60Hz repositioning, edge-flip if it would go off-screen
 *     • orderFrontRegardless + nonactivatingPanel — never steals focus
 */
import { BrowserWindow, screen as electronScreen, app } from "electron";
import { join } from "node:path";

const isDev = !app.isPackaged;
const RENDERER_URL = process.env.ELECTRON_RENDERER_URL;

// Cursor-relative offsets — match Clicky exactly.
const CURSOR_OFFSET_X = 22;
const CURSOR_OFFSET_Y = 6;
const OVERLAY_MAX_WIDTH = 360;
const OVERLAY_MIN_WIDTH = 220;
const OVERLAY_DEFAULT_HEIGHT = 60;

let cursorTrackingTimer: NodeJS.Timeout | null = null;

type RendererName = "overlay" | "app" | "buddy";

function rendererPath(name: RendererName): string {
  // Vite roots dev server at common parent of rollup inputs (src/renderer/),
  // so URLs are /overlay/index.html, /app/index.html, /buddy/index.html.
  if (isDev && RENDERER_URL) return `${RENDERER_URL}/${name}/index.html`;
  return `file://${join(__dirname, `../renderer/${name}/index.html`)}`;
}

export function createOverlayWindow(): BrowserWindow {
  const cursor = electronScreen.getCursorScreenPoint();

  const win = new BrowserWindow({
    width: OVERLAY_MAX_WIDTH,
    height: OVERLAY_DEFAULT_HEIGHT,
    x: cursor.x + CURSOR_OFFSET_X,
    y: cursor.y + CURSOR_OFFSET_Y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false, // we own the position via cursor tracking
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false, // shadow is painted by CSS so it can be soft + animated
    focusable: true, // start focusable so input can take typing
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false, // keep 60fps cursor tracking even if blurred
    },
  });

  // screen-saver level → above almost everything (Clicky uses .statusBar /
  // .screenSaver). Visible across spaces so it follows the user.
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  void win.loadURL(rendererPath("overlay"));
  win.once("ready-to-show", () => win.show());
  return win;
}

/** Snap the window's top-left to the cursor (one-shot). */
export function positionOverlayAtCursor(win: BrowserWindow): void {
  positionAtCursor(win);
}

function positionAtCursor(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const cursor = electronScreen.getCursorScreenPoint();
  const display = electronScreen.getDisplayNearestPoint(cursor);
  const visible = display.workArea; // excludes menu bar + dock
  const [w, h] = win.getSize();

  // Default: down-and-right of cursor (Clicky's layout).
  let x = cursor.x + CURSOR_OFFSET_X;
  let y = cursor.y + CURSOR_OFFSET_Y;

  // Edge flip — if right edge would clip, place to the left of the cursor.
  if (x + w > visible.x + visible.width) {
    x = cursor.x - CURSOR_OFFSET_X - w;
  }
  // If bottom would clip, place above the cursor.
  if (y + h > visible.y + visible.height) {
    y = cursor.y - CURSOR_OFFSET_Y - h;
  }
  // Final clamp to keep the bubble fully on-screen.
  x = Math.max(visible.x, Math.min(x, visible.x + visible.width - w));
  y = Math.max(visible.y, Math.min(y, visible.y + visible.height - h));

  win.setPosition(Math.round(x), Math.round(y));
}

/**
 * Begin tracking the cursor at ~60Hz. Used during "tail" mode when the bubble
 * is showing streaming agent output and should glide along with the cursor.
 *
 * Stops automatically if the window is destroyed; otherwise call stopCursorTracking().
 */
export function startCursorTracking(win: BrowserWindow): void {
  stopCursorTracking();
  // 16ms → ~60Hz. Matches Clicky's `Timer.scheduledTimer(withTimeInterval: 1/60)`.
  cursorTrackingTimer = setInterval(() => {
    if (win.isDestroyed() || !win.isVisible()) {
      stopCursorTracking();
      return;
    }
    positionAtCursor(win);
  }, 16);
}

export function stopCursorTracking(): void {
  if (cursorTrackingTimer) {
    clearInterval(cursorTrackingTimer);
    cursorTrackingTimer = null;
  }
}

/**
 * Switch the overlay between interactive (input mode) and click-through (tail mode).
 *
 * Click-through with `forward: true` lets hover events still reach the renderer
 * (so :hover styles, cursor-following, etc. work) while clicks pass through to
 * whatever app is below — the user can keep working while the bubble narrates.
 */
export function setOverlayInteractive(win: BrowserWindow, interactive: boolean): void {
  if (win.isDestroyed()) return;
  if (interactive) {
    win.setIgnoreMouseEvents(false);
    win.setFocusable(true);
    win.focus();
  } else {
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setFocusable(false);
  }
}

/**
 * Resize the overlay to fit its content. Renderer measures its bubble after
 * each render and calls window.agent.resizeOverlay({w,h}) → IPC → here.
 *
 * We clamp to [OVERLAY_MIN_WIDTH, OVERLAY_MAX_WIDTH] so the card never
 * gets uncomfortably narrow or hogs the screen.
 */
export function resizeOverlayToContent(
  win: BrowserWindow,
  contentWidth: number,
  contentHeight: number,
): void {
  if (win.isDestroyed()) return;
  const w = Math.max(
    OVERLAY_MIN_WIDTH,
    Math.min(OVERLAY_MAX_WIDTH, Math.ceil(contentWidth)),
  );
  const h = Math.max(40, Math.min(520, Math.ceil(contentHeight)));
  win.setSize(w, h);
  positionAtCursor(win);
}

/**
 * Buddy window — a full-screen, transparent, click-through overlay covering
 * the primary display. Hosts the cursor-following blue triangle + speech
 * bubble (Clicky's `OverlayWindow` + `BlueCursorView`).
 *
 * The window itself can't be interacted with — it forwards mouse events to
 * whatever's underneath. The triangle/bubble are rendered relative to a
 * cursor position that main pushes via `buddy:cursor` IPC.
 */
let buddyCursorTimer: NodeJS.Timeout | null = null;

export function createBuddyWindow(): BrowserWindow {
  const display = electronScreen.getPrimaryDisplay();
  const bounds = display.bounds;

  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    // Must be focusable from the start so that win.focus() during input mode
    // actually grants keyboard focus on macOS. Toggling focusable post-creation
    // is unreliable for transparent click-through windows.
    focusable: true,
    show: false,
    // type:"panel" makes this an NSPanel — non-activating, behaves like
    // Clicky's CompanionPanelView. Available on Electron 25+.
    type: "panel",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  // Click-through is the default state — toggled to interactive only when the
  // input pill is up. forward:true keeps hover events flowing so the triangle
  // still tracks cursor moves while click-through.
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  void win.loadURL(rendererPath("buddy"));
  win.once("ready-to-show", () => win.show());
  return win;
}

/**
 * Begin pushing cursor positions (window-local coordinates) to the buddy
 * renderer at ~60Hz. Stop with stopBuddyCursorBroadcast().
 *
 * IMPORTANT: do NOT bail on `!win.isVisible()` — at boot we kick off the
 * broadcast before `ready-to-show` fires, so the very first tick would
 * otherwise self-terminate and the triangle would never appear.
 * The window is always-visible by design after boot; only "destroyed"
 * is a real stop condition.
 */
export function startBuddyCursorBroadcast(win: BrowserWindow): void {
  stopBuddyCursorBroadcast();
  buddyCursorTimer = setInterval(() => {
    if (win.isDestroyed()) {
      stopBuddyCursorBroadcast();
      return;
    }
    if (win.webContents.isLoading()) return; // skip until renderer mounted
    const screenPoint = electronScreen.getCursorScreenPoint();
    const winBounds = win.getBounds();
    win.webContents.send("buddy:cursor", {
      x: screenPoint.x - winBounds.x,
      y: screenPoint.y - winBounds.y,
    });
  }, 16);
}

export function stopBuddyCursorBroadcast(): void {
  if (buddyCursorTimer) {
    clearInterval(buddyCursorTimer);
    buddyCursorTimer = null;
  }
}

export function createAppWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: false,
    },
  });
  void win.loadURL(rendererPath("app"));
  win.once("ready-to-show", () => win.show());
  // DevTools used to open automatically in dev — that grew annoying once the
  // app stabilized (and noisy logs from the panel itself drowned out the agent
  // loop's output). Gate behind HOLO3_DEVTOOLS=1 so it's opt-in. ⌘⌥I (or the
  // View menu, when it's added) still opens it on demand.
  if (isDev && process.env.HOLO3_DEVTOOLS === "1") {
    win.webContents.openDevTools({ mode: "detach" });
  }
  return win;
}
