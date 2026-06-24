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
import { extractRows } from "../src/agent/extract";
import { scrollToLoadAll } from "../src/agent/scroll-load";
import type { RouterClient } from "../src/agent/router";
import type { AgentEvents, ProviderName } from "../src/agent/types";
import type { BrowserClient, BrowserSnapshot } from "../src/agent/browser/types";
import { createPlaywriterClient } from "../src/agent/browser/playwriter";
import {
  computeDefaultProvider,
  executorNameFor,
  isProviderConfigured,
  makeProvider,
  makeRouter,
  humanProviderLabel,
} from "../src/agent/factory";
import { plannerConfigFromEnv } from "../src/agent/providers/planner";
import {
  setProviderPreference,
  getEnginePreference,
  setEnginePreference,
  getAutoReplayPreference,
  setAutoReplayPreference,
  type AgentEngine,
} from "../src/agent/preferences";
import { runAgpTask } from "../src/agent/agp/loop";
import { AgpClient } from "../src/agent/agp/client";
import { WarmupQueue } from "../src/agent/warmup";
import {
  probe as probePerms,
  requestAccessibility,
  requestScreenRecording,
} from "../src/perms";
import {
  verifyToken,
  scopeAllowed,
  touchKeySync,
  audit,
  readKeysSync,
  isMagicMode,
} from "../src/bridge/auth";
import {
  loadRecipe,
  listRecipes,
  findRecipeByTask,
  pathsFor as recipePathsFor,
  saveRecipe,
  recipeFromConvexSteps,
  buildRecipeFromTrace,
  recordAction,
  createRecipeRecorder,
  type RecipeRecorder,
} from "../src/agent/recorder";
import { PonderError } from "../src/errors";

// The Playwriter relay binds :19988. When the MCP server (Claude Code) is also
// running it already owns that port — the reuse probe normally catches this,
// but server.listen()'s EADDRINUSE surfaces as an 'error' EVENT, not a promise
// rejection, so it escapes the relay-start .catch() and would crash the app.
// Swallow exactly that case (a relay is already up → we reuse it) instead of
// dying on launch. Anything else re-throws.
process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
  if (err?.code === "EADDRINUSE" && /19988/.test(err.message ?? "")) {
    console.warn("[browser] :19988 already in use — reusing the existing Playwriter relay");
    return;
  }
  throw err;
});

/** Shared JSON body reader used by the new /browser/* + /recipe/*
 *  endpoints. Caps payload at 64KB so a misbehaving client can't OOM
 *  the bridge. Calls back with the parsed value (or `null` on empty)
 *  on success; sends a 400 response and skips the callback on error. */
function readJsonBodyEarly(
  req: IncomingMessage,
  res: ServerResponse,
  cb: (parsed: unknown) => void,
): void {
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
      cb(body.length > 0 ? JSON.parse(body) : null);
    } catch (e) {
      res.writeHead(400);
      res.end(
        JSON.stringify({
          code: "INTERNAL_ERROR",
          message: `Bad JSON: ${e instanceof Error ? e.message : String(e)}`,
        }),
      );
    }
  });
}
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
// AGP runs cancel by aborting this signal (the composite loop polls cancelFlag
// instead). The agent:cancel handler trips both so one Stop button covers both.
let agpAbort: AbortController | null = null;
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

// The most recent app-initiated run, captured as a recipe recorder so the user
// can "Save as automation" after the fact (the tray records every run; saving
// just freezes the last one to ~/.ponder/recipes/). Reset at each run start.
let lastRunRecorder: RecipeRecorder | null = null;
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
      title: "Anorha ready",
      body: `${humanProviderLabel(providerName)} ready.`,
    }).show();
  }
});

function broadcastState(extra: Partial<AgentStateMsg> = {}): void {
  const msg: AgentStateMsg = {
    warmup: warmup.getState(),
    provider: executorNameFor(providerName),
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
  if (!convex || !sessionId) {
    // Convex unavailable (or no session id — e.g. session create failed) —
    // still pipe everything to the buddy so the UI doesn't go silent, and
    // never write steps against an empty session id.
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
  // `infeasible` is a CORRECT terminal answer for trap tasks (the goal
  // genuinely can't be done) — bench/run.ts forwards it as OUTCOME so
  // T5 cases score. Distinct from `error` (the run itself broke).
  outcome: "done" | "cancelled" | "exhausted" | "infeasible" | "error";
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
  opts:
    | {
        prompt: string;
        targetApp?: string;
        maxSteps?: number;
        decompose?: boolean;
      }
    | string,
): Promise<BridgeResult> {
  // Backwards-compat: prior callers passed a bare prompt string.
  const { prompt, targetApp, maxSteps, decompose } =
    typeof opts === "string"
      ? {
          prompt: opts,
          targetApp: undefined,
          maxSteps: undefined,
          decompose: undefined,
        }
      : opts;
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
        provider: executorNameFor(providerName),
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
      // 2000-char cap (was 120): the MCP side reconstructs recipe steps
      // by JSON.parsing this payload back out of the transcript line
      // (recordFromBridgeTranscript). At 120 chars any long type/text
      // payload became {_truncated:true} and the recipe lost the step's
      // data. 2000 covers realistic typed text while keeping a runaway
      // payload from flooding the transcript.
      const payload =
        action.payload && Object.keys(action.payload).length > 0
          ? ` ${JSON.stringify(action.payload).slice(0, 2000)}`
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

  let outcome: "done" | "cancelled" | "exhausted" | "infeasible" =
    "exhausted";
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
      // Per-call action budget override. Defaults to MAX_STEPS (50)
      // when not set. Long-horizon multi-app cases (e.g. the
      // honda-crv-spreadsheet-research T4) need ~40-60 steps; short
      // cases can keep the default. The bench harness reads this from
      // each case's frontmatter `max_steps:` field and passes it
      // through the /agent_do POST body.
      ...(typeof maxSteps === "number" && maxSteps > 0
        ? { maxSteps }
        : {}),
      // Declared-multi-step decomposition (NEXT-WORK Item 2). Only
      // takes effect when PONDER_DECOMPOSE is also on — see
      // loop.ts RunOptions.decompose.
      ...(decompose === true ? { decompose: true } : {}),
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
        : outcome === "infeasible"
          ? "\nNOTE: 'infeasible' is a DELIBERATE verdict — the inner agent checked and a concrete blocker (permission denied, read-only, login wall, system 'can't do that') makes this task impossible. This is the CORRECT answer for a trap/impossible task; do NOT just retry agent_do. Report the blocker to the user (it's in the transcript as 'INFEASIBLE: …') and ask how they want to proceed."
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
        // Convex's status enum has no "infeasible"; it's a terminal
        // NON-error correct answer, so map it to "done" here (the
        // verbatim "Outcome: infeasible" + reason is preserved in the
        // result step text above and in BridgeResult.outcome, which is
        // what bench/run.ts actually scores on).
        status: errorMessage
          ? "error"
          : outcome === "done" || outcome === "infeasible"
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
      // isMagicMode() reads PONDER_AUTO / PONDER_MAGIC env at call time, so a
      // user can `export PONDER_AUTO=1` after the tray launched and have it
      // take effect immediately — no runtime require needed (that broke the
      // bundle: a relative require() stays literal in out/main/index.js and
      // resolves to the non-existent out/src/bridge/auth).
      res.writeHead(200);
      res.end(
        JSON.stringify({
          ok: true,
          provider: executorNameFor(providerName),
          warmup: warmup.getState(),
          activeSessionId,
          magicMode: isMagicMode(),
        }),
      );
      return;
    }

    // ── Per-consumer auth gate ──────────────────────────────────────
    //
    // Every endpoint EXCEPT /version, /health and the legacy
    // /agent_do path (Electron <-> MCP localhost trust) requires a
    // valid Bearer token issued via `ponder grant`. Localhost-only
    // bind stays — auth adds revocability + auditability ON TOP of
    // localhost trust.
    //
    // The /agent_do, /screen/*, /browser/url, /window/*, /extract, and
    // /recipe/run endpoints are localhost-trusted (same model as the MCP
    // forwarder + the in-app browser-jobs consumer, which runs on this
    // machine). /recipe/run is strictly LESS capable than the already-exempt
    // /agent_do (it replays a saved recipe vs. open-ended vision), so the
    // desktop consumer can drive deterministic replay without minting a
    // bridge key. Mutating/management endpoints (/browser/*, /recipe/save,
    // /recipe/list, /attach) still require a Bearer token from `ponder grant`.
    const REQUIRES_AUTH = /^\/(browser\/(?:attach|snapshot|click|type|navigate|set_input_files|scroll|read)|recipe\/(?:save|list))/;
    let authState: ReturnType<typeof verifyToken> | null = null;
    if (REQUIRES_AUTH.test(url)) {
      const keyCount = readKeysSync().length;
      if (keyCount === 0) {
        // No keys ever issued — surface a clear setup error rather
        // than a vague 401. This is the common first-call shape.
        res.writeHead(401);
        res.end(
          JSON.stringify({
            code: "MISSING_AUTH",
            message:
              "No Ponder API keys have been issued yet. Run `ponder grant <name>` to mint one.",
            hint: "Then re-send the request with Authorization: Bearer <key>.",
            docs_url:
              process.env.PONDER_DOCS_BASE_URL ??
              "https://ponder.dev/docs/bridge#auth",
          }),
        );
        return;
      }
      authState = verifyToken(req.headers["authorization"]);
      if (!authState.ok) {
        res.writeHead(401);
        res.end(
          JSON.stringify({
            code: authState.code,
            message: authState.message,
            hint:
              authState.code === "MISSING_AUTH"
                ? "Issue a key with `ponder grant <name>` and re-send with Authorization: Bearer <key>."
                : "Re-issue this consumer's key with `ponder grant <name>` and update the client.",
            docs_url:
              process.env.PONDER_DOCS_BASE_URL ??
              "https://ponder.dev/docs/bridge#auth",
          }),
        );
        return;
      }
      // Touch the key + audit on response close so we charge the
      // right consumer in the audit log regardless of which branch
      // serves the request.
      const consumerName = authState.consumer;
      const startedAt = Date.now();
      res.on("close", () => {
        touchKeySync(consumerName);
        audit({
          consumer: consumerName,
          method,
          path: url,
          status: res.statusCode || 0,
          durationMs: Date.now() - startedAt,
        });
      });
    }

    // ── /browser/attach — wraps the ponder_browser_ensure behaviour ──
    if (method === "POST" && url === "/browser/attach") {
      readJsonBodyEarly(req, res, (parsed) => {
        const p = (parsed as {
          url?: unknown;
          tabHint?: unknown;
          session?: unknown;
        }) ?? {};
        void (async () => {
          try {
            const wantUrl = typeof p.url === "string" ? p.url : undefined;
            if (!browserClient || !(await browserClient.available())) {
              res.writeHead(503);
              res.end(
                JSON.stringify({
                  code: "BROWSER_NOT_ATTACHED",
                  message:
                    "Playwriter relay is not ready. The Electron app cannot " +
                    "vision-attach a tab on behalf of an HTTP consumer.",
                  hint:
                    "From the Holo3 app, attach a tab manually OR call " +
                    "ponder_browser_ensure via the MCP for the cold-start " +
                    "vision flow.",
                  docs_url:
                    process.env.PONDER_DOCS_BASE_URL ??
                    "https://ponder.dev/docs/errors/browser_not_attached",
                }),
              );
              return;
            }
            let snap = await browserClient.snapshot();
            if (wantUrl && !snap.url.startsWith(wantUrl)) {
              await browserClient.navigate(wantUrl);
              await new Promise((r) => setTimeout(r, 600));
              snap = await browserClient.snapshot();
            }
            res.writeHead(200);
            res.end(JSON.stringify({ url: snap.url, title: snap.title }));
          } catch (e) {
            res.writeHead(500);
            res.end(
              JSON.stringify({
                code: "INTERNAL_ERROR",
                message: e instanceof Error ? e.message : String(e),
              }),
            );
          }
        })();
      });
      return;
    }

    // ── /browser/snapshot ────────────────────────────────────────────
    if (method === "POST" && url === "/browser/snapshot") {
      void (async () => {
        try {
          if (!browserClient || !(await browserClient.available())) {
            res.writeHead(503);
            res.end(
              JSON.stringify({
                code: "BROWSER_NOT_ATTACHED",
                message: "Chrome not attached to Playwriter.",
                hint: "Click the green Playwriter icon on a Chrome tab.",
              }),
            );
            return;
          }
          const snap = await browserClient.snapshot();
          res.writeHead(200);
          res.end(JSON.stringify(snap));
        } catch (e) {
          res.writeHead(500);
          res.end(
            JSON.stringify({
              code: "INTERNAL_ERROR",
              message: e instanceof Error ? e.message : String(e),
            }),
          );
        }
      })();
      return;
    }

    // ── /browser/navigate ────────────────────────────────────────────
    if (method === "POST" && url === "/browser/navigate") {
      readJsonBodyEarly(req, res, (parsed) => {
        const p = (parsed as { url?: unknown }) ?? {};
        if (typeof p.url !== "string" || !p.url.trim()) {
          res.writeHead(400);
          res.end(
            JSON.stringify({
              code: "INTERNAL_ERROR",
              message: "url required (string).",
            }),
          );
          return;
        }
        void (async () => {
          try {
            if (!browserClient) throw new Error("browser client missing");
            await browserClient.navigate(p.url as string);
            await new Promise((r) => setTimeout(r, 700));
            const snap = await browserClient.snapshot();
            recordAction({
              type: "browser_navigate",
              payload: { url: p.url as string },
              url: snap.url,
              consumer: authState?.ok ? authState.consumer : undefined,
            });
            res.writeHead(200);
            res.end(JSON.stringify({ url: snap.url, title: snap.title }));
          } catch (e) {
            res.writeHead(500);
            res.end(
              JSON.stringify({
                code: "INTERNAL_ERROR",
                message: e instanceof Error ? e.message : String(e),
              }),
            );
          }
        })();
      });
      return;
    }

    // ── /browser/click ───────────────────────────────────────────────
    if (method === "POST" && url === "/browser/click") {
      readJsonBodyEarly(req, res, (parsed) => {
        const p = (parsed as { ref?: unknown }) ?? {};
        if (typeof p.ref !== "string" || !p.ref) {
          res.writeHead(400);
          res.end(
            JSON.stringify({
              code: "INTERNAL_ERROR",
              message: "ref required (string).",
            }),
          );
          return;
        }
        void (async () => {
          try {
            if (!browserClient) throw new Error("browser client missing");
            await browserClient.click(p.ref as string);
            recordAction({
              type: "browser_click",
              payload: { ref: p.ref as string },
              consumer: authState?.ok ? authState.consumer : undefined,
            });
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.writeHead(500);
            res.end(
              JSON.stringify({
                code: "REF_NOT_FOUND",
                message: e instanceof Error ? e.message : String(e),
                hint: "Call /browser/snapshot to get fresh refs.",
              }),
            );
          }
        })();
      });
      return;
    }

    // ── /browser/type ────────────────────────────────────────────────
    if (method === "POST" && url === "/browser/type") {
      readJsonBodyEarly(req, res, (parsed) => {
        const p = (parsed as {
          ref?: unknown;
          text?: unknown;
          submit?: unknown;
        }) ?? {};
        if (typeof p.ref !== "string" || typeof p.text !== "string") {
          res.writeHead(400);
          res.end(
            JSON.stringify({
              code: "INTERNAL_ERROR",
              message: "ref + text required.",
            }),
          );
          return;
        }
        const submit = p.submit === true;
        void (async () => {
          try {
            if (!browserClient) throw new Error("browser client missing");
            await browserClient.type(p.ref as string, p.text as string, {
              submit,
            });
            recordAction({
              type: "browser_type",
              payload: {
                ref: p.ref as string,
                text: p.text as string,
                ...(submit ? { submit: true } : {}),
              },
              consumer: authState?.ok ? authState.consumer : undefined,
            });
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.writeHead(500);
            res.end(
              JSON.stringify({
                code: "INTERNAL_ERROR",
                message: e instanceof Error ? e.message : String(e),
              }),
            );
          }
        })();
      });
      return;
    }

    // ── /browser/set_input_files ─────────────────────────────────────
    if (method === "POST" && url === "/browser/set_input_files") {
      readJsonBodyEarly(req, res, (parsed) => {
        const p = (parsed as { ref?: unknown; paths?: unknown }) ?? {};
        if (typeof p.ref !== "string" || !Array.isArray(p.paths)) {
          res.writeHead(400);
          res.end(
            JSON.stringify({
              code: "INTERNAL_ERROR",
              message: "ref + paths[] required.",
            }),
          );
          return;
        }
        void (async () => {
          try {
            if (!browserClient) throw new Error("browser client missing");
            const paths = (p.paths as unknown[]).map(String);
            await browserClient.setInputFiles(p.ref as string, paths);
            recordAction({
              type: "browser_set_input_files",
              payload: { ref: p.ref as string, paths },
              consumer: authState?.ok ? authState.consumer : undefined,
            });
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.writeHead(500);
            res.end(
              JSON.stringify({
                code: "INTERNAL_ERROR",
                message: e instanceof Error ? e.message : String(e),
              }),
            );
          }
        })();
      });
      return;
    }

    // ── /browser/scroll ──────────────────────────────────────────────
    if (method === "POST" && url === "/browser/scroll") {
      readJsonBodyEarly(req, res, (parsed) => {
        const p = (parsed as {
          direction?: unknown;
          ref?: unknown;
          amount?: unknown;
        }) ?? {};
        if (p.direction !== "up" && p.direction !== "down") {
          res.writeHead(400);
          res.end(
            JSON.stringify({
              code: "INTERNAL_ERROR",
              message: "direction must be 'up' or 'down'.",
            }),
          );
          return;
        }
        const amount = typeof p.amount === "number" ? p.amount : undefined;
        void (async () => {
          try {
            if (!browserClient) throw new Error("browser client missing");
            if (typeof p.ref === "string" && p.ref) {
              await browserClient.scrollElement(
                p.ref,
                p.direction as "up" | "down",
                amount,
              );
              recordAction({
                type: "browser_scroll_element",
                payload: {
                  ref: p.ref,
                  dir: p.direction,
                  ...(amount !== undefined ? { amount } : {}),
                },
                consumer: authState?.ok ? authState.consumer : undefined,
              });
            } else {
              await browserClient.scrollPage(
                p.direction as "up" | "down",
                amount,
              );
              recordAction({
                type: "browser_scroll_page",
                payload: {
                  dir: p.direction,
                  ...(amount !== undefined ? { amount } : {}),
                },
                consumer: authState?.ok ? authState.consumer : undefined,
              });
            }
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.writeHead(500);
            res.end(
              JSON.stringify({
                code: "INTERNAL_ERROR",
                message: e instanceof Error ? e.message : String(e),
              }),
            );
          }
        })();
      });
      return;
    }

    // ── /browser/read ────────────────────────────────────────────────
    if (method === "POST" && url === "/browser/read") {
      readJsonBodyEarly(req, res, (parsed) => {
        const p = (parsed as { ref?: unknown }) ?? {};
        void (async () => {
          try {
            if (!browserClient) throw new Error("browser client missing");
            const text = await browserClient.readText(
              typeof p.ref === "string" ? p.ref : undefined,
            );
            res.writeHead(200);
            res.end(JSON.stringify({ text }));
          } catch (e) {
            res.writeHead(500);
            res.end(
              JSON.stringify({
                code: "INTERNAL_ERROR",
                message: e instanceof Error ? e.message : String(e),
              }),
            );
          }
        })();
      });
      return;
    }

    // ── /extract (deterministic bulk READ: navigate + load-all + rows) ──
    // The coarse read path for browser-jobs: turns a page into structured
    // rows in one call (no vision loop). Used by the consumer for read-type
    // jobs (scrape_inventory / sync_listing_state / check_messages) — the
    // same extract that powers the `extract` MCP tool, exposed to the bridge.
    if (method === "POST" && url === "/extract") {
      readJsonBodyEarly(req, res, (parsed) => {
        const p = (parsed as {
          url?: unknown;
          columns?: unknown;
          instructions?: unknown;
          ref?: unknown;
          scroll?: unknown;
          deep?: unknown;
        }) ?? {};
        void (async () => {
          const T0 = Date.now();
          const timings: Record<string, number> = {};
          // Hard ceiling on the whole read so a wedged browser/model can never
          // hang the handler forever (the HTTP server runs requestTimeout=0).
          const ac = new AbortController();
          const killT = setTimeout(() => ac.abort(), 60_000);
          const withTimeout = <T>(pr: Promise<T>, ms: number, what: string): Promise<T> =>
            Promise.race([
              pr,
              new Promise<T>((_, rej) =>
                setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms),
              ),
            ]);
          try {
            if (!browserClient) throw new Error("browser client missing");
            if (typeof p.url === "string" && p.url.trim()) {
              const t = Date.now();
              // Navigation failure is non-fatal — the tab may already be on the
              // page; readText below still works (or returns empty → 0 rows).
              await browserClient
                .navigate(p.url)
                .catch((err) =>
                  console.warn("[extract] navigate failed:", err instanceof Error ? err.message : err),
                );
              await new Promise((r) => setTimeout(r, 300));
              timings.navigate = Date.now() - t;
              // No extra snapshot() here — navigate already settled the tab and a
              // snapshot adds ~1-2s on the latency-critical path. Record the
              // requested url (good enough for the trace).
              recordAction({
                type: "browser_navigate",
                payload: { url: p.url },
                consumer: authState?.ok ? authState.consumer : undefined,
              });
            }
            // Lazy lists (Marketplace "Your listings", inbox) only render rows
            // as you scroll — load everything before reading, unless told not to.
            // settle=550ms: FB renders lazy rows slower than 350ms, which made
            // the early-stop fire before all rows loaded (missed ~8 of 33).
            if (p.scroll !== false) {
              const t = Date.now();
              // Patient enough to load every lazy row (settle 800 + 3 stable
              // passes got all 33 FB listings vs 25 at settle 550); still well
              // inside the 30s bulk budget thanks to the fast extract model.
              await scrollToLoadAll(browserClient, {
                maxScrolls: 18,
                settleMs: 800,
                stableRounds: 3,
              }).catch(() => {});
              timings.scroll = Date.now() - t;
            }
            let t = Date.now();
            let pageText = await withTimeout(
              browserClient.readText(typeof p.ref === "string" ? p.ref : undefined),
              30_000,
              "readText",
            );
            // DEEP mode: readText (Firecrawl-style) captures text content +
            // dropdown display values, but NOT <input value> attrs (title, price,
            // location on an edit form). The AX snapshot DOES expose those as the
            // control's accessible name — append the form-control lines so the
            // model sees every field. This is what "get everything you'd see when
            // editing" needs (the index/detail pages omit it).
            if (p.deep === true) {
              const snap = await browserClient.snapshot().catch(() => null);
              if (snap?.ax) {
                const controls = snap.ax
                  .split("\n")
                  .filter((l) =>
                    /\b(textbox|combobox|switch|checkbox|spinbutton|radio|slider|listbox|searchbox)\b/i.test(l),
                  )
                  .join("\n");
                if (controls) pageText += "\n\n=== FORM FIELD VALUES (control: current value) ===\n" + controls;
              }
            }
            timings.read = Date.now() - t;
            timings.textLen = pageText.length;
            if (!pageText || !pageText.trim()) {
              res.writeHead(200);
              res.end(JSON.stringify({ ok: true, headers: [], rows: [], count: 0, timings }));
              return;
            }
            const columns = Array.isArray(p.columns)
              ? (p.columns as unknown[]).filter((c): c is string => typeof c === "string")
              : undefined;
            const instructions =
              typeof p.instructions === "string" ? p.instructions : undefined;
            t = Date.now();
            // Pass the abort signal so a hung/rate-limited model fetch is bounded
            // by the 60s ceiling instead of hanging the handler.
            const { headers, rows } = await extractRows({
              pageText,
              signal: ac.signal,
              ...(columns && columns.length ? { columns } : {}),
              ...(instructions ? { instructions } : {}),
            });
            timings.extract = Date.now() - t;
            timings.total = Date.now() - T0;
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, headers, rows, count: rows.length, timings }));
          } catch (e) {
            res.writeHead(500);
            res.end(
              JSON.stringify({
                code: "INTERNAL_ERROR",
                message: e instanceof Error ? e.message : String(e),
              }),
            );
          } finally {
            clearTimeout(killT);
          }
        })();
      });
      return;
    }

    // ── /recipe/save ─────────────────────────────────────────────────
    if (method === "POST" && url === "/recipe/save") {
      readJsonBodyEarly(req, res, (parsed) => {
        const p = (parsed as { task?: unknown; fromIndex?: unknown }) ?? {};
        void (async () => {
          try {
            const recipe = buildRecipeFromTrace({
              ...(typeof p.task === "string" ? { task: p.task } : {}),
              ...(typeof p.fromIndex === "number"
                ? { fromIndex: p.fromIndex }
                : {}),
            });
            if (recipe.steps.length === 0) {
              res.writeHead(400);
              res.end(
                JSON.stringify({
                  code: "RECIPE_EMPTY",
                  message:
                    "No actions in the trace buffer — nothing to save.",
                  hint: "Drive some browser_* / screen_* tools first.",
                }),
              );
              return;
            }
            const saved = await saveRecipe(recipe);
            if (!saved) {
              res.writeHead(500);
              res.end(
                JSON.stringify({
                  code: "RECIPE_SAVE_FAILED",
                  message: "Disk write failed.",
                }),
              );
              return;
            }
            res.writeHead(200);
            res.end(
              JSON.stringify({
                id: saved.id,
                recipePath: saved.recipePath,
                jsonPath: saved.jsonPath,
                steps: recipe.steps.length,
              }),
            );
          } catch (e) {
            res.writeHead(500);
            res.end(
              JSON.stringify({
                code: "INTERNAL_ERROR",
                message: e instanceof Error ? e.message : String(e),
              }),
            );
          }
        })();
      });
      return;
    }

    // ── /recipe/list ─────────────────────────────────────────────────
    if (method === "GET" && url === "/recipe/list") {
      void (async () => {
        try {
          const entries = await listRecipes();
          res.writeHead(200);
          res.end(
            JSON.stringify({
              recipes: entries.map((e) => ({
                id: e.id,
                task: e.task,
                steps: e.steps,
                recipePath: e.recipePath,
                jsonPath: e.jsonPath,
                ...(e.outcome ? { outcome: e.outcome } : {}),
              })),
            }),
          );
        } catch (e) {
          res.writeHead(500);
          res.end(
            JSON.stringify({
              code: "INTERNAL_ERROR",
              message: e instanceof Error ? e.message : String(e),
            }),
          );
        }
      })();
      return;
    }

    // ── /recipe/:id ──────────────────────────────────────────────────
    const recipeMatch = url.match(/^\/recipe\/([A-Za-z0-9._:-]+)$/);
    if (method === "GET" && recipeMatch) {
      void (async () => {
        try {
          const recipe = await loadRecipe(recipeMatch[1]!);
          if (!recipe) {
            res.writeHead(404);
            res.end(
              JSON.stringify({
                code: "RECIPE_NOT_FOUND",
                message: `Recipe "${recipeMatch[1]}" not found.`,
              }),
            );
            return;
          }
          res.writeHead(200);
          res.end(JSON.stringify(recipe));
        } catch (e) {
          res.writeHead(500);
          res.end(
            JSON.stringify({
              code: "INTERNAL_ERROR",
              message: e instanceof Error ? e.message : String(e),
            }),
          );
        }
      })();
      return;
    }

    // ── /recipe/run ──────────────────────────────────────────────────
    if (method === "POST" && url === "/recipe/run") {
      readJsonBodyEarly(req, res, (parsed) => {
        const p = (parsed as { id?: unknown; reground?: unknown; params?: unknown }) ?? {};
        if (typeof p.id !== "string") {
          res.writeHead(400);
          res.end(
            JSON.stringify({
              code: "INTERNAL_ERROR",
              message: "id required (string).",
            }),
          );
          return;
        }
        const runParams =
          p.params && typeof p.params === "object" && !Array.isArray(p.params)
            ? (p.params as Record<string, unknown>)
            : undefined;
        void (async () => {
          try {
            const recipe = await loadRecipe(p.id as string);
            if (!recipe) {
              res.writeHead(404);
              res.end(
                JSON.stringify({
                  code: "RECIPE_NOT_FOUND",
                  message: `Recipe "${p.id}" not found.`,
                }),
              );
              return;
            }
            // Defer to the SDK replay engine in the renderer/CLI path.
            // The bridge process already owns macOS perms + the
            // browser client, so we can drive directly here.
            const { replayRecipe } = await import("../src/cli/sdk");
            const result = await replayRecipe(recipe, {
              reground: p.reground === true,
              browser: browserClient ?? null,
              // Inject the warmed provider so the per-step vision SELF-HEAL
              // tier can fire on a deterministic miss (not just on reground).
              provider: warmup.getProvider(),
              // Per-run data for {{token}} substitution (browser-job payload):
              // turns one recorded create/update flow into a data-driven recipe.
              ...(runParams ? { params: runParams } : {}),
              // Self-heal write-back: if a step's refLabel drifted (a renamed
              // element) OR a step was vision-healed, persist the corrected
              // recipe (same id is re-derived) so the next run is deterministic.
              persist: (r) => saveRecipe(r),
            });
            res.writeHead(200);
            res.end(JSON.stringify(result));
          } catch (e) {
            res.writeHead(500);
            res.end(
              JSON.stringify({
                code: "INTERNAL_ERROR",
                message: e instanceof Error ? e.message : String(e),
              }),
            );
          }
        })();
      });
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
              maxSteps?: unknown;
              decompose?: unknown;
            };
            const task = typeof parsed.task === "string" ? parsed.task : "";
            // targetApp tri-state:
            //   undefined / missing key → use auto-detect (loop.ts inferTargetApp)
            //   "" (explicit empty)     → opt out: no inference, no cropping
            //   "AppName"               → use that app explicitly
            // Previously this collapsed "" to undefined, which made the
            // opt-out promised by loop.ts:452 unreachable. Multi-app bench
            // tasks (Chrome + Excel) need the explicit empty-string path
            // so cropping doesn't lock to whichever app gets matched first.
            const targetApp =
              typeof parsed.targetApp === "string"
                ? parsed.targetApp.trim()
                : undefined;
            // Optional per-call action budget. Sanity-clamp to
            // [5, 200] so a malformed payload can't accidentally
            // run for thousands of steps. Default (undefined)
            // lets runAgentTaskForBridge use the loop's MAX_STEPS.
            const maxSteps =
              typeof parsed.maxSteps === "number" &&
              Number.isFinite(parsed.maxSteps) &&
              parsed.maxSteps >= 5 &&
              parsed.maxSteps <= 200
                ? Math.floor(parsed.maxSteps)
                : undefined;
            if (!task.trim()) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: "empty task" }));
              return;
            }
            // Declared-multi-step gate for one-shot decomposition
            // (NEXT-WORK Item 2); inert unless PONDER_DECOMPOSE is on.
            const decompose = parsed.decompose === true;
            const result = await chainBridge(() =>
              runAgentTaskForBridge({
                prompt: task,
                targetApp,
                maxSteps,
                decompose,
              }),
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
              // Surface the PNG-to-logical pixel ratio so MCP-side
              // consumers (agent_click_sequence's crop path, the
              // vision-precision bench, anorha, etc.) can scale crop
              // coords from logical → physical before slicing the
              // PNG. On non-Retina or nut-js this is 1; on Retina
              // via desktopCapturer it's 2 (or 3 on some 5K monitors).
              scaleFactor: shot.scaleFactor,
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
  // Node 18+ defaults `requestTimeout` to 300_000ms (5 min). Long
  // bench tasks (e.g. t4-honda-crv with maxSteps=70) take 25-35 min
  // wall time on rate-limited providers; the 5-min cap kills the
  // HTTP connection even though the agent is still working. Symptom:
  // bench/run.ts sees `fetch failed` at ~301s, no transcript, no
  // outcome — diagnosed 2026-05-11 Run 7. Disable the cap (0 = no
  // limit) so agent_do can run as long as the harness allows.
  server.requestTimeout = 0;
  // Also disable the headers timeout (default 60s) — not currently
  // a problem, but we send headers immediately so this is just
  // future-proofing if streaming is added later.
  server.headersTimeout = 0;
  server.listen(BRIDGE_PORT, "127.0.0.1", () => {
    _bridgeServerStarted = true;
    console.log(
      `[bridge] listening on http://127.0.0.1:${BRIDGE_PORT} — MCP can now forward agent_do here (requestTimeout=0)`,
    );
  });
}

/**
 * AGP engine Run path (server-side Holo 3.1 brain). Mirrors the composite
 * agent:run lifecycle — Convex session, live narration into the buddy bubble +
 * History, cancel — but drives Chrome via the AGP thin-driver instead of the
 * local plan/ground loop. No OS-permission gate and no provider warmup: the
 * brain runs on H-company's servers and acts on the page through Playwriter
 * (CDP), not the macOS mouse.
 */
async function runAgpAppTask(prompt: string): Promise<{ ok: boolean; error?: string }> {
  const client = new AgpClient();
  if (!client.configured) {
    const msg =
      "The server brain (AGP) needs HAI_API_KEY set. Switch to the Local engine in " +
      "Settings, or add the key, then try again.";
    buddySay("error", msg);
    return { ok: false, error: msg };
  }
  if (!browserClient) {
    const msg = "Browser engine not ready yet — give it a second and try again.";
    buddySay("error", msg);
    return { ok: false, error: msg };
  }
  // Zero-touch: if no tab is attached, the agent vision-clicks the Playwriter
  // icon ITSELF (no debug port, no human gesture). Only error if that fails.
  let page = await browserClient.rawPage?.().catch(() => null);
  if (!page) {
    buddySay("status", "Connecting to Chrome…");
    try {
      const { autoAttachPlaywriter } = await import("../src/agent/auto-attach");
      await autoAttachPlaywriter(browserClient);
    } catch {
      /* fall through to the error below */
    }
    page = await browserClient.rawPage?.().catch(() => null);
  }
  if (!page) {
    const msg = "Couldn't attach to Chrome automatically — make sure Chrome is open, then try again.";
    buddySay("error", msg);
    return { ok: false, error: msg };
  }

  cancelFlag = false;
  dismissInputPill();
  setBuddyMode("active");
  buddySay("status", "Got it…");

  let sessionId: string | null = null;
  if (convex) {
    try {
      sessionId = (await convex.mutation(convexApi.sessions.create, {
        prompt,
        // AGP runs are H-company's server-side brain — label them "hcompany"
        // in History until the Convex sessions schema gains a distinct "agp".
        provider: "hcompany",
      })) as unknown as string;
      activeSessionId = sessionId;
      broadcastState();
      await convex.mutation(convexApi.sessions.setStatus, {
        sessionId: sessionId as never,
        status: "running",
      });
    } catch (e) {
      console.warn(`[agp:run] convex session create failed (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  const events = await buildEvents(sessionId ?? "");
  buddySay("status", "Thinking on the server brain…");

  const ac = new AbortController();
  agpAbort = ac;
  try {
    const result = await runAgpTask({
      task: prompt,
      client,
      browser: browserClient,
      signal: ac.signal,
      onEvent: (ev) => {
        if (ev.kind === "policy_event" && ev.text) void events.onThought?.(ev.text);
        else if (ev.kind === "error_event" && ev.error) void events.onError?.(ev.error);
        else if (ev.kind === "observation_event") void events.onStatus?.("Reading the page…");
      },
      onCommand: (name, args) => {
        void events.onAction?.({ type: name, payload: args });
      },
    });

    const failed =
      result.status === "failed" || result.status === "error" || result.status === "timed_out";
    const answer =
      result.answer?.trim() ||
      (failed
        ? `Couldn't finish: ${result.error ?? result.status}.`
        : `Done (${result.commandCount} steps).`);
    buddySay("answer", answer);

    if (sessionId && convex) {
      try {
        await convex.mutation(convexApi.steps.append, {
          sessionId: sessionId as never,
          kind: "result",
          text: answer,
        });
      } catch (e) {
        console.warn(`[agp:run] convex result persist failed (${e instanceof Error ? e.message : String(e)})`);
      }
      await convex
        .mutation(convexApi.sessions.setStatus, {
          sessionId: sessionId as never,
          status: failed ? "error" : result.status === "interrupted" ? "cancelled" : "done",
          ...(result.error ? { error: result.error } : {}),
        })
        .catch(() => {});
    }
    return failed ? { ok: false, error: result.error ?? "AGP run failed" } : { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    buddySay("error", message);
    console.error("[agp:run]", message);
    if (sessionId && convex) {
      await convex
        .mutation(convexApi.sessions.setStatus, {
          sessionId: sessionId as never,
          status: "error",
          error: message,
        })
        .catch(() => {});
    }
    return { ok: false, error: message };
  } finally {
    agpAbort = null;
    activeSessionId = null;
    broadcastState();
    setBuddyMode("hidden");
    buddyAgentCursor(null);
  }
}

/**
 * Recipe-first routing: if a saved automation EXACTLY matches the task, replay
 * it (deterministic + self-healing) instead of running the agent. Returns a
 * result when it handled the run, or null to fall through to the agent (no
 * match, auto-replay disabled, or the replay failed). A "fresh …" prefix is
 * stripped by the caller and never reaches here.
 */
async function maybeAutoReplay(
  prompt: string,
): Promise<{ ok: boolean; error?: string } | null> {
  if (!getAutoReplayPreference()) return null;
  if (!browserClient) return null; // replay drives Chrome
  const match = await findRecipeByTask(prompt).catch(() => null);
  if (!match || match.recipe.steps.length === 0) return null;
  // Zero-touch: auto-attach (vision-click the Playwriter icon) before replay.
  if (!(await browserClient.available().catch(() => false))) {
    try {
      const { autoAttachPlaywriter } = await import("../src/agent/auto-attach");
      await autoAttachPlaywriter(browserClient);
    } catch {
      /* replay will surface its own not-attached error */
    }
  }

  cancelFlag = false;
  dismissInputPill();
  setBuddyMode("active");
  buddySay(
    "status",
    `Replaying saved automation "${match.recipe.task}" — type "fresh ${prompt}" to run from scratch.`,
  );
  try {
    const { replayRecipe } = await import("../src/cli/sdk");
    const res = await replayRecipe(match.recipe, {
      reground: true,
      browser: browserClient,
      provider: warmup.getProvider(),
      // Self-heal write-back: persist any drift (renamed elements) under the same id.
      persist: (r) => saveRecipe(r),
      shouldCancel: () => cancelFlag,
      onStep: ({ index, step, status, error }) =>
        buddySay(
          status === "error" ? "error" : "action",
          `${index + 1}. ${step.executed?.type ?? "step"}${error ? ` — ${error}` : ""}`,
        ),
    });
    if (res.failed > 0) {
      // A step broke beyond self-heal — fall back to a fresh agent run.
      buddySay("status", "Saved automation hit a snag — running it fresh instead…");
      return null;
    }
    const healedNote = res.healed ? ` · adapted ${res.healed} changed step(s)` : "";
    buddySay("answer", `Done — replayed saved automation (${res.ok} step(s)${healedNote}).`);
    setBuddyMode("hidden");
    return { ok: true };
  } catch (e) {
    buddySay("status", "Saved automation couldn't run — running fresh…");
    console.warn(`[auto-replay] ${e instanceof Error ? e.message : String(e)}`);
    return null; // fall through to the agent
  }
}

function setupIpc(): void {
  ipcMain.handle("agent:run", async (_e, rawPrompt: string) => {
    if (!rawPrompt?.trim()) return { ok: false, error: "empty prompt" };
    // "fresh …" / "redo …" forces a fresh run, skipping any saved automation.
    const freshMatch = /^\s*(?:fresh|redo)\b[:\s]+/i.exec(rawPrompt);
    const prompt = (freshMatch ? rawPrompt.slice(freshMatch[0].length) : rawPrompt).trim();
    if (!prompt) return { ok: false, error: "empty prompt" };

    // Recipe-first: replay a saved automation that exactly matches, unless the
    // user asked for a fresh run. Falls through to the agent on miss/failure.
    if (!freshMatch) {
      const replayed = await maybeAutoReplay(prompt);
      if (replayed) return replayed;
    }

    // Server-side AGP brain: separate lifecycle (no OS-perms gate, no warmup).
    if (getEnginePreference() === "agp") {
      return runAgpAppTask(prompt);
    }

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
      // Composite mode: don't pay an Ollama round-trip (or its multi-
      // second timeout) for a cosmetic intro line — the planner is the
      // brain now and the run starts immediately.
      if (!plannerConfigFromEnv()) {
        const line = await narrator.intro({ task: prompt });
        buddySay("thought", line);
      }
    })();

    let sessionId: string | null = null;
    if (convex) {
      sessionId = (await convex.mutation(convexApi.sessions.create, {
        prompt,
        provider: executorNameFor(providerName),
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

    const baseEvents = sessionId
      ? await buildEvents(sessionId)
      : await buildEvents("");

    // Record this run into a recipe recorder so the user can "Save as
    // automation" afterward. We tap the same onAction the Convex logger uses
    // (history line annotates the next action). Empty until the first action.
    const recorder = createRecipeRecorder({ task: prompt, provider: String(providerName) });
    lastRunRecorder = null; // cleared until this run produces a saveable recipe
    const events: typeof baseEvents = {
      ...baseEvents,
      onAction: async (a) => {
        try { recorder.onAction(a); } catch { /* recording best-effort */ }
        await baseEvents.onAction?.(a);
      },
    };

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
          try { recorder.onHistory(action); } catch { /* recording best-effort */ }
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

      // Freeze the recording so "Save as automation" can persist it. Only keep
      // it if the run actually did something (≥1 recorded action).
      try {
        recorder.setOutcome(summaryOutcome);
        lastRunRecorder = recorder.getRecipe().steps.length > 0 ? recorder : null;
      } catch { lastRunRecorder = null; }

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
    agpAbort?.abort();
    return { ok: true };
  });

  ipcMain.handle("agent:getEngine", () => getEnginePreference());

  ipcMain.handle("agent:setEngine", (_e, engine: AgentEngine) => {
    setEnginePreference(engine === "agp" ? "agp" : "composite");
    return { ok: true, engine: getEnginePreference() };
  });

  ipcMain.handle("agent:getAutoReplay", () => getAutoReplayPreference());

  ipcMain.handle("agent:setAutoReplay", (_e, on: boolean) => {
    setAutoReplayPreference(!!on);
    return { ok: true, autoReplay: getAutoReplayPreference() };
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
    provider: executorNameFor(providerName),
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
    provider: executorNameFor(providerName),
    backgroundMode: BACKGROUND_MODE,
  }));

  // ── Recipes (automations) — the renderer's Automations tab pulls
  //    these from disk so the user can see every saved flow without
  //    leaving the app. listRecipes/loadRecipe live in src/agent/
  //    recorder.ts; both read from ~/.ponder/recipes/.
  ipcMain.handle("recipes:list", async () => {
    try {
      return await listRecipes();
    } catch (e) {
      console.warn(`[ipc] recipes:list failed: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  });
  ipcMain.handle("recipes:get", async (_e, id: string) => {
    try {
      return await loadRecipe(id);
    } catch (e) {
      console.warn(`[ipc] recipes:get failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  });
  ipcMain.handle("recipes:paths", (_e, id: string) => {
    return recipePathsFor(id);
  });
  // Open the .recipe.ts in the user's $EDITOR / default app.
  ipcMain.handle("recipes:reveal", async (_e, id: string) => {
    try {
      const paths = recipePathsFor(id);
      // showItemInFolder (Finder reveal) — NOT openPath: macOS hands a bare
      // .recipe.ts to whatever owns the .ts extension (VLC on this machine),
      // which is never what the user wants. Finder lets them open it in their
      // editor of choice; the in-app Automation detail already shows the steps.
      shell.showItemInFolder(paths.recipePath);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  // Deterministic replay — re-grounds each step via the warmed provider, drives
  // the real browser, and narrates through the same buddySay pump as a live run
  // (so the floating cursor + the tray's working panel light up identically).
  ipcMain.handle(
    "recipes:replay",
    async (_e, id: string, opts?: { reground?: boolean; stepDelayMs?: number }) => {
      try {
        const recipe = await loadRecipe(id);
        if (!recipe) return { ok: false, error: "recipe not found" };
        // Dynamic import — main.ts already dynamically imports sdk.ts elsewhere;
        // a second STATIC import collides in the bundler and breaks bridge/auth
        // resolution at runtime. Keep it dynamic to match.
        const { replaySession } = await import("../src/cli/sdk");
        buddySay("status", `Replaying: ${recipe.task ?? id}`);
        const res = await replaySession(recipe, {
          reground: opts?.reground ?? true,
          stepDelayMs: opts?.stepDelayMs,
          browser: browserClient,
          provider: warmup.getProvider(),
          // Self-heal write-back: persist a drifted recipe (same id re-derived).
          persist: (r) => saveRecipe(r),
          onStep: ({ index, step, status, error }) => {
            buddySay(
              status === "error" ? "error" : "action",
              `${index + 1}. ${step.executed?.type ?? "step"}${error ? ` — ${error}` : ""}`,
            );
          },
        });
        const healedNote = res.healed ? ` · adapted ${res.healed} changed step(s)` : "";
        buddySay(
          "answer",
          (res.failed
            ? `Replay finished — ${res.failed} step(s) failed`
            : "Replay finished cleanly") + healedNote,
        );
        return { ok: true, failed: res.failed, healed: res.healed };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );
  // Save the most recent run as a reusable automation (recipe).
  ipcMain.handle("recipes:saveLast", async (_e, task?: string) => {
    try {
      if (!lastRunRecorder) {
        return { ok: false, error: "Nothing to save — run a task first." };
      }
      const recipe = lastRunRecorder.getRecipe();
      if (task && task.trim()) recipe.task = task.trim();
      if (!recipe.steps.length) return { ok: false, error: "That run had no recorded actions." };
      const saved = await saveRecipe(recipe);
      if (!saved) return { ok: false, error: "save failed" };
      return { ok: true, id: saved.id };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  // Save a PAST run (from History) as an automation. Reads the session's steps
  // from Convex and maps the action steps into a recipe. Lower fidelity than
  // saveLast (no refLabels — see recipeFromConvexSteps), but lets any logged run
  // become a replayable automation.
  ipcMain.handle("recipes:saveFromSession", async (_e, sessionId: string, task?: string) => {
    try {
      if (!convex) return { ok: false, error: "History store unavailable." };
      const [steps, session] = await Promise.all([
        convex.query(convexApi.steps.listBySession, { sessionId: sessionId as never }),
        convex.query(convexApi.sessions.get, { sessionId: sessionId as never }),
      ]);
      if (!steps || steps.length === 0) return { ok: false, error: "That run has no recorded steps." };
      const sess = session as { prompt?: string; provider?: string } | null;
      const recipe = recipeFromConvexSteps(
        (task && task.trim()) || sess?.prompt || "Saved run",
        steps as Array<{ kind: string; text?: string; action?: { type: string; payload?: unknown }; coords?: { x: number; y: number }; createdAt?: number }>,
        sess?.provider ? { provider: sess.provider } : {},
      );
      if (!recipe.steps.length) return { ok: false, error: "That run had no replayable actions to save." };
      const saved = await saveRecipe(recipe);
      if (!saved) return { ok: false, error: "save failed" };
      return { ok: true, id: saved.id };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  // Open a selling channel (or any URL) in the user's default browser so they
  // can sign in. Channel auth lives in the user's real browser session, which
  // the Playwriter-driven agent then reuses.
  ipcMain.handle("channels:open", async (_e, url: string) => {
    try {
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: "bad url" };
      await shell.openExternal(url);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

function buildTray(): void {
  const icon = nativeImage
    .createFromPath(join(__dirname, "../../assets/tray-icon.png"))
    .resize({ width: 18, height: 18 });
  if (icon.isEmpty()) {
    // No icon file — use an empty image but set a title so the user can see it
    // in the menu bar. macOS will render the title text instead of an icon.
    tray = new Tray(nativeImage.createEmpty());
    if (process.platform === "darwin") tray.setTitle("Anorha"); //Tray title
  } else {
    tray = new Tray(icon);
  }
  tray.setToolTip("Anorha · ⌘E to summon");
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
        title: "Anorha ready",
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

// ── Keep-warm-while-open ──────────────────────────────────────────────────────
// Hit Modal's /warm every 4 min WHILE the Anorha panel is open, so the GPU never
// scales to zero during a work session → every run is the warm ~1.5s/step with no
// 22s cold-start. When the panel is closed the pinger goes silent and Modal scales
// the GPU down (~10min) → $0 idle. Only for the "remote" (Modal) brain, which is the
// one that cold-starts. Uses provider.warm() DIRECTLY because the WarmupQueue's
// warm() no-ops once "ready" and wouldn't reset Modal's scaledown timer.
let keepWarmTimer: ReturnType<typeof setInterval> | null = null;
function pingWarmIfOpen(): void {
  if (providerName !== "remote") return;
  if (!appWin || appWin.isDestroyed() || !appWin.isVisible()) return;
  void warmup.getProvider().warm().catch(() => {});
}
function startKeepWarm(): void {
  if (keepWarmTimer) return;
  keepWarmTimer = setInterval(pingWarmIfOpen, 240_000); // 4 min < Modal's 600s scaledown
}

app.whenReady().then(() => {
  // Keep dock visible during dev so the user has a visual anchor; can hide
  // later via tray menu or remove this check entirely once tray icon ships.
  // if (process.platform === "darwin") app.dock?.hide();

  buildTray();
  setupIpc();
  startBridgeServer();

  // Pre-warm the brain at launch so the FIRST task hits a warm container
  // instead of paying a cold start. With Modal min_containers=0 the GPU
  // scales to zero when idle; warming on app open covers the common
  // open → type → run flow so it feels instant like the engine should.
  void warmup.warmInBackground();

  // Auto-open the AppWindow on launch so the user sees the history view
  // immediately. They can close it; tray icon stays for re-summon.
  if (!appWin || appWin.isDestroyed()) appWin = createAppWindow();
  appWin.show();
  appWin.focus();
  // Keep the GPU hot while the panel is open (no cold-start mid-session); warm
  // immediately whenever the panel is shown/focused so opening → running is fast.
  appWin.on("focus", pingWarmIfOpen);
  appWin.on("show", pingWarmIfOpen);
  startKeepWarm();

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
