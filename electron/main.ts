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
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
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
import {
  BACKGROUND_MODE,
  screenshot as captureScreenshot,
  typeText as screenTypeText,
  pressCombo as screenPressCombo,
  scroll as screenScroll,
  click as screenClick,
  drag as screenDrag,
} from "../src/screen";
import { createOllamaNarrator } from "../src/agent/narrator";
import { createExtractor } from "../src/agent/extractor";
import type { RouterClient } from "../src/agent/router";
import type { AgentEvents, ProviderName } from "../src/agent/types";
import type { BrowserClient, BrowserSnapshot } from "../src/agent/browser/types";
import { createPlaywriterClient } from "../src/agent/browser/playwriter";
import {
  computeDefaultProvider,
  isProviderConfigured,
  makeProvider,
  makeRouter,
  humanProviderLabel,
} from "../src/agent/factory";
import { setProviderPreference } from "../src/agent/preferences";
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

type SayKind = "thought" | "action" | "error" | "status" | "answer";

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

// Browser client: Playwriter-backed CDP relay to the user's MAIN Chrome.
// We embed Playwriter's relay (no external `playwriter mcp` daemon) so
// the WebSocket bridge starts when our app starts. Connection to a tab
// happens once the user clicks the green Playwriter extension icon on
// whichever tab they want controlled — Chrome's chrome.debugger API
// requires that user gesture; we can't bypass it.
//
// The browserClient itself is cheap to construct (no network, no spawn).
// The relay starts on the first available() call. When no tab is green
// yet, available() returns false and surfaces a status to the buddy
// bubble telling the user what to click. Once they click, the next probe
// connects automatically.
let browserClient: BrowserClient | null = null;
void (async () => {
  try {
    browserClient = await createPlaywriterClient({
      onStatus: (text) => {
        // Surface relay/extension status to the buddy bubble so the user
        // sees "click the Playwriter extension" prompts inline with the
        // agent's narration instead of buried in console logs.
        buddySay("status", text);
      },
    });
    console.log("[browser] client instantiated (Playwriter relay)");
  } catch (e) {
    console.warn(
      `[browser] client init failed (${e instanceof Error ? e.message : String(e)}) — vision-only mode`,
    );
  }
})();

// Best-effort relay teardown on quit. Playwriter's relay is in-process
// so it dies with us, but explicitly closing the playwright Browser
// avoids dangling CDP connections.
app.on("before-quit", () => {
  if (browserClient) {
    void browserClient.close().catch(() => {});
  }
});

// CLI router: small local Qwen3 model that picks browser.* actions
// directly from the snapshot, ~500ms per step. When it can do the work,
// we skip Holo3's plan + ground entirely (saving ~10s/step on hcompany).
// When it can't, it escalates to the vision agent with a one-sentence
// reason. The two agents work as a team, swapping step-by-step.
//
// HOLO3_ROUTER=off disables the fast path globally — the loop runs
// vision-only just like before. Useful for A/B comparisons.
const router: RouterClient | null = makeRouter();
if (router) {
  void (async () => {
    const ok = await router.available();
    console.log(
      `[router] ${ok ? "ready" : "not ready"} (model=${process.env.ROUTER_MODEL ?? "qwen3.5:0.8b"}). ` +
        `${ok ? "" : "Pull the model with: ollama pull " + (process.env.ROUTER_MODEL ?? "qwen3.5:0.8b")}`,
    );
  })();
} else {
  console.log("[router] disabled (HOLO3_ROUTER=off)");
}

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

// ── MCP bridge — lightweight task execution for forwarded agent_do ───
//
// The MCP server runs in a separate Node process spawned by Claude Code,
// where macOS Privacy & Security perms (Screen Recording, Accessibility)
// are NOT granted by default. Calling `screen.screenshot()` from there
// fails with "Failed to capture screen" and agent_do dies on step 0.
//
// This Electron app, however, HAS perms granted (the user added it to
// the Privacy panel during setup). When MCP receives an agent_do call
// it can forward the task here over a tiny localhost HTTP bridge — the
// task then runs in the Electron process where screen capture works,
// the user's tray-menu provider choice is active, the Buddy bubble
// shows progress, and Convex history persistence happens automatically
// via buildEvents.
//
// Lighter-weight than the full agent:run IPC handler (no narrator
// intro, no extractor at the end) because the MCP orchestrator
// generates its own answer text from the transcript we return.

interface BridgeResult {
  outcome: "done" | "cancelled" | "exhausted" | "error";
  sessionId: string | null;
  steps: number;
  finalUrl?: string;
  errorMessage?: string;
  transcript: string[];
  /** Base64 PNG of the final frame the inner loop captured. Lets the MCP
   *  attach it as an image content part to the agent_do tool reply so
   *  the orchestrator gets visual ground truth in the same call. */
  finalScreenshotBase64?: string;
}

let _bridgeChain: Promise<unknown> = Promise.resolve();
function chainBridge<T>(fn: () => Promise<T>): Promise<T> {
  // Serialize bridge calls so two concurrent agent_do requests don't
  // stomp on the shared Chrome tab / cursor.
  const next = _bridgeChain.catch(() => null).then(fn);
  _bridgeChain = next;
  return next;
}

async function runAgentTaskForBridge(
  opts: { prompt: string; targetApp?: string } | string,
): Promise<BridgeResult> {
  // Backwards-compat: prior callers passed a bare prompt string.
  const { prompt, targetApp } =
    typeof opts === "string" ? { prompt: opts, targetApp: undefined } : opts;
  // Mirror the perms gate from the IPC handler — better to fail fast
  // with an actionable message than 50 silent no-op steps.
  const permsCheck = await checkActionPermissions();
  if (!permsCheck.ok) {
    return {
      outcome: "error",
      sessionId: null,
      steps: 0,
      errorMessage: permsCheck.message ?? "Missing permissions",
      transcript: [],
    };
  }

  cancelFlag = false;
  dismissInputPill();
  setBuddyMode("active");
  buddySay("status", "Got it (via MCP)…");

  let sessionId: string | null = null;
  if (convex) {
    try {
      sessionId = (await convex.mutation(convexApi.sessions.create, {
        prompt,
        provider: providerName,
      })) as unknown as string;
      activeSessionId = sessionId;
      broadcastState();
    } catch (e) {
      console.warn(
        `[bridge] convex session create failed (${e instanceof Error ? e.message : String(e)})`,
      );
    }
  }

  void warmup.warmInBackground();
  if (warmup.getState() !== "ready") {
    buddySay("status", `Warming up ${humanProviderLabel(providerName)}…`);
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
      activeSessionId = null;
      broadcastState();
      setBuddyMode("hidden");
      return {
        outcome: "error",
        sessionId,
        steps: 0,
        errorMessage: message,
        transcript: [],
      };
    }
  }

  if (sessionId && convex) {
    await convex.mutation(convexApi.sessions.setStatus, {
      sessionId: sessionId as never,
      status: "running",
    });
  }

  // Build event handlers that mirror to Buddy + Convex AND collect a
  // transcript for the MCP response.
  const t0 = Date.now();
  const elapsed = (): string =>
    `[t=${((Date.now() - t0) / 1000).toFixed(1)}s]`;
  const transcript: string[] = [];
  let stepCount = 0;
  let lastSnapshot: BrowserSnapshot | undefined;
  // Latch the most recent screenshot PNG so we can ship it back to the
  // MCP in the BridgeResult and the orchestrator gets visual ground
  // truth in the agent_do reply (instead of having to chain a
  // screen_screenshot, which the small Holo3 model often skips).
  let lastPng: Buffer | undefined;

  const baseEvents = await (sessionId
    ? buildEvents(sessionId)
    : buildEvents(""));
  const events: AgentEvents = {
    onStatus: async (text) => {
      transcript.push(`${elapsed()} status: ${text}`);
      await baseEvents.onStatus(text);
    },
    onThought: async (text) => {
      transcript.push(`${elapsed()} thought: ${text}`);
      await baseEvents.onThought(text);
    },
    onGround: async (coords) => {
      await baseEvents.onGround(coords);
    },
    onAction: async (action) => {
      stepCount += 1;
      const payload =
        action.payload && Object.keys(action.payload).length > 0
          ? ` ${JSON.stringify(action.payload).slice(0, 120)}`
          : "";
      transcript.push(`${elapsed()} action: ${action.type}${payload}`);
      await baseEvents.onAction(action);
    },
    onScreenshot: async (png) => {
      lastPng = png;
      await baseEvents.onScreenshot(png);
    },
    onError: async (message) => {
      transcript.push(`${elapsed()} error: ${message}`);
      await baseEvents.onError(message);
    },
    // onResult is optional on AgentEvents; baseEvents doesn't define
    // one, so we just collect into the transcript.
    onResult: async (text) => {
      transcript.push(`${elapsed()} result: ${text}`);
    },
  };

  let outcome: "done" | "cancelled" | "exhausted" = "exhausted";
  let errorMessage: string | undefined;
  try {
    outcome = await runTask({
      task: prompt,
      provider: warmup.getProvider(),
      events,
      shouldCancel: () => cancelFlag,
      // VISION-ONLY for MCP-forwarded calls: the orchestrator handles
      // browser_* directly, and the inner loop's router would otherwise
      // bias the agent toward Chrome navigation when the actual task
      // (file picker, native dialog) is OS-level.
      browser: null,
      router: null,
      // FLAT: agent_do is "ONE atomic OS-level mouse step" by contract.
      // The Ollama hierarchical planner over-decomposes one-step inputs
      // into wrong subtasks ("Open Chrome" when Chrome is already open,
      // "Marietta GA $3000" verbatim from its own few-shot example),
      // which produced the dock-icon spin loops in the wild. Skip the
      // planner entirely. See loop.ts RunOptions.flat.
      flat: true,
      // Optional macOS window crop. When set, every screenshot the loop
      // takes is cropped to the front window of `targetApp` before
      // being sent to plan/ground — empirically ~6× wall-time
      // reduction on /ground/batch and a comparable reduction on
      // /plan because image-patch tokens scale with pixel count. See
      // src/agent/loop.ts maybeCropToTargetApp.
      targetApp,
      onBrowserSnapshot: (snap) => {
        lastSnapshot = snap;
      },
    });
  } catch (e: unknown) {
    errorMessage = e instanceof Error ? e.message : String(e);
    buddySay("error", errorMessage);
  }

  // Per-outcome advisory line. The orchestrator (outer Claude) routinely
  // misreads `exhausted` as "the task failed" and either gives up or fires
  // another agent_do without observing — but exhausted is the most common
  // shape for "the goal already landed and the brain didn't recognize
  // completion before anti-loop fired" (e.g., file picker closed and
  // upload thumbnail appeared, but the brain emitted dock-clicks). Force
  // the orchestrator to observe before deciding the next move. Same
  // applies to cancelled (timeout / user stop) — final state is unknown
  // until observed. Mirrors the same advisory in src/mcp/tools.ts.
  const advisory = errorMessage
    ? null
    : outcome === "exhausted"
      ? "\nNOTE: 'exhausted' is NOT the same as failure. The goal may already be partially or fully achieved — the inner brain sometimes emits useless actions after success because it can't always recognize completion from the screen alone. Before retrying or reporting failure, call browser_snapshot AND screen_screenshot, then check whether the goal is already done."
      : outcome === "cancelled"
        ? "\nNOTE: 'cancelled' means the run stopped mid-flight (timeout or user stop). The final state is unknown until observed — call browser_snapshot AND screen_screenshot before deciding the next move."
        : null;

  const finalText = errorMessage
    ? `Bridge run failed: ${errorMessage}`
    : `Outcome: ${outcome}\nSteps: ${stepCount}${
        advisory ?? ""
      }${lastSnapshot ? `\nFinal URL: ${lastSnapshot.url}` : ""}`;
  if (sessionId && convex) {
    try {
      await convex.mutation(convexApi.steps.append, {
        sessionId: sessionId as never,
        kind: "result",
        text: finalText,
      });
      await convex.mutation(convexApi.sessions.setStatus, {
        sessionId: sessionId as never,
        status: errorMessage
          ? "error"
          : outcome === "done"
            ? "done"
            : outcome === "cancelled"
              ? "cancelled"
              : "error",
        error: errorMessage,
      });
    } catch (e) {
      console.warn(
        `[bridge] convex finalize failed (${e instanceof Error ? e.message : String(e)})`,
      );
    }
  }
  activeSessionId = null;
  broadcastState();
  setBuddyMode("hidden");

  // Include the latched final-frame PNG in the bridge response. The MCP
  // attaches it as an image content part to the agent_do tool reply so
  // the orchestrator gets visual ground truth in the same call. Skipped
  // when the run errored before any frame was captured.
  const finalScreenshotBase64 =
    lastPng && !errorMessage ? lastPng.toString("base64") : undefined;

  return {
    outcome: errorMessage ? "error" : outcome,
    sessionId,
    steps: stepCount,
    finalUrl: lastSnapshot?.url,
    errorMessage,
    transcript,
    finalScreenshotBase64,
  };
}

// ── HTTP bridge server (127.0.0.1 only) ──────────────────────────────
//
// MCP probes :7900/health to detect the bridge; if alive, it POSTs
// /agent_do { task } and returns the response. localhost-only so no
// remote attack surface; no auth needed.

const BRIDGE_PORT = Number(process.env.PONDER_BRIDGE_PORT ?? 7900);
let _bridgeServerStarted = false;

function startBridgeServer(): void {
  if (_bridgeServerStarted) return;
  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    const method = req.method ?? "GET";
    res.setHeader("Content-Type", "application/json");
    // GET /version → { commit, commitShort, dirty, builtAt }
    //
    // Same shape as the MCP server's holo3_version tool. Lets a
    // session verify that the running Electron bridge has the
    // expected commit loaded — critical when bridge changes are
    // shipped but the user might not have restarted the Electron
    // process. Without this endpoint there's no programmatic way
    // to tell whether new electron/main.ts or src/agent/loop.ts
    // code is actually in memory.
    if (method === "GET" && url === "/version") {
      void (async () => {
        try {
          const { BUILD_INFO } = await import("../src/mcp/build-info");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(BUILD_INFO));
        } catch (e) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              commit: "unknown",
              commitShort: "unknown",
              dirty: false,
              builtAt: new Date(0).toISOString(),
              error: e instanceof Error ? e.message : String(e),
            }),
          );
        }
      })();
      return;
    }

    if (method === "GET" && url === "/health") {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          ok: true,
          provider: providerName,
          warmup: warmup.getState(),
          activeSessionId,
        }),
      );
      return;
    }
    if (method === "POST" && url === "/agent_do") {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
        // Hard cap to prevent runaway memory if a misbehaving client
        // sends a huge prompt.
        if (body.length > 64_000) {
          res.writeHead(413);
          res.end(JSON.stringify({ error: "task too large (>64k)" }));
          req.destroy();
        }
      });
      req.on("end", () => {
        void (async () => {
          try {
            const parsed = JSON.parse(body) as {
              task?: unknown;
              targetApp?: unknown;
            };
            const task = typeof parsed.task === "string" ? parsed.task : "";
            const targetApp =
              typeof parsed.targetApp === "string" &&
              parsed.targetApp.trim().length > 0
                ? parsed.targetApp.trim()
                : undefined;
            if (!task.trim()) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: "empty task" }));
              return;
            }
            const result = await chainBridge(() =>
              runAgentTaskForBridge({ prompt: task, targetApp }),
            );
            res.writeHead(200);
            res.end(JSON.stringify(result));
          } catch (e: unknown) {
            res.writeHead(500);
            res.end(
              JSON.stringify({
                error: e instanceof Error ? e.message : String(e),
              }),
            );
          }
        })();
      });
      return;
    }

    // ── screen_* forwarding endpoints ────────────────────────────────
    //
    // The MCP server runs in Claude Code's process, which often does NOT
    // have macOS Screen Recording / Accessibility perms. The orchestrator
    // sees BLANK screenshots and silent keystrokes — and then makes
    // increasingly bad decisions because it can't see the screen. The
    // Electron app DOES have those perms, so we expose the screen.*
    // primitives over the bridge and the MCP forwards to them when
    // available. Round-trip is ~5–20ms over localhost — cheaper than
    // the existing 1.5s probe by an order of magnitude once cached on
    // the MCP side.
    //
    // POST /screen/screenshot      → { pngBase64, width, height, offsetX, offsetY }
    // POST /screen/type            → { text, thenPress? } → { ok: true }
    // POST /screen/hotkey          → { combo } → { ok: true }
    // POST /screen/scroll          → { direction, amount? } → { ok: true }
    // POST /screen/click           → { x, y, mode? } → { ok: true }
    // POST /screen/drag            → { fromX, fromY, toX, toY } → { ok: true }
    const readJsonBody = (cb: (parsed: unknown, err?: string) => void): void => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
        if (body.length > 64_000) {
          res.writeHead(413);
          res.end(JSON.stringify({ error: "body too large" }));
          req.destroy();
        }
      });
      req.on("end", () => {
        try {
          cb(body.length > 0 ? JSON.parse(body) : {});
        } catch (e) {
          cb(null, e instanceof Error ? e.message : String(e));
        }
      });
    };

    if (method === "POST" && url === "/screen/screenshot") {
      void (async () => {
        try {
          const shot = await captureScreenshot();
          res.writeHead(200);
          res.end(
            JSON.stringify({
              pngBase64: shot.png.toString("base64"),
              width: shot.width,
              height: shot.height,
              offsetX: shot.offsetX,
              offsetY: shot.offsetY,
            }),
          );
        } catch (e) {
          res.writeHead(500);
          res.end(
            JSON.stringify({
              error: e instanceof Error ? e.message : String(e),
            }),
          );
        }
      })();
      return;
    }

    if (method === "POST" && url === "/screen/type") {
      readJsonBody((parsed, err) => {
        if (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `bad JSON: ${err}` }));
          return;
        }
        const { text, thenPress } = (parsed as {
          text?: unknown;
          thenPress?: unknown;
        }) ?? {};
        if (typeof text !== "string") {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "text must be a string" }));
          return;
        }
        void (async () => {
          try {
            await screenTypeText(text);
            if (typeof thenPress === "string" && thenPress) {
              await new Promise((r) => setTimeout(r, 120));
              await screenPressCombo(thenPress);
            }
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.writeHead(500);
            res.end(
              JSON.stringify({
                error: e instanceof Error ? e.message : String(e),
              }),
            );
          }
        })();
      });
      return;
    }

    if (method === "POST" && url === "/screen/hotkey") {
      readJsonBody((parsed, err) => {
        if (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `bad JSON: ${err}` }));
          return;
        }
        const { combo } = (parsed as { combo?: unknown }) ?? {};
        if (typeof combo !== "string" || !combo) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "combo must be a non-empty string" }));
          return;
        }
        void (async () => {
          try {
            await screenPressCombo(combo);
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.writeHead(500);
            res.end(
              JSON.stringify({
                error: e instanceof Error ? e.message : String(e),
              }),
            );
          }
        })();
      });
      return;
    }

    // POST /screen/click → { x, y, mode? } → { ok: true }
    //   Where mode is "single" (default) | "double" | "right" | "triple".
    //   Coordinates are SCREEN-space (multi-monitor offsets already added
    //   by the caller — same convention as the loop's nut-js path).
    if (method === "POST" && url === "/screen/click") {
      readJsonBody((parsed, err) => {
        if (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `bad JSON: ${err}` }));
          return;
        }
        const p = (parsed as {
          x?: unknown;
          y?: unknown;
          mode?: unknown;
        }) ?? {};
        if (typeof p.x !== "number" || typeof p.y !== "number") {
          res.writeHead(400);
          res.end(
            JSON.stringify({ error: "x and y must be numbers" }),
          );
          return;
        }
        const mode =
          p.mode === "double" || p.mode === "right" || p.mode === "triple"
            ? p.mode
            : "single";
        void (async () => {
          try {
            await screenClick(p.x as number, p.y as number, {
              double: mode === "double",
              triple: mode === "triple",
              button: mode === "right" ? "right" : "left",
            });
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, x: p.x, y: p.y, mode }));
          } catch (e) {
            res.writeHead(500);
            res.end(
              JSON.stringify({
                error: e instanceof Error ? e.message : String(e),
              }),
            );
          }
        })();
      });
      return;
    }

    // POST /screen/drag → { fromX, fromY, toX, toY } → { ok: true }
    //   Press at (fromX, fromY), drag to (toX, toY), release. Coordinates
    //   are SCREEN-space (multi-monitor offsets already added by caller).
    //   NOTE: drag inherently moves the visible cursor even in BACKGROUND
    //   mode — there's no way to post drag CGEvents at coords without
    //   moving. The user's mouse gets hijacked for ~200-400ms.
    if (method === "POST" && url === "/screen/drag") {
      readJsonBody((parsed, err) => {
        if (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `bad JSON: ${err}` }));
          return;
        }
        const p = (parsed as {
          fromX?: unknown;
          fromY?: unknown;
          toX?: unknown;
          toY?: unknown;
        }) ?? {};
        if (
          typeof p.fromX !== "number" ||
          typeof p.fromY !== "number" ||
          typeof p.toX !== "number" ||
          typeof p.toY !== "number"
        ) {
          res.writeHead(400);
          res.end(
            JSON.stringify({
              error: "fromX, fromY, toX, toY must all be numbers",
            }),
          );
          return;
        }
        void (async () => {
          try {
            await screenDrag(
              p.fromX as number,
              p.fromY as number,
              p.toX as number,
              p.toY as number,
            );
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.writeHead(500);
            res.end(
              JSON.stringify({
                error: e instanceof Error ? e.message : String(e),
              }),
            );
          }
        })();
      });
      return;
    }

    // POST /browser/url → { processName } → { url, title } | { error }
    //
    // Get the URL + title of the front tab of the named browser
    // (Google Chrome, Safari, Firefox). Uses AppleScript via the
    // bridge's existing Accessibility / Automation grant — the MCP
    // server's tsx process can't run this directly. Required for
    // the loop's verifier to compare task expectations against
    // actual page state (the May-11 bench's false-positive DONE
    // happened because the verifier couldn't see that the URL was
    // facebook.com/marketplace/you instead of /marketplace/search).
    //
    // Returns:
    //   { url: "https://...", title: "Page Title" } on success
    //   { error: "..." } on any failure (browser not running, no
    //     active tab, Automation perms denied, parse failure)
    if (method === "POST" && url === "/browser/url") {
      readJsonBody((parsed, err) => {
        if (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `bad JSON: ${err}` }));
          return;
        }
        const { processName } = (parsed as { processName?: unknown }) ?? {};
        if (typeof processName !== "string" || processName.trim().length === 0) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "processName required" }));
          return;
        }
        if (/["\\\n\r]/.test(processName)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "processName contains invalid characters" }));
          return;
        }
        if (process.platform !== "darwin") {
          res.writeHead(200);
          res.end(JSON.stringify({ error: "non-darwin platform" }));
          return;
        }
        // Two-tier strategy:
        //   1) Try `tell application "<browser>"` for full URL + title.
        //      Requires macOS Automation permission (Electron → Chrome).
        //   2) If that fails (perms denied is the common case — Automation
        //      and Accessibility are separate TCC grants), fall back to
        //      reading the window title via System Events. Only needs
        //      Accessibility (which we already have for /window/bounds).
        //      Window titles like "Search results for bulbasaur -
        //      Facebook Marketplace" carry enough info for the verifier
        //      to compare against task expectations.
        const lower = processName.toLowerCase();
        let appScript: string | null = null;
        if (lower === "google chrome" || lower === "chrome") {
          appScript = `tell application "Google Chrome"\nreturn (URL of active tab of front window) & "\\t" & (title of active tab of front window)\nend tell`;
        } else if (lower === "safari") {
          appScript = `tell application "Safari"\nreturn (URL of current tab of front window) & "\\t" & (name of current tab of front window)\nend tell`;
        }

        const fallbackScript = `tell application "System Events"\ntell process "${processName}"\nreturn name of front window\nend tell\nend tell`;

        const runAndParse = (
          script: string,
          isFallback: boolean,
          done: (resp: object) => void,
        ): void => {
          execFile(
            "/usr/bin/osascript",
            ["-e", script],
            { timeout: 1500, encoding: "utf-8" },
            (e, stdout, stderr) => {
              if (e) {
                done({
                  ok: false,
                  detail:
                    (stderr && String(stderr).trim()) ||
                    (e instanceof Error ? e.message : String(e)),
                });
                return;
              }
              const out = String(stdout).trim();
              if (isFallback) {
                // Title-only fallback. Set url to empty so callers
                // know to compare against title only.
                done({ ok: true, url: "", title: out });
              } else {
                const sep = out.indexOf("\t");
                done({
                  ok: true,
                  url: sep >= 0 ? out.slice(0, sep) : out,
                  title: sep >= 0 ? out.slice(sep + 1) : "",
                });
              }
            },
          );
        };

        const tryAppScript = appScript;
        if (tryAppScript) {
          runAndParse(tryAppScript, false, (first) => {
            const r = first as { ok: boolean; url?: string; title?: string; detail?: string };
            if (r.ok && r.url) {
              res.writeHead(200);
              res.end(JSON.stringify({ url: r.url, title: r.title ?? "" }));
              return;
            }
            // App-script failed (typically Automation perm denied).
            // Fall back to title-via-System-Events.
            runAndParse(fallbackScript, true, (second) => {
              const r2 = second as { ok: boolean; url?: string; title?: string; detail?: string };
              if (r2.ok && r2.title) {
                res.writeHead(200);
                res.end(
                  JSON.stringify({
                    url: "",
                    title: r2.title,
                    fallback: "title-only (Automation perm denied; granting Electron → Google Chrome in System Settings → Privacy → Automation unlocks full URL)",
                  }),
                );
                return;
              }
              res.writeHead(200);
              res.end(
                JSON.stringify({
                  error: "osascript_failed",
                  detail: r.detail ?? r2.detail ?? "both AppleScript paths failed",
                }),
              );
            });
          });
        } else {
          // Unsupported browser — try title-only fallback as a best effort.
          runAndParse(fallbackScript, true, (resp) => {
            const r = resp as { ok: boolean; title?: string; detail?: string };
            if (r.ok && r.title) {
              res.writeHead(200);
              res.end(
                JSON.stringify({ url: "", title: r.title, fallback: "title-only (unsupported browser)" }),
              );
              return;
            }
            res.writeHead(200);
            res.end(
              JSON.stringify({ error: "osascript_failed", detail: r.detail ?? "title fallback failed" }),
            );
          });
        }
      });
      return;
    }

    // POST /window/raise → { processName } → { ok: true } | { error }
    //
    // Bring the named macOS process to the front BEFORE we screenshot.
    // Critical for targetApp cropping: getMacWindowBounds returns the
    // target's logical position regardless of Z-order, but the
    // desktopCapturer screenshot captures whatever is rendered on top.
    // If targetApp is buried under another window, the crop captures
    // the OCCLUDING window's pixels at the target's coords, the
    // vision model grounds against THOSE, and clicks land in the
    // wrong UI entirely. Observed May-11: cropping at Calculator's
    // bounds captured Ponder's own session list (Calculator was
    // occluded), the brain saw "47 × 8" in a session title, emitted
    // 6 clicks at the same corner of the Ponder UI, and the verifier
    // FALSE-POSITIVED on "VERIFIED" because the text was visible.
    //
    // The bridge process has macOS Accessibility granted (it's the
    // app the user added in System Settings → Privacy → Accessibility),
    // so osascript activate works here even though it would 100% fail
    // from the MCP server's tsx context. Same proxy pattern as
    // /window/bounds.
    if (method === "POST" && url === "/window/raise") {
      readJsonBody((parsed, err) => {
        if (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `bad JSON: ${err}` }));
          return;
        }
        const { processName } = (parsed as { processName?: unknown }) ?? {};
        if (
          typeof processName !== "string" ||
          processName.trim().length === 0
        ) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "processName required (string)" }));
          return;
        }
        if (/["\\\n\r]/.test(processName)) {
          res.writeHead(400);
          res.end(
            JSON.stringify({ error: "processName contains invalid characters" }),
          );
          return;
        }
        if (process.platform !== "darwin") {
          res.writeHead(200);
          res.end(JSON.stringify({ ok: false, error: "non-darwin platform" }));
          return;
        }
        // `activate` on the application itself is the right verb —
        // System Events' `set frontmost` requires per-window scripting
        // and is flakier. Application activate is also faster (~30ms).
        const script = `tell application "${processName}" to activate`;
        execFile(
          "/usr/bin/osascript",
          ["-e", script],
          { timeout: 1500, encoding: "utf-8" },
          (e, _stdout, stderr) => {
            if (e) {
              res.writeHead(200);
              res.end(
                JSON.stringify({
                  ok: false,
                  error: "osascript_failed",
                  detail:
                    (stderr && String(stderr).trim()) ||
                    (e instanceof Error ? e.message : String(e)),
                }),
              );
              return;
            }
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
          },
        );
      });
      return;
    }

    // POST /window/bounds → { processName } → { x, y, width, height } | { error }
    //
    // Proxy for `osascript -e 'tell process "<name>" to get position+size of
    // window 1'`, exposed here so callers in the MCP server (which runs in a
    // separate tsx process WITHOUT macOS Accessibility permissions) can use
    // THIS process's existing Accessibility grant. The bridge is the only
    // process the user grants Accessibility to in System Settings; routing
    // window-bounds queries through here closes that perms gap for the
    // `agent_click_sequence` `targetApp` cropping path.
    //
    // Returns { error: "missing"|"nowindow"|"perm_denied"|<message> } on
    // failure (caller treats any error as "fall back to uncropped").
    if (method === "POST" && url === "/window/bounds") {
      readJsonBody((parsed, err) => {
        if (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `bad JSON: ${err}` }));
          return;
        }
        const { processName } = (parsed as { processName?: unknown }) ?? {};
        if (typeof processName !== "string" || processName.trim().length === 0) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "processName required (string)" }));
          return;
        }
        // Defensive: reject characters that could escape AppleScript string
        // quoting. Legitimate macOS process names don't carry quotes,
        // backslashes, or newlines.
        if (/["\\\n\r]/.test(processName)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "processName contains invalid characters" }));
          return;
        }
        if (process.platform !== "darwin") {
          res.writeHead(200);
          res.end(JSON.stringify({ error: "non-darwin platform" }));
          return;
        }
        const script =
          `tell application "System Events"\n` +
          `  if not (exists process "${processName}") then return "missing"\n` +
          `  tell process "${processName}"\n` +
          `    if (count of windows) is 0 then return "nowindow"\n` +
          `    set p to position of front window\n` +
          `    set s to size of front window\n` +
          `    return (item 1 of p as integer) & "," & (item 2 of p as integer) & "," & (item 1 of s as integer) & "," & (item 2 of s as integer)\n` +
          `  end tell\n` +
          `end tell`;
        // Tight 1.5s timeout — perms-granted queries return in ~50ms;
        // perms-denied hangs until the system prompt is dismissed (default
        // 2 minutes), which is way too long for an interactive sequence.
        execFile(
          "/usr/bin/osascript",
          ["-e", script],
          { timeout: 1500, encoding: "utf-8" },
          (e, stdout, stderr) => {
            if (e) {
              res.writeHead(200);
              res.end(
                JSON.stringify({
                  error: "osascript_failed",
                  detail:
                    (stderr && String(stderr).trim()) ||
                    (e instanceof Error ? e.message : String(e)),
                }),
              );
              return;
            }
            const out = String(stdout).trim();
            if (out === "missing" || out === "nowindow") {
              res.writeHead(200);
              res.end(JSON.stringify({ error: out }));
              return;
            }
            // AppleScript's `&` operator on integers produces a LIST, not a
            // string — so `(item 1 of p) & "," & (item 2 of p) & ...` returns
            // `{690, ",", 334, ",", 230, ",", 408}` which serializes with
            // ", " separators as `"690, ,, 334, ,, 230, ,, 408"`. Splitting
            // on comma yields 7 fragments with 3 empties. Robust fix: pull
            // any signed integers out of the output via regex. Works
            // regardless of how AppleScript renders the list.
            const nums = (out.match(/-?\d+/g) ?? []).map(Number);
            if (nums.length < 4 || nums.some((n) => !Number.isFinite(n))) {
              res.writeHead(200);
              res.end(
                JSON.stringify({ error: "parse_failed", detail: out }),
              );
              return;
            }
            const [x, y, w, h] = nums as [number, number, number, number];
            if (w <= 0 || h <= 0) {
              res.writeHead(200);
              res.end(JSON.stringify({ error: "zero_size" }));
              return;
            }
            res.writeHead(200);
            res.end(JSON.stringify({ x, y, width: w, height: h }));
          },
        );
      });
      return;
    }

    if (method === "POST" && url === "/screen/scroll") {
      readJsonBody((parsed, err) => {
        if (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `bad JSON: ${err}` }));
          return;
        }
        const { direction, amount } = (parsed as {
          direction?: unknown;
          amount?: unknown;
        }) ?? {};
        if (direction !== "up" && direction !== "down") {
          res.writeHead(400);
          res.end(
            JSON.stringify({ error: "direction must be 'up' or 'down'" }),
          );
          return;
        }
        const SCROLL_FLOOR = 50;
        const ticks = Math.max(
          SCROLL_FLOOR,
          typeof amount === "number" ? amount : SCROLL_FLOOR,
        );
        const signed = direction === "up" ? ticks : -ticks;
        void (async () => {
          try {
            await screenScroll(signed);
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, ticks }));
          } catch (e) {
            res.writeHead(500);
            res.end(
              JSON.stringify({
                error: e instanceof Error ? e.message : String(e),
              }),
            );
          }
        })();
      });
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  });
  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") {
      console.warn(
        `[bridge] port ${BRIDGE_PORT} already in use — another Holo3 instance? MCP forwarding will fail; close the other instance and restart.`,
      );
    } else {
      console.warn(
        `[bridge] http server error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  });
  server.listen(BRIDGE_PORT, "127.0.0.1", () => {
    _bridgeServerStarted = true;
    console.log(
      `[bridge] listening on http://127.0.0.1:${BRIDGE_PORT} — MCP can now forward agent_do here`,
    );
  });
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

    // Per-run state retained for the extractor:
    //   • runHistory — every action string the planner emitted, in order
    //   • lastShot — most recent screenshot bytes (used when no Chrome
    //     snapshot is available)
    //   • lastSnapshot — most recent Playwriter accessibility tree (used
    //     in preference to the screenshot when Chrome was active)
    //
    // These fill via callbacks from the loop, so we don't have to parse
    // the events stream a second time after the run completes.
    const runHistory: string[] = [];
    let lastShot: Buffer | undefined;
    let lastSnapshot: BrowserSnapshot | undefined;

    try {
      const result = await runTask({
        task: prompt,
        provider: warmup.getProvider(),
        events,
        shouldCancel: () => cancelFlag,
        browser: browserClient,
        router,
        onBrowserSnapshot: (snap) => {
          lastSnapshot = snap;
        },
        onHistory: (action) => {
          runHistory.push(action);
        },
        onScreenshotBuffer: (png) => {
          lastShot = png;
        },
      });

      const summaryOutcome =
        result === "done"
          ? "done"
          : result === "cancelled"
            ? "cancelled"
            : "exhausted";

      // Extractor — the conversational answer. ALWAYS runs (except on
      // cancel) and ALWAYS returns a string thanks to the templated
      // fallback inside extractor.ts, so the buddy never goes silent.
      //
      // We deliberately do NOT call narrator.summary() afterward: the
      // extractor's reply IS the conversational summary, and a follow-up
      // narrator line would overwrite the answer bubble within a second.
      // Better one substantive answer than answer-then-stomped-by-fluff.
      if (result !== "cancelled") {
        buddySay("status", "Reading the result…");
        // Best-effort fresh browser snapshot (page may have just settled).
        // Failures fall through to whatever lastSnapshot already held.
        let pageText: string | undefined;
        if (browserClient && (await browserClient.available().catch(() => false))) {
          try {
            lastSnapshot = await browserClient.snapshot();
          } catch (e) {
            console.warn(
              `[extract] re-snapshot failed (${e instanceof Error ? e.message : String(e)}) — using previous`,
            );
          }
          // Scrape the FULL page text so the closer has real listing
          // content (titles, prices, locations) to summarize from. The
          // accessibility tree by itself only carries roles+names; for an
          // informational answer like "find 3 Camrys under $3k" the
          // closer needs the actual page copy. readText() caps at 50KB
          // internally so this is safe even on long Marketplace result
          // pages. We swallow errors — pageText is optional context;
          // the extractor degrades gracefully to history+snapshot only.
          try {
            pageText = await browserClient.readText();
            console.log(
              `[extract] page text scraped (${pageText.length}b) — feeding to closer`,
            );
          } catch (e) {
            console.warn(
              `[extract] readText failed (${e instanceof Error ? e.message : String(e)}) — closer will work from snapshot+history only`,
            );
          }
        }
        const extractor = createExtractor(warmup.getProvider());
        const ctrl = new AbortController();
        const cancelTick = setInterval(() => {
          if (cancelFlag) ctrl.abort();
        }, 100);

        // extractor.extract() never throws — it has a templated fallback
        // baked in. We catch defensively anyway so a wild bug can't kill
        // the post-run path.
        let answer: string;
        try {
          answer = await extractor.extract({
            task: prompt,
            history: runHistory,
            lastScreenshotB64: lastShot?.toString("base64") ?? "",
            browserSnapshot: lastSnapshot,
            pageText,
            outcome: summaryOutcome,
            signal: ctrl.signal,
          });
        } catch (e) {
          console.warn(
            `[extract] threw unexpectedly (${e instanceof Error ? e.message : String(e)}) — synthesizing fallback`,
          );
          answer =
            summaryOutcome === "exhausted"
              ? `Got stuck before finishing "${prompt}". Try a more specific prompt.`
              : `Done — ${runHistory.slice(-3).join(" → ") || "no actions recorded"}.`;
        } finally {
          clearInterval(cancelTick);
        }

        if (answer && answer.trim()) {
          // Show in the buddy bubble. "answer" kind has a 60s fade in
          // Buddy.tsx so multi-line list answers stay visible long
          // enough to read.
          buddySay("answer", answer);
          // Persist to Convex. Failures here MUST NOT block — the user
          // already saw the answer; we just want the History view to
          // include it. If the deployed Convex schema is stale (no
          // "result" kind yet), this throws ArgumentValidationError and
          // we log + move on.
          if (sessionId && convex) {
            try {
              await convex.mutation(convexApi.steps.append, {
                sessionId: sessionId as never,
                kind: "result",
                text: answer,
              });
            } catch (e) {
              console.warn(
                `[extract] convex persist failed (${e instanceof Error ? e.message : String(e)}) — answer is in the buddy bubble but won't appear in History until you redeploy convex schema (run \`npx convex dev\`)`,
              );
            }
          }
        }
      }
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
        .summary({ task: prompt, outcome: "error", history: runHistory, error: message })
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
    if (process.platform === "darwin") tray.setTitle("◐ Ponder"); //Tray title
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
    // Still persist — the user may have flipped to another provider in
    // a previous session and the preference file might be stale.
    setProviderPreference(name);
    return;
  }
  console.log(`[provider] switching: ${providerName} → ${name}`);
  providerName = name;
  // Persist so the MCP server (separate process spawned by Claude Code)
  // sees the new pick on its next agent_do call. Without this the MCP
  // would re-derive provider from env vars on every call, ignoring the
  // user's tray-menu choice.
  setProviderPreference(name);
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

/**
 * Open (or focus) the History window. Idempotent — first call creates
 * the window and Electron's `ready-to-show` event fires `.show()` once
 * the renderer has mounted; subsequent calls bring the existing window
 * to the front.
 *
 * Old code called `.show() + .focus()` immediately after createAppWindow,
 * but the window isn't actually visible yet at that point — Electron's
 * `ready-to-show` event fires asynchronously after the renderer mounts
 * (~100-300ms). Calling `.show()` before that is a no-op, which is why
 * the tray menu used to require two clicks: first click created the
 * window (silent show no-op), second click found the existing window
 * and `.show()` worked. Now we let `ready-to-show` handle the first
 * appearance and only force-show when the window already exists.
 */
function openHistoryWindow(): void {
  if (!appWin || appWin.isDestroyed()) {
    appWin = createAppWindow();
    // ready-to-show in createAppWindow handles the first .show().
    // Add focus once the window is visible so it pops to the foreground
    // instead of mounting behind everything.
    appWin.once("ready-to-show", () => {
      appWin?.focus();
      if (process.platform === "darwin") app.focus({ steal: true });
    });
    return;
  }
  // Window already exists — bring it forward.
  if (appWin.isMinimized()) appWin.restore();
  appWin.show();
  appWin.focus();
  if (process.platform === "darwin") app.focus({ steal: true });
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
      label: "Open History (⌘⇧H)",
      accelerator: "CommandOrControl+Shift+H",
      click: () => openHistoryWindow(),
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
  startBridgeServer();

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

  // HISTORY — ⌘⇧H opens the History window from anywhere. Same code path
  // as the tray menu's "Open History…" item, so first-press latency is
  // identical and the keystroke is discoverable in the menu's accelerator.
  const historyAccel = "CommandOrControl+Shift+H";
  const okHistory = globalShortcut.register(historyAccel, () =>
    openHistoryWindow(),
  );
  if (!okHistory) {
    console.warn(`History hotkey (${historyAccel}) failed to register.`);
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
