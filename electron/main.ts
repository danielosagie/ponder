import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  globalShortcut,
  ipcMain,
  screen as electronScreen,
  shell,
  nativeImage,
  Notification,
} from "electron";
import { join } from "node:path";
import { config as loadDotenv } from "dotenv";
import { ConvexHttpClient } from "convex/browser";
import { api as convexApi } from "@convex/_generated/api";

// Load .env (and .env.local) from the project root so the main process sees
// MODAL_BASE_URL / MODAL_BEARER_TOKEN / VITE_CONVEX_URL. Vite only auto-loads
// VITE_-prefixed vars into the renderer; main needs explicit dotenv.
loadDotenv({ path: join(process.cwd(), ".env") });
loadDotenv({ path: join(process.cwd(), ".env.local"), override: false });

import { runTask } from "../src/agent/loop";
import { BACKGROUND_MODE } from "../src/screen";
import { createOllamaNarrator } from "../src/agent/narrator";
import type { AgentEvents, ProviderClient, ProviderName } from "../src/agent/types";
import { createRemoteProvider } from "../src/agent/providers/remote";
import { createLocalProvider } from "../src/agent/providers/local";
import { createHCompanyProvider } from "../src/agent/providers/hcompany";
import { WarmupQueue } from "../src/agent/warmup";
import {
  probe as probePerms,
  requestAccessibility,
  requestScreenRecording,
} from "../src/perms";
import {
  createAppWindow,
  createBuddyWindow,
  startBuddyCursorBroadcast,
} from "./windows";

let tray: Tray | null = null;
let appWin: BrowserWindow | null = null;
let buddyWin: BrowserWindow | null = null;
// Default provider: prefer the hosted H Company API when its key is set, since
// it's the no-infrastructure path and the model is full-quality. Fall back to
// Modal (self-host) if the user only has those creds, otherwise Local. The
// computeDefault() runs after dotenv has loaded so env vars are visible.
let providerName: ProviderName = computeDefaultProvider();
let cancelFlag = false;
let activeSessionId: string | null = null;

function computeDefaultProvider(): ProviderName {
  if (process.env.HAI_API_KEY ?? process.env.HCOMPANY_API_KEY) return "hcompany";
  if (process.env.MODAL_BASE_URL && process.env.MODAL_BEARER_TOKEN) return "remote";
  return "local";
}

/**
 * Boot the Buddy overlay once at app start. The window stays alive for the
 * whole session — it's transparent, click-through, and just hosts the
 * cursor-following triangle (idle) plus speech bubbles (during tasks).
 */
function ensureBuddy(): BrowserWindow {
  if (!buddyWin || buddyWin.isDestroyed()) {
    buddyWin = createBuddyWindow();
    // Start broadcasting cursor immediately so the triangle is alive from
    // the moment the window mounts.
    startBuddyCursorBroadcast(buddyWin);
    // Fire the one-shot welcome once the renderer is mounted. This plays
    // the typewriter "hi i'm holo3" greeting exactly once per app session.
    const fireWelcome = () => buddyWin?.webContents.send("buddy:welcome");
    if (buddyWin.webContents.isLoading()) {
      buddyWin.webContents.once("did-finish-load", () =>
        setTimeout(fireWelcome, 400),
      );
    } else {
      setTimeout(fireWelcome, 400);
    }
  }
  return buddyWin;
}

/**
 * Tell the buddy renderer that an agent task is starting (welcome animation +
 * prep speech bubble) or ending (let bubble fade naturally). The window is
 * NOT hidden in either case — only the bubble inside it changes state.
 *
 * The buddy window stays click-through throughout — the Stop affordances are
 * the global hotkey ⌘. and the in-app Stop button. We tried embedding a
 * clickable Stop chip inside the buddy, but Electron's setIgnoreMouseEvents
 * is window-wide on macOS (no "click-through except region X"), so the chip
 * would have made the entire buddy intercept clicks while running. Hotkey
 * is the safer UX.
 */
function setBuddyMode(mode: "active" | "hidden"): void {
  if (!buddyWin || buddyWin.isDestroyed()) return;
  buddyWin.webContents.send("buddy:mode", mode);
}

type SayKind = "thought" | "action" | "error" | "status";

function buddySay(kind: SayKind, text: string): void {
  if (!buddyWin || buddyWin.isDestroyed()) return;
  if (!text || !text.trim()) return;
  buddyWin.webContents.send("buddy:say", { kind, text: text.trim() });
}

/**
 * Tell the buddy where the agent is targeting next (or null to hide). The
 * buddy renders a separate animated cursor at this location so the user
 * sees what the agent is doing without their own mouse being affected (in
 * background mode with cliclick installed). In foreground mode the agent
 * still hijacks the OS cursor — the agent indicator just rides along.
 */
function buddyAgentCursor(coords: { x: number; y: number; kind: "click" | "double" } | null): void {
  if (!buddyWin || buddyWin.isDestroyed()) return;
  buddyWin.webContents.send("buddy:agentCursor", coords);
}

/**
 * Show the input pill near the cursor and make the buddy window interactive
 * so it can capture typing. ⌘E calls this; submit/Esc/click-outside calls
 * dismissInputPill().
 */
let inputPillVisible = false;

function showInputPill(): void {
  const win = ensureBuddy();
  const screenPoint = electronScreen.getCursorScreenPoint();
  const winBounds = win.getBounds();
  const x = screenPoint.x - winBounds.x;
  const y = screenPoint.y - winBounds.y;

  // 1. Window must catch clicks/keys (was click-through before this).
  win.setIgnoreMouseEvents(false);

  // 2. macOS panel-window focus is flaky after another app stole focus
  //    (e.g., during an agent task that clicked into Safari). A single
  //    win.focus() is not enough on the second/third summon. Run the full
  //    chain twice, separated by a tick, so that whichever step is needed
  //    actually lands.
  const focusChain = () => {
    if (win.isDestroyed()) return;
    if (process.platform === "darwin") app.focus({ steal: true });
    if (!win.isVisible()) win.show();
    win.moveTop();
    win.focus();
    win.webContents.focus();
  };
  focusChain();
  setTimeout(focusChain, 50);

  // 3. Tell the renderer to mount the input pill. It'll attempt focus on
  //    the <input> element multiple times (RAF + delayed setTimeout) to
  //    cover the case where the window grants key status late.
  win.webContents.send("buddy:inputMode", { visible: true, x, y });
  inputPillVisible = true;
}

function dismissInputPill(): void {
  if (!buddyWin || buddyWin.isDestroyed()) {
    inputPillVisible = false;
    return;
  }
  buddyWin.webContents.send("buddy:inputMode", { visible: false, x: 0, y: 0 });
  // Restore click-through. We leave focusable=true so a future ⌘E press
  // can re-grant focus without a window recreate.
  buddyWin.setIgnoreMouseEvents(true, { forward: true });
  inputPillVisible = false;
}

const convexUrl = process.env.VITE_CONVEX_URL ?? process.env.CONVEX_URL;
const convex = convexUrl ? new ConvexHttpClient(convexUrl) : null;

function makeProvider(name: ProviderName): ProviderClient {
  if (name === "local") return createLocalProvider();

  if (name === "hcompany") {
    const apiKey =
      process.env.HAI_API_KEY ?? process.env.HCOMPANY_API_KEY ?? "";
    return createHCompanyProvider({
      apiKey,
      model: process.env.HCOMPANY_MODEL ?? "holo3-35b-a3b",
    });
  }

  const baseUrl = process.env.MODAL_BASE_URL;
  const token = process.env.MODAL_BEARER_TOKEN;
  if (!baseUrl || !token) {
    return createRemoteProvider({
      baseUrl: "http://invalid",
      token: "missing",
    });
  }
  return createRemoteProvider({ baseUrl, token });
}

function isProviderConfigured(name: ProviderName): boolean {
  if (name === "local") return true;
  if (name === "hcompany") {
    return !!(process.env.HAI_API_KEY ?? process.env.HCOMPANY_API_KEY);
  }
  return !!(process.env.MODAL_BASE_URL && process.env.MODAL_BEARER_TOKEN);
}

// Back-compat alias used elsewhere in this file.
function isRemoteConfigured(): boolean {
  return isProviderConfigured("remote");
}

// Narrator: small Ollama-backed chat model that speaks the intro / summary
// in the buddy bubble. Decoupled from the planner so the Holo3 model can
// focus on action selection. Defaults to Qwen3 0.6B; override with
// NARRATOR_MODEL / NARRATOR_HOST. Failures fall back to templated lines —
// the run never blocks on the narrator.
const narrator = createOllamaNarrator();

let warmup = new WarmupQueue(makeProvider(providerName));

warmup.onChange((state, detail) => {
  broadcastState({ warmup: state, errorMessage: detail });
  if (state === "ready") {
    new Notification({
      title: "Holo3 ready",
      body: `${humanProviderLabel(providerName)} ready.`,
    }).show();
  }
});

function broadcastState(extra: Partial<AgentStateMsg> = {}): void {
  const msg: AgentStateMsg = {
    warmup: warmup.getState(),
    provider: providerName,
    activeSessionId,
    ...extra,
  };
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("agent:state", msg);
  }
}

interface AgentStateMsg {
  warmup: "cold" | "warming" | "ready" | "error";
  provider: ProviderName;
  activeSessionId: string | null;
  errorMessage?: string;
}

async function buildEvents(sessionId: string): Promise<AgentEvents> {
  // Wire every agent event into the buddy bubble so the user sees a live
  // narration of what's happening (Clicky-style):
  //   onScreenshot → "Reading the screen…"  (status, with spinner)
  //   onGround     → "Targeting at (x, y)"  (status, with spinner)
  //   onStatus     → text passed through    (status, with spinner)
  //   onThought    → the model's reasoning  (thought, with spinner until next)
  //   onAction     → "click {…}"            (action, brief)
  //   onError      → red bubble             (error)
  if (!convex) {
    // Convex unavailable — still pipe everything to the buddy so the UI
    // doesn't go silent.
    return {
      onThought: (t) => buddySay("thought", t),
      onGround: (c) => {
        buddySay("status", `Targeting at (${c.x}, ${c.y})`);
        buddyAgentCursor({ x: c.x, y: c.y, kind: "click" });
      },
      onAction: (a) =>
        buddySay(
          "action",
          `${a.type}${a.payload ? ` ${JSON.stringify(a.payload).slice(0, 60)}` : ""}`,
        ),
      onScreenshot: () => buddySay("status", "Reading the screen…"),
      onError: (m) => buddySay("error", m),
      onStatus: (t) => buddySay("status", t),
    };
  }
  return {
    onThought: async (text) => {
      buddySay("thought", text);
      await convex.mutation(convexApi.steps.append, {
        sessionId: sessionId as never,
        kind: "thought",
        text,
      });
    },
    onGround: async (coords) => {
      buddySay("status", `Targeting at (${coords.x}, ${coords.y})`);
      // Send the same coords to the buddy renderer so the agent triangle
      // animates to the target. The blue agent cursor flies across the
      // screen while the user's actual mouse stays put (background mode).
      buddyAgentCursor({ x: coords.x, y: coords.y, kind: "click" });
      await convex.mutation(convexApi.steps.append, {
        sessionId: sessionId as never,
        kind: "ground",
        coords,
      });
    },
    onAction: async (action) => {
      const summary = `${action.type}${
        action.payload ? ` ${JSON.stringify(action.payload).slice(0, 60)}` : ""
      }`;
      buddySay("action", summary);
      await convex.mutation(convexApi.steps.append, {
        sessionId: sessionId as never,
        kind: "action",
        action,
      });
    },
    onScreenshot: async (png) => {
      buddySay("status", "Reading the screen…");
      try {
        const url = await convex.mutation(convexApi.steps.generateUploadUrl, {});
        const upload = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "image/png" },
          body: new Uint8Array(png),
        });
        const { storageId } = (await upload.json()) as { storageId: string };
        await convex.mutation(convexApi.steps.append, {
          sessionId: sessionId as never,
          kind: "screenshot",
          screenshotId: storageId as never,
        });
      } catch (e) {
        console.warn("screenshot upload skipped:", e);
      }
    },
    onError: async (message) => {
      buddySay("error", message);
      await convex.mutation(convexApi.steps.append, {
        sessionId: sessionId as never,
        kind: "error",
        text: message,
      });
    },
    onStatus: async (text) => {
      buddySay("status", text);
      await convex.mutation(convexApi.steps.append, {
        sessionId: sessionId as never,
        kind: "status",
        text,
      });
    },
  };
}

/**
 * Macos-only: confirm we have the permissions nut-js needs to actually move
 * the cursor + send clicks. Without Accessibility, mouse.move/click are
 * SILENTLY ignored by the OS — the agent loop completes 30 steps and nothing
 * visibly happens. We probe once and bail with an actionable error so the
 * user knows what to do (open Settings, toggle, restart).
 *
 * The Windows-based reference repo (PromptEngineer48/holo3-demo) doesn't have
 * this problem because pyautogui on Windows doesn't gate mouse/keyboard input
 * behind any system-level allowlist.
 */
async function checkActionPermissions(): Promise<{
  ok: boolean;
  message?: string;
}> {
  if (process.platform !== "darwin") return { ok: true };
  const perms = await probePerms();
  const missing: string[] = [];
  if (perms.accessibility !== "granted") missing.push("Accessibility");
  if (perms.screenRecording !== "granted") missing.push("Screen Recording");
  if (missing.length === 0) return { ok: true };
  return {
    ok: false,
    message:
      `${missing.join(" + ")} permission required for the agent to control the cursor. ` +
      "Open System Settings → Privacy & Security → " +
      missing.join(" + ") +
      ", enable this app, then restart it.",
  };
}

function setupIpc(): void {
  ipcMain.handle("agent:run", async (_e, prompt: string) => {
    if (!prompt?.trim()) return { ok: false, error: "empty prompt" };

    // Bail early if macOS hasn't granted Accessibility/Screen-Recording —
    // otherwise the loop fires for 30 steps and nothing moves on screen.
    const permsCheck = await checkActionPermissions();
    if (!permsCheck.ok) {
      const msg = permsCheck.message ?? "Missing permissions";
      console.error(`[agent:run] blocked by perms: ${msg}`);
      buddySay("error", msg);
      // Auto-open the system pane that's missing — user is one click from fixing it.
      void requestAccessibility();
      void requestScreenRecording();
      return { ok: false, error: msg };
    }

    cancelFlag = false;

    // The Buddy is already visible at all times. Activate its bubble mode +
    // dismiss the input pill if it was open.
    dismissInputPill();
    setBuddyMode("active");

    // Narrator intro — fires before warmup so the user hears the agent
    // acknowledge their request immediately. Don't await before the buddy
    // says SOMETHING; if the narrator is slow, fall back. We push a quick
    // status first to never leave the user staring at silence.
    buddySay("status", "Got it…");
    void (async () => {
      const line = await narrator.intro({ task: prompt });
      buddySay("thought", line);
    })();

    let sessionId: string | null = null;
    if (convex) {
      sessionId = (await convex.mutation(convexApi.sessions.create, {
        prompt,
        provider: providerName,
      })) as unknown as string;
      activeSessionId = sessionId;
      broadcastState();
    }

    void warmup.warmInBackground();
    if (warmup.getState() !== "ready") {
      const warmupLabel =
        providerName === "remote"
          ? "Modal"
          : providerName === "hcompany"
            ? "H Company API"
            : "local model";
      buddySay("status", `Warming up ${warmupLabel}…`);
      if (sessionId && convex) {
        await convex.mutation(convexApi.steps.append, {
          sessionId: sessionId as never,
          kind: "status",
          text: `Waiting for ${warmupLabel} to warm up…`,
        });
      }
      try {
        await warmup.waitReady();
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        buddySay("error", `Warmup failed: ${message}`);
        if (sessionId && convex) {
          await convex.mutation(convexApi.sessions.setStatus, {
            sessionId: sessionId as never,
            status: "error",
            error: message,
          });
        }
        return { ok: false, error: message };
      }
    }

    if (sessionId && convex) {
      await convex.mutation(convexApi.sessions.setStatus, {
        sessionId: sessionId as never,
        status: "running",
      });
    }
    buddySay("status", "Reading the screen…");

    const events = sessionId
      ? await buildEvents(sessionId)
      : await buildEvents("");

    try {
      const result = await runTask({
        task: prompt,
        provider: warmup.getProvider(),
        events,
        shouldCancel: () => cancelFlag,
      });
      // Narrator summary — speak a real sentence about what happened
      // ("Done — Slack is open"), not just "Done". Falls through to a
      // templated line if the narrator is unavailable.
      const summaryOutcome =
        result === "done"
          ? "done"
          : result === "cancelled"
            ? "cancelled"
            : "exhausted";
      narrator
        .summary({ task: prompt, outcome: summaryOutcome, history: [] })
        .then((line) => buddySay("thought", line))
        .catch(() => buddySay("status", result === "cancelled" ? "Cancelled" : "Done"));
      if (sessionId && convex) {
        await convex.mutation(convexApi.sessions.setStatus, {
          sessionId: sessionId as never,
          status:
            result === "done"
              ? "done"
              : result === "cancelled"
                ? "cancelled"
                : "done",
        });
      }
      return { ok: true, result };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      // Surface the failure: narrator gives a friendly framing on top of the
      // raw error bubble below.
      narrator
        .summary({ task: prompt, outcome: "error", history: [], error: message })
        .then((line) => buddySay("thought", line))
        .catch(() => {});
      buddySay("error", message);
      console.error("[agent:run]", message);
      if (sessionId && convex) {
        await convex.mutation(convexApi.sessions.setStatus, {
          sessionId: sessionId as never,
          status: "error",
          error: message,
        });
      }
      return { ok: false, error: message };
    } finally {
      activeSessionId = null;
      broadcastState();
      // Buddy window stays open. Tell the renderer to drop into idle (the
      // current bubble fades on its own 6s timer; triangle keeps following).
      setBuddyMode("hidden");
      // Hide the agent's blue ghost cursor — the run is over.
      buddyAgentCursor(null);
    }
  });

  ipcMain.handle("agent:cancel", () => {
    cancelFlag = true;
    return { ok: true };
  });

  ipcMain.handle("agent:setProvider", async (_e, name: ProviderName) => {
    try {
      switchProvider(name);
      return { ok: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      broadcastState({ warmup: "error", errorMessage: message });
      return { ok: false, error: message };
    }
  });

  ipcMain.handle("agent:warm", async () => {
    try {
      await warmup.warm();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle("agent:state", () => ({
    warmup: warmup.getState(),
    provider: providerName,
    activeSessionId,
  }));

  // Buddy renderer signals dismiss (Enter pressed → submitted, Esc, or
  // background click). Main flips the window back to click-through mode.
  ipcMain.handle("buddy:dismissInput", () => {
    dismissInputPill();
    return { ok: true };
  });

  // Legacy stubs — older renderer code (App.tsx welcome card) might still
  // call these. Return ok:false so callers can no-op gracefully.
  ipcMain.handle("overlay:hide", () => ({ ok: true }));
  ipcMain.handle("overlay:setMode", () => ({ ok: true }));
  ipcMain.handle("overlay:resize", () => ({ ok: true }));

  ipcMain.handle("app:show", () => {
    if (!appWin || appWin.isDestroyed()) appWin = createAppWindow();
    appWin.show();
    appWin.focus();
    return { ok: true };
  });

  ipcMain.handle("perms:probe", async () => probePerms());

  // Reveal the actual binary macOS is associating perms with. In dev that's
  // node_modules/electron/dist/Electron.app — useful when the entry isn't in
  // the Privacy list and the user needs to drag-drop it in via the "+" button.
  ipcMain.handle("perms:revealBinary", () => {
    const exe = app.getPath("exe");
    // exe is .../Electron.app/Contents/MacOS/Electron — back up to the .app
    // bundle so Finder selects something draggable into Privacy preferences.
    const bundle = exe.replace(/\/Contents\/MacOS\/.+$/, "");
    shell.showItemInFolder(bundle);
    return { ok: true, path: bundle };
  });

  ipcMain.handle("perms:open", (_e, pane: "accessibility" | "screen" | "input") => {
    if (process.platform !== "darwin") return;
    const urls = {
      accessibility:
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      screen:
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      input:
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
    };
    void shell.openExternal(urls[pane]);
  });

  ipcMain.handle("env:public", () => ({
    convexUrl: convexUrl ?? null,
    provider: providerName,
    backgroundMode: BACKGROUND_MODE,
  }));
}

function buildTray(): void {
  const icon = nativeImage
    .createFromPath(join(__dirname, "../../assets/tray-icon.png"))
    .resize({ width: 18, height: 18 });
  if (icon.isEmpty()) {
    // No icon file — use an empty image but set a title so the user can see it
    // in the menu bar. macOS will render the title text instead of an icon.
    tray = new Tray(nativeImage.createEmpty());
    if (process.platform === "darwin") tray.setTitle("◐ Holo3");
  } else {
    tray = new Tray(icon);
  }
  tray.setToolTip("Holo3 Agent · ⌘E to summon");
  // Click-to-toggle the overlay on left-click for the Clicky-style UX.
  tray.on("click", () => toggleInputPill());
  rebuildTrayMenu();
}

function switchProvider(name: ProviderName): void {
  if (name === providerName) {
    console.log(`[provider] already on "${name}" — no-op`);
    return;
  }
  console.log(`[provider] switching: ${providerName} → ${name}`);
  providerName = name;
  warmup = new WarmupQueue(makeProvider(name));
  warmup.onChange((state, detail) => {
    broadcastState({ warmup: state, errorMessage: detail });
    if (state === "ready") {
      new Notification({
        title: "Holo3 ready",
        body: `${humanProviderLabel(name)} ready.`,
      }).show();
    }
  });
  warmup.warmInBackground();
  broadcastState();
  rebuildTrayMenu();
}

function humanProviderLabel(name: ProviderName): string {
  if (name === "hcompany") return "H Company API";
  if (name === "remote") return "Modal · Holo3";
  return "Local (Ollama)";
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    {
      label: "Summon (⌘E)",
      click: () => toggleInputPill(),
    },
    { type: "separator" },
    { label: `Status: ${warmup.getState()}`, enabled: false },
    {
      label: "Provider",
      submenu: [
        {
          label: "H Company API (api.hcompany.ai)",
          type: "radio",
          checked: providerName === "hcompany",
          enabled: isProviderConfigured("hcompany"),
          click: () => switchProvider("hcompany"),
        },
        {
          label: "Modal · self-hosted Holo3",
          type: "radio",
          checked: providerName === "remote",
          enabled: isProviderConfigured("remote"),
          click: () => switchProvider("remote"),
        },
        {
          label: "Local (Ollama)",
          type: "radio",
          checked: providerName === "local",
          click: () => switchProvider("local"),
        },
      ],
    },
    {
      label: "Open History…",
      click: () => {
        if (!appWin || appWin.isDestroyed()) appWin = createAppWindow();
        appWin.show();
        appWin.focus();
      },
    },
    { type: "separator" },
    { label: "Quit", role: "quit" },
  ]);
  tray.setContextMenu(menu);
}

/**
 * ⌘E hotkey handler. Toggles the input pill inside the Buddy window:
 *   - If hidden: show it at the cursor + make the buddy window interactive.
 *   - If visible: dismiss + restore click-through.
 *
 * The triangle keeps rendering regardless — only the input pill toggles.
 */
function toggleInputPill(): void {
  if (inputPillVisible) {
    dismissInputPill();
  } else {
    showInputPill();
  }
}

app.whenReady().then(() => {
  // Keep dock visible during dev so the user has a visual anchor; can hide
  // later via tray menu or remove this check entirely once tray icon ships.
  // if (process.platform === "darwin") app.dock?.hide();

  buildTray();
  setupIpc();

  // Auto-open the AppWindow on launch so the user sees the history view
  // immediately. They can close it; tray icon stays for re-summon.
  if (!appWin || appWin.isDestroyed()) appWin = createAppWindow();
  appWin.show();
  appWin.focus();

  // Boot the Buddy overlay once at startup. It stays open for the whole
  // session — click-through, transparent, just hosts the cursor-following
  // triangle (and the speech bubble + input pill on demand). User invokes
  // the input pill with ⌘E; nothing summoned automatically.
  ensureBuddy();

  // Primary hotkey: ⌘E (per user request — short, easy to reach, no system conflict).
  // Fallback: ⌘⇧Space for users who already have ⌘E mapped to something else.
  const primaryAccel = "CommandOrControl+E";
  const fallbackAccel = "CommandOrControl+Shift+Space";
  const okPrimary = globalShortcut.register(primaryAccel, () => toggleInputPill());
  const okFallback = globalShortcut.register(fallbackAccel, () => toggleInputPill());
  if (!okPrimary && !okFallback) {
    console.warn(
      "Both global shortcuts failed to register. macOS Input Monitoring permission may be missing.",
    );
  } else if (!okPrimary) {
    console.warn(
      `Primary hotkey (${primaryAccel}) failed; falling back to ${fallbackAccel}.`,
    );
  }

  // PANIC STOP — ⌘. (Cmd+Period) is the macOS convention for "cancel /
  // dismiss". Hitting this from anywhere flips the cancel flag, which the
  // agent loop honors at every await boundary AND propagates to the
  // in-flight provider request via AbortSignal. So the agent stops in <1s
  // instead of waiting for a 6.5s step pause.
  const stopAccel = "CommandOrControl+.";
  const okStop = globalShortcut.register(stopAccel, () => {
    if (!cancelFlag) {
      console.log("[hotkey] ⌘. — cancelling active task");
      cancelFlag = true;
      buddySay("status", "Stopping…");
    }
  });
  if (!okStop) {
    console.warn(`Stop hotkey (${stopAccel}) failed to register.`);
  }

  console.log(
    `[boot] default provider="${providerName}" (configured: ` +
      `hcompany=${isProviderConfigured("hcompany")}, ` +
      `remote=${isProviderConfigured("remote")}, ` +
      `local=${isProviderConfigured("local")})`,
  );

  // macOS-only: probe Accessibility + Screen Recording so the user knows
  // upfront whether their first run will be a no-op. If anything is missing,
  // pop the system prompt (which deep-links to the right pane) AND send a
  // notification so the user can't miss it.
  if (process.platform === "darwin") {
    // Log the exact binary macOS attributes perms to. In dev this is the
    // stock Electron.app inside node_modules — there is no "Holo3 Agent" in
    // the Privacy list yet because we haven't packaged. The user needs to
    // grant access to THIS path.
    const exe = app.getPath("exe");
    const bundle = exe.replace(/\/Contents\/MacOS\/.+$/, "");
    console.log(`[boot] electron binary: ${bundle}`);
    console.log(
      "[boot] in System Settings → Privacy & Security, look for the entry " +
        `named "Electron" (NOT "Holo3 Agent" — that name only exists for ` +
        "packaged builds). If it's missing, click the + button and add the " +
        "path above.",
    );

    void probePerms().then((p) => {
      console.log(
        `[boot] perms accessibility=${p.accessibility} screen=${p.screenRecording} input=${p.inputMonitoring}`,
      );
      if (p.accessibility !== "granted") {
        console.warn(
          "[boot] Accessibility NOT granted — agent clicks will be silently dropped by macOS. Opening prompt.",
        );
        void requestAccessibility();
        new Notification({
          title: "Holo3 needs Accessibility access",
          body: 'Look for "Electron" in Privacy & Security → Accessibility, or add it via the + button. Then restart.',
        }).show();
      }
      if (p.screenRecording !== "granted") {
        console.warn(
          "[boot] Screen Recording NOT granted — screenshots will be black/empty.",
        );
        void requestScreenRecording();
      }
    });
  }

  if (!isProviderConfigured(providerName)) {
    const hint =
      providerName === "remote"
        ? "Set MODAL_BASE_URL and MODAL_BEARER_TOKEN in .env, or switch provider from the tray / app sidebar."
        : providerName === "hcompany"
          ? "Set HAI_API_KEY in .env, or switch provider from the tray / app sidebar."
          : "Run `bash scripts/setup-local.sh` to import the Holo3 GGUF into Ollama.";
    console.warn(`[boot] provider "${providerName}" not configured. ${hint}`);
    broadcastState({ warmup: "error", errorMessage: hint });
  } else {
    warmup.warmInBackground();
  }
});

app.on("window-all-closed", () => {
  // Stay running in tray — do nothing.
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
