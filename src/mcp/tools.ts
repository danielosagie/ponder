/**
 * Shared MCP tool registrations.
 *
 * Both transports (stdio for Claude Desktop, streamable HTTP for
 * claude.ai web connectors) register the same tool surface — this
 * module is the single source of truth so a fix to a tool's
 * description / behavior reaches both transports automatically.
 *
 * The Playwriter client is per-process (one relay, one Chrome
 * connection), so we cache it lazily here. A request-scoped browser
 * isn't useful: every MCP client wants to drive THE user's Chrome,
 * and there's only one of those.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import { api as convexApi } from "../../convex/_generated/api.js";
import { createPlaywriterClient } from "../agent/browser/playwriter.js";
import * as screen from "../screen.js";
import { cropAndScalePng, pngDimensions } from "../agent/imageops.js";
import type { BrowserClient, BrowserSnapshot } from "../agent/browser/types.js";
import { runTask } from "../agent/loop.js";
import { runAgpTask } from "../agent/agp/loop.js";
import { AgpClient } from "../agent/agp/client.js";
import { writeCsvFile, copyTableToClipboard } from "../agent/export.js";
import { extractRows } from "../agent/extract.js";
import { runLongTask } from "../agent/orchestrator.js";
import { buildOrchestratorDeps } from "../agent/orchestrator-deps.js";
import {
  computeDefaultProvider,
  executorNameFor,
  isProviderConfigured,
  makeProvider,
  makeRouter,
  humanProviderLabel,
} from "../agent/factory.js";
import type {
  AgentEvents,
  GroundResult,
  ProviderClient,
} from "../agent/types.js";
import type { RouterClient } from "../agent/router.js";
import {
  createRecipeRecorder,
  createSessionRecorder,
  recordFromBridgeTranscript,
  renderRecipeScript,
  saveRecipe,
  saveSession,
  listRecipes,
  listSessions,
  loadRecipe,
  loadSession,
  pathsFor,
  RECIPES_DIR,
  SESSIONS_DIR,
  recordAction,
  parseAxRefs,
  snapshotTrace,
  traceLength,
  startNewTrace,
  getTraceMeta,
  buildRecipeFromTrace,
  type RecipeRecorder,
  type SessionRecorder,
  type RecordedRecipe,
  type RecordedSession,
  type RecordedStep,
} from "../agent/recorder.js";
import { replaySession } from "../cli/sdk.js";
import { PonderError } from "../errors.js";
import { BUILD_INFO } from "./build-info.js";

const stderrLog = (...args: unknown[]): void => {
  process.stderr.write(args.map(String).join(" ") + "\n");
};

/**
 * Display name for this MCP server. Set MCP_BRAND to whatever you
 * named the connector in claude.ai (or Claude Desktop) so the tool
 * descriptions match — that way when you say "use the X mcp" Claude
 * recognizes which toolset you mean, AND the descriptions register as
 * relevant in claude.ai's deferred-tool search.
 *
 * Default is "Ponder" — the canonical product name. Override with the
 * MCP_BRAND env var if you've configured a different connector name
 * in claude.ai's web dialog.
 */
export const MCP_BRAND = process.env.MCP_BRAND ?? "Ponder";

/** Tag appended (not prefixed) to descriptions so deferred-tool search
 *  (claude.ai shows MCP tools as deferred until invoked) on the brand
 *  name still matches, without burning the front of the description on
 *  boilerplate. Tool descriptions LEAD with task language ("Click on a
 *  webpage element…", "Open a URL in Chrome…") so an agent picks them
 *  on intent alone — the user shouldn't have to say "use the X mcp". */
const BRAND_TAG_SUFFIX = ` (${MCP_BRAND})`;

// One Playwriter client per Node process. Lazy: the first tool call
// pays the relay-start + Chrome-connect cost (~50-300ms), every
// subsequent call hits the resolved value. Memoized so the HTTP
// transport — which spawns a new McpServer per request — still shares
// one underlying browser session across all requests.
let _browserPromise: Promise<BrowserClient> | null = null;
function getBrowser(): Promise<BrowserClient> {
  if (!_browserPromise) {
    _browserPromise = createPlaywriterClient({
      onStatus: (msg: string) => stderrLog(`[mcp] ${msg}`),
    });
  }
  return _browserPromise;
}

// Latched from the most recent browser_snapshot: ref→(role,name) labels
// + page URL. Direct browser_click/browser_type/browser_set_input_files
// trace records stamp these on (mcpRefMeta below) so recipe codegen gets
// durable page.getByRole(...) selectors and replay gets self-healing —
// previously direct MCP browser actions recorded only the ephemeral [eN]
// ref. Snapshot-then-act is the orchestrator's contract, so the latch is
// fresh whenever a ref is valid in the first place.
let lastMcpSnapshotRefs: Map<string, { role: string; name: string }> | null =
  null;
let lastMcpSnapshotUrl: string | undefined;
function mcpRefMeta(ref: string): {
  refLabel?: { role: string; name: string };
  url?: string;
} {
  const refLabel = lastMcpSnapshotRefs?.get(ref);
  return {
    ...(refLabel ? { refLabel } : {}),
    ...(lastMcpSnapshotUrl ? { url: lastMcpSnapshotUrl } : {}),
  };
}

/**
 * Crop a captured frame to `targetApp`'s front window for the single-shot
 * vision primitives (agent_click / agent_observe) — the same ~6-20×
 * image-token reduction the agent_do loop gets from maybeCropToTargetApp,
 * without these tools paying full-frame grounding (~5-10s on Modal).
 *
 * Strategy mirrors the loop:
 *   1. When the frame came from LOCAL capture (bridge down), prefer
 *      screen.captureWindowDirect — native-res, occlusion-proof.
 *   2. Otherwise crop the frame we already have: bounds via
 *      getMacWindowBounds (bridge-first), physical-px slice via sips.
 *   3. Any failure → return the frame unchanged (never blocks the call).
 *
 * Returned offsets carry the window origin, so the existing
 * `coords + offsetX/Y` translation downstream works unchanged.
 */
async function cropFrameToApp(
  frame: {
    png: Buffer;
    width: number;
    height: number;
    offsetX: number;
    offsetY: number;
  },
  targetApp: string,
  preferDirect: boolean,
): Promise<typeof frame & { cropNote?: string }> {
  try {
    if (preferDirect) {
      const direct = await screen.captureWindowDirect(targetApp);
      if (direct && Math.min(direct.width, direct.height) >= 80) {
        return {
          png: direct.png,
          width: direct.width,
          height: direct.height,
          offsetX: direct.offsetX,
          offsetY: direct.offsetY,
          ...(direct.occluders.length > 0
            ? {
                cropNote: `⚠️ ${targetApp}'s window is overlapped by ${direct.occluders.join("; ")} — grounding uses the window's own pixels, but clicks land on whatever is on top.`,
              }
            : {}),
        };
      }
    }
    const bounds = await screen.getMacWindowBounds(targetApp);
    if (!bounds) return frame;
    const dims = pngDimensions(frame.png);
    if (!dims) return frame;
    const sf = dims.width / frame.width;
    const floor = sf > 1 ? 80 : 300;
    if (Math.min(bounds.width, bounds.height) < floor) return frame;
    const cropX = bounds.x - frame.offsetX;
    const cropY = bounds.y - frame.offsetY;
    if (
      cropX < 0 ||
      cropY < 0 ||
      cropX + bounds.width > frame.width ||
      cropY + bounds.height > frame.height
    ) {
      return frame; // window not fully inside this frame — stay uncropped
    }
    const cropped = await cropAndScalePng(
      frame.png,
      {
        x: cropX * sf,
        y: cropY * sf,
        w: bounds.width * sf,
        h: bounds.height * sf,
      },
      1,
    );
    return {
      png: cropped,
      width: bounds.width,
      height: bounds.height,
      offsetX: bounds.x,
      offsetY: bounds.y,
    };
  } catch (e) {
    stderrLog(
      `[mcp] cropFrameToApp("${targetApp}") failed (${e instanceof Error ? e.message.split("\n")[0] : String(e)}) — grounding uncropped`,
    );
    return frame;
  }
}

// Best-effort browser fetch for paths that DON'T want to fail when Chrome
// isn't attached — e.g., agent_do's tandem mode where vision can still
// drive the OS surface even if Playwriter is down. Returns null on
// constructor or availability failure rather than throwing.
async function getBrowserOrNull(): Promise<BrowserClient | null> {
  try {
    const b = await getBrowser();
    if (await b.available()) return b;
    return null;
  } catch {
    return null;
  }
}

// Local CLI router (qwen3.5:0.8b via Ollama). Cheap to construct (no
// network at construction; `available()` is what probes Ollama). Memoized
// like the browser. Returns null when the user has explicitly disabled
// the router via HOLO3_ROUTER=off.
let _router: RouterClient | null | undefined = undefined;
function getRouter(): RouterClient | null {
  if (_router === undefined) _router = makeRouter();
  return _router;
}

// ── Provider lazy cache ──────────────────────────────────────────────
//
// `agent_do` needs a Holo3 ProviderClient (passed into `runTask` for
// vision-only execution). Constructed once per Node process and shared
// across MCP tool calls — same lifetime as `_browserPromise`.
//
// The HTTP transport spawns a fresh McpServer per request but module
// state is process-local, so this cache survives across requests too.

let _providerPromise: Promise<ProviderClient> | null = null;
let _providerWarmPromise: Promise<void> | null = null;

/** Lazy provider. Throws a clear configuration error before constructing
 *  if no creds are present (so callers can return fail() instead of a
 *  late runtime crash from a fetch with empty creds). */
function getProvider(): Promise<ProviderClient> {
  if (!_providerPromise) {
    _providerPromise = (async () => {
      const name = computeDefaultProvider();
      if (!isProviderConfigured(name)) {
        throw new Error(
          `Provider "${name}" not configured. ` +
            `Set HAI_API_KEY (preferred) or MODAL_BASE_URL+MODAL_BEARER_TOKEN ` +
            `to use a hosted provider, or install Ollama locally with the ` +
            `holo3 model. See README "Providers" section.`,
        );
      }
      stderrLog(`[mcp] using provider: ${humanProviderLabel(name)}`);
      return makeProvider(name);
    })();
  }
  return _providerPromise;
}

/** Provider + first-call warmup. BEST-EFFORT: a failed warm does NOT
 *  block agent_do. The warm() call is a probe — it pre-pays Modal's
 *  cold-start or validates the H Company API key. But upstream
 *  providers transiently 503 / rate-limit / drop connections; in those
 *  cases the actual runTask call may still succeed (different endpoint,
 *  different timing). Hard-failing on warm errors masked real bugs as
 *  "Provider not configured" messages.
 *
 *  Memoization: the FIRST call's warm result is cached so subsequent
 *  agent_do calls don't re-pay the ~30-60s cold-start. On failure we
 *  reset the gate so the next call retries. */
async function getProviderWarmed(): Promise<{
  provider: ProviderClient;
  warmError: string | null;
}> {
  const provider = await getProvider();
  if (!_providerWarmPromise) {
    _providerWarmPromise = provider
      .warm()
      .then(() => {
        stderrLog(`[mcp] provider warmed`);
        _providerLastWarmError = null;
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        stderrLog(
          `[mcp] provider warmup non-fatal failure (will try anyway): ${msg}`,
        );
        _providerLastWarmError = msg;
        _providerWarmPromise = null; // allow retry on next call
      });
  }
  await _providerWarmPromise;
  return { provider, warmError: _providerLastWarmError };
}

let _providerLastWarmError: string | null = null;

// ── AGP server-side brain (thin-driver) ──────────────────────────────
// Lazily-constructed client for the `agp_do` tool: H-company's Holo 3.1
// agent plans+grounds server-side and streams driver commands we execute
// against the shared Playwriter browser. Same process lifetime as
// _browserPromise; reads HAI_API_KEY / HCOMPANY_API_KEY from env.
let _agpClient: AgpClient | null = null;
function getAgpClient(): AgpClient {
  if (!_agpClient) _agpClient = new AgpClient();
  return _agpClient;
}

const ok = (text: string) => ({
  content: [{ type: "text" as const, text }],
});
const fail = (text: string) => ({
  content: [{ type: "text" as const, text }],
  isError: true,
});

async function ensureAttached(): Promise<string | null> {
  const browser = await getBrowser();
  if (await browser.available()) return null;
  // Zero-touch (user: "shouldn't have to press a single thing", no debug ports):
  // the agent vision-clicks the Playwriter icon ITSELF before bouncing to the
  // user. Proven to attach in ~11s, first try. Only if that fails do we fall
  // back to asking the human to click the green icon.
  try {
    const { autoAttachPlaywriter } = await import("../agent/auto-attach.js");
    const r = await autoAttachPlaywriter(browser);
    if (r.attached) return null;
  } catch {
    /* grounding/screen unavailable — fall through to the manual recovery */
  }
  return (
    "Chrome tab not attached to Playwriter. Attaching requires a user " +
    "gesture (Chrome's debugger.attach security model — no programmatic " +
    "workaround exists; agent_do can't help). " +
    "RECOVERY (do this before bouncing to the user): " +
    "1) call screen_screenshot to see whether Chrome is open and on the " +
    "right tab. 2) Give the user ONE concise instruction — 'click the " +
    "green Playwriter icon on the <tab name> tab' if Chrome is visible " +
    "on the right URL, or 'open Chrome to <url> and click the green " +
    "Playwriter icon' if it isn't. Do NOT paste this whole recovery " +
    "message back to the user — they want one action, not instructions. " +
    "Once they click, browser_status will return 'Attached. URL: …' and " +
    "you can proceed."
  );
}

// ── Browser-ensure cache + Ponder session leases ─────────────────────
//
// `ponder_browser_ensure` short-circuits when the same session has
// already been attached successfully — saves a snapshot round-trip on
// every subsequent browser_* call. The cache is per-process and only
// flags "attached"; the actual freshness check happens via
// `browser.available()` inside the tool. Keys are Ponder session
// names (default = "default"; HTTP bridge consumers will pass their
// own key-derived name once auth lands).

const browserEnsureCache = new Map<string, { attached: boolean }>();
const ponderSessions = new Set<string>(["default"]);
let defaultPonderSession = "default";

/** Render a recipe script inline (no header), for embedding in tool
 *  replies as a copy-paste block. Uses the same recorder codegen so
 *  the output matches what's persisted to disk. */
function renderRecipeScriptInline(recipe: RecordedRecipe): string {
  return renderRecipeScript(recipe);
}

// ── Concurrency mutex for agent_do ───────────────────────────────────
//
// `agent_do` runs for tens of seconds and drives the user's ONE Chrome
// session via the shared Playwriter client. Two concurrent agent_do
// calls would stomp on each other's screenshots and clicks. We
// serialize them through a single module-level promise chain.

let _agentDoChain: Promise<unknown> = Promise.resolve();
function chainAgentDo<T>(fn: () => Promise<T>): Promise<T> {
  // .catch(() => null) keeps the chain alive past failures so a thrown
  // error doesn't permanently jam the lock.
  const next = _agentDoChain.catch(() => null).then(fn);
  _agentDoChain = next;
  return next;
}

// ── Electron bridge forwarder ────────────────────────────────────────
//
// When the Electron Holo3 app is running it exposes a localhost HTTP
// bridge at :7900 (or PONDER_BRIDGE_PORT). MCP forwards agent_do calls
// there so the actual screen capture / mouse / keyboard work happens
// inside the Electron process, where the user's macOS Privacy & Security
// perms are granted AND the user's tray-menu provider choice is the
// active provider.
//
// Returns null when the bridge isn't reachable — caller falls through
// to running locally. Returns a tool-result-shaped object when the
// forward succeeds (or fails with a clear bridge error).

const BRIDGE_PORT = Number(process.env.PONDER_BRIDGE_PORT ?? 7900);
const BRIDGE_PROBE_TIMEOUT_MS = 1500;
// Matches HARD_TIMEOUT_MS — 240s gives the executor enough time to
// actually finish a single atomic step instead of getting cut off mid-
// flight (which used to make the orchestrator panic and fire MORE
// agent_do calls while the executor was still warming up). Override
// via PONDER_AGENT_DO_TIMEOUT_MS in .env.
const BRIDGE_RUN_TIMEOUT_MS = Number(
  process.env.PONDER_AGENT_DO_TIMEOUT_MS ?? 240_000,
);

interface BridgeRunResult {
  outcome: "done" | "cancelled" | "exhausted" | "infeasible" | "error";
  sessionId: string | null;
  steps: number;
  finalUrl?: string;
  errorMessage?: string;
  transcript: string[];
  /** Base64 PNG of the final frame the inner loop captured. We attach
   *  this as an image content part to the agent_do tool reply so the
   *  orchestrator gets visual ground truth in the same call. */
  finalScreenshotBase64?: string;
}

/** Quick HEAD/GET probe to see if the bridge is alive. Fast fail
 *  (1.5s) so a missing Electron app doesn't block the MCP for long.
 *
 *  Cached: a 5-second TTL avoids a 1.5s probe per screen_* tool call.
 *  The Electron app starts and stops cleanly so a stale "available"
 *  result self-corrects within the TTL when the user quits the app.
 *  The cache also reduces log spam — without it every screen_screenshot
 *  call printed a probe trace. */
const BRIDGE_AVAIL_TTL_MS = 5_000;
let _bridgeAvailCachedAt = 0;
let _bridgeAvailCachedValue = false;
async function bridgeAvailable(): Promise<boolean> {
  const now = Date.now();
  if (now - _bridgeAvailCachedAt < BRIDGE_AVAIL_TTL_MS) {
    return _bridgeAvailCachedValue;
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), BRIDGE_PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/health`, {
        signal: ctrl.signal,
      });
      _bridgeAvailCachedValue = res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    _bridgeAvailCachedValue = false;
  }
  _bridgeAvailCachedAt = Date.now();
  return _bridgeAvailCachedValue;
}

/** Forward a screen_* primitive (screenshot, type, hotkey, scroll) to the
 *  Electron bridge. Returns the parsed JSON response or null when the
 *  bridge isn't reachable / errored — caller falls back to the local
 *  nut-js path so the MCP still works without Electron running.
 *
 *  Why this exists: the MCP server runs inside Claude Code's process,
 *  which routinely lacks macOS Screen Recording / Accessibility perms.
 *  The orchestrator then sees BLANK screenshots and silent keystrokes
 *  and makes increasingly bad decisions. The Electron app HAS those
 *  perms, so when it's running we route screen.* through it. */
const SCREEN_BRIDGE_TIMEOUT_MS = 8_000;
async function tryBridgeScreenCall<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T | null> {
  if (!(await bridgeAvailable())) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => ctrl.abort(),
      SCREEN_BRIDGE_TIMEOUT_MS,
    );
    try {
      const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        stderrLog(
          `[mcp] bridge ${path} returned ${res.status}: ${text.slice(0, 200)}`,
        );
        return null;
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    stderrLog(
      `[mcp] bridge ${path} call failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

// ── Session-recorder helpers (shared between bridge + local path) ────
//
// Both paths through agent_do produce a RecordedSession (the local
// path streams events into the recorder live; the bridge path parses
// the returned transcript). We render the script block the same way
// in both — that's what the orchestrator gets back in the MCP tool
// reply, ready to copy-paste into the user's own Playwright suite OR
// to feed into ponder_session_replay.
//
// renderScriptBlockFromRecorder uses the recorder's live state
// (refLabels populated from real snapshots); renderScriptBlockFromSession
// works off a RecordedSession reconstructed from a transcript (refLabels
// best-effort).

function renderScriptBlockFromRecorder(
  recorder: SessionRecorder,
  saved: { id: string; jsonPath: string; sessionPath: string } | null,
): string {
  return formatScriptBlock(
    recorder.toSessionScript(),
    saved,
    recorder.getSession(),
  );
}

function renderScriptBlockFromSession(
  session: RecordedSession,
  saved: { id: string; jsonPath: string; sessionPath: string } | null,
): string {
  // Reconstruct refLabels by feeding synthesized AX lines back into a
  // transient recorder — keeps the generated script identical to the
  // one persisted on disk regardless of which path produced the
  // session.
  const rec = createSessionRecorder({
    task: session.task,
    ...(session.provider ? { provider: session.provider } : {}),
    ...(session.surface ? { surface: session.surface } : {}),
  });
  for (const step of session.steps) {
    if (step.intent) rec.onHistory(step.intent);
    if (step.refLabel) {
      const refId =
        typeof step.executed.payload.ref === "string"
          ? (step.executed.payload.ref as string)
          : "e1";
      rec.onBrowserSnapshot({
        url: step.url ?? "",
        title: "",
        ax: `[${refId}] ${step.refLabel.role}${step.refLabel.name ? ` "${step.refLabel.name}"` : ""}`,
      });
    }
    rec.onAction(step.executed);
  }
  if (session.outcome) {
    rec.setOutcome(session.outcome, session.error);
  }
  return formatScriptBlock(rec.toSessionScript(), saved, session);
}

function formatScriptBlock(
  script: string,
  saved: {
    id: string;
    jsonPath: string;
    sessionPath: string;
  } | null,
  session: RecordedSession,
): string {
  if (session.steps.length === 0) {
    return (
      "\n\n— Session script —\n" +
      "(no actions recorded — the run didn't emit any actions before " +
      "terminating; nothing to replay)"
    );
  }
  const lines: string[] = [];
  lines.push("");
  lines.push("");
  lines.push("— Ponder session (Playwriter-flavored, defineSession()) —");
  if (saved) {
    lines.push(`Saved as id="${saved.id}":`);
    lines.push(`  • code      ${saved.sessionPath}     (edit this file)`);
    lines.push(`  • manifest  ${saved.jsonPath}     (source of truth)`);
    lines.push("");
    lines.push("Reuse / re-run / edit:");
    lines.push(
      `  ponder run    ${saved.id}          ${"".padEnd(0)}# terminal CLI`,
    );
    lines.push(
      `  ponder run    ${saved.id} --watch  ${"".padEnd(0)}# edit-and-replay loop`,
    );
    lines.push(
      `  ponder open   ${saved.id}          ${"".padEnd(0)}# open in $EDITOR`,
    );
    lines.push(
      `  npx tsx       ${saved.sessionPath}   # run directly (no CLI)`,
    );
    lines.push(
      `  ponder_session_replay({ id: "${saved.id}" })  # MCP tool, no LLM`,
    );
  } else {
    lines.push(
      "(disk persistence failed — script is below; copy it manually to reuse)",
    );
  }
  lines.push("");
  lines.push("```ts");
  lines.push(script.trimEnd());
  lines.push("```");
  return lines.join("\n");
}

// MCP tool replies can mix text and image content parts. ok() / fail()
// produce text-only results, but agent_do and screen_screenshot also
// return images, so widen the type to admit both shapes.
type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };
type ToolResult =
  | { content: ToolContent[]; isError?: boolean }
  | ReturnType<typeof ok>
  | ReturnType<typeof fail>;

/** Forward an agent_do task to the Electron bridge. Returns:
 *   - { isError, payload } when the bridge handled the call
 *   - null when the bridge isn't reachable (caller should fall back)
 *
 * `opts.surface` is recorded on the script preamble so the user sees
 * what kind of OS surface the run was driving. `opts.rawTask` (vs
 * `task` which has the [Surface: …] framing appended) is what the
 * recorded session pins to disk — keeps the saved spec / id clean. */
async function tryForwardToBridge(
  task: string,
  sendProgress: (msg: string) => Promise<void>,
  opts?: {
    targetApp?: string;
    surface?: string;
    rawTask?: string;
    decompose?: boolean;
    /**
     * Mirror the bridge's transcript steps into the process-wide trace
     * buffer so they appear in whole-flow recipe saves. Pass true ONLY
     * for user-task forwards (agent_do) — ponder_browser_ensure's
     * auto-attach also routes through here, and its toolbar-click
     * machinery must never become recipe steps.
     */
    mirrorTrace?: boolean;
  },
): Promise<{ isError: boolean; payload: ToolResult } | null> {
  if (!(await bridgeAvailable())) return null;
  const bridgeStartedAt = Date.now();

  await sendProgress(
    `Forwarding to Electron bridge at :${BRIDGE_PORT} (Holo3 app handles the work)` +
      (opts?.targetApp ? ` — targetApp="${opts.targetApp}"` : ""),
  );
  const ctrl = new AbortController();
  // Decomposed runs execute up to ~12 verified steps × 8 inner steps —
  // give them a proportionally longer leash than a single atomic step.
  const runTimeoutMs =
    opts?.decompose === true
      ? Math.max(BRIDGE_RUN_TIMEOUT_MS, 600_000)
      : BRIDGE_RUN_TIMEOUT_MS;
  const timer = setTimeout(() => ctrl.abort(), runTimeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/agent_do`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task,
        ...(opts?.targetApp ? { targetApp: opts.targetApp } : {}),
        ...(opts?.decompose === true ? { decompose: true } : {}),
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        isError: true,
        payload: fail(
          `Bridge returned ${res.status}: ${body.slice(0, 500)}`,
        ),
      };
    }
    const result = (await res.json()) as BridgeRunResult;
    // Per-outcome advisory line — same logic as the local-path header in
    // the agent_do handler below. The orchestrator routinely misreads
    // `exhausted` as failure when the goal often already landed; force
    // it to observe state before deciding the next move. Mirrors the
    // bridge-side advisory in electron/main.ts and the local-path
    // advisory in the agent_do handler.
    const advisory =
      result.outcome === "exhausted"
        ? "NOTE: 'exhausted' is NOT the same as failure. The goal may already be partially or fully achieved — the inner brain sometimes emits useless actions after success because it can't always recognize completion from the screen alone. Before retrying or reporting failure, call browser_snapshot AND screen_screenshot, then check whether the goal is already done."
        : result.outcome === "cancelled"
          ? "NOTE: 'cancelled' means the run stopped mid-flight (timeout or user stop). The final state is unknown until observed — call browser_snapshot AND screen_screenshot before deciding the next move."
          : result.outcome === "infeasible"
            ? "NOTE: 'infeasible' is a DELIBERATE verdict — the agent verified a concrete blocker (permission denied, read-only, login wall, system 'can't do that') makes this impossible. This is the CORRECT answer for a trap/impossible task; do NOT just retry. The blocker is in the transcript as 'INFEASIBLE: …' — report it to the user."
            : null;
    // Reconstruct a RecordedSession from the bridge's transcript so we
    // can persist a Playwright script + JSON manifest the user can
    // replay/edit later. The bridge doesn't currently forward
    // onBrowserSnapshot or onHistory separately, so refLabels are best-
    // effort (the parser only recovers the structured action lines +
    // any thought lines preceding them). Still useful as a starting
    // point — the user can refine the resulting script by hand.
    const recordedSession = recordFromBridgeTranscript(
      opts?.rawTask ?? task,
      result.transcript,
      {
        outcome: result.outcome,
        durationMs: Date.now() - bridgeStartedAt,
        ...(result.finalUrl ? { finalUrl: result.finalUrl } : {}),
        ...(opts?.surface ? { surface: opts.surface } : {}),
        provider: "via-bridge",
        ...(result.errorMessage ? { error: result.errorMessage } : {}),
      },
    );
    // Mirror the reconstructed steps into the process-wide trace buffer
    // so a later ponder_recipe_save of the WHOLE flow includes what the
    // bridge did. Without this, bridge-forwarded agent_do segments were
    // silently missing from saved recipes (they only existed in the
    // per-run auto-saved session) — the biggest fidelity gap in the
    // logs→reproducible-script pipeline.
    //
    // Gated on mirrorTrace (agent_do only — never browser_ensure's
    // attach machinery), skipped for error outcomes, skips steps whose
    // payload didn't survive the transcript round-trip (_truncated),
    // and rebases each step's REAL transcript timestamp onto the trace
    // clock so recorded-pacing replay keeps true inter-step deltas.
    if (opts?.mirrorTrace === true && result.outcome !== "error") {
      for (const step of recordedSession.steps) {
        if ((step.executed.payload as { _truncated?: boolean })._truncated) {
          continue; // unreplayable — recording it would halt replays
        }
        recordAction({
          type: step.executed.type,
          payload: step.executed.payload,
          ...(step.intent ? { intent: step.intent } : {}),
          ...(step.refLabel ? { refLabel: step.refLabel } : {}),
          ...(step.url ? { url: step.url } : {}),
          consumer: "bridge:agent_do",
          atEpochMs: bridgeStartedAt + step.t,
        });
      }
    }
    const saved = await saveSession(recordedSession);
    const scriptBlock = renderScriptBlockFromSession(recordedSession, saved);

    const header = [
      `Outcome: ${result.outcome} (via Electron bridge)`,
      `Steps: ${result.steps}`,
      advisory,
      result.finalUrl ? `Final URL: ${result.finalUrl}` : null,
      result.errorMessage ? `Error: ${result.errorMessage}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    const body =
      result.transcript.length > 0
        ? `\n\nTranscript:\n${result.transcript.join("\n")}`
        : "\n\n(no events emitted)";
    const text = header + body + scriptBlock;
    if (result.outcome === "error") {
      return { isError: true, payload: fail(text) };
    }
    // Attach the bridge's final-frame screenshot as an image content
    // part — the orchestrator gets visual ground truth in the same
    // tool reply, eliminating the need for a follow-up screen_screenshot
    // (which the small Holo3 model often skips, leading to panic-retries
    // on `exhausted`).
    const responseContent: Array<
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string }
    > = [{ type: "text" as const, text }];
    if (result.finalScreenshotBase64) {
      responseContent.push({
        type: "image" as const,
        data: result.finalScreenshotBase64,
        mimeType: "image/png",
      });
    }
    return { isError: false, payload: { content: responseContent } };
  } catch (e: unknown) {
    return {
      isError: true,
      payload: fail(
        `Bridge call failed: ${e instanceof Error ? e.message : String(e)}`,
      ),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── Convex client (optional) ─────────────────────────────────────────
//
// When VITE_CONVEX_URL (or CONVEX_URL) is set in .env, the MCP server
// records every agent_do session + step to the same Convex backend the
// Electron app uses. That makes MCP-initiated runs visible in the
// Electron app's History page alongside Electron-initiated runs.
//
// When the env var isn't set we silently skip persistence — agent_do
// still works, the run just doesn't show up in History.
//
// Construction is lazy so cold-boot of the MCP server isn't slowed by
// a Convex round-trip the user may not need.

let _convexClient: ConvexHttpClient | null | undefined = undefined;
function getConvex(): ConvexHttpClient | null {
  if (_convexClient !== undefined) return _convexClient;
  const url = process.env.VITE_CONVEX_URL ?? process.env.CONVEX_URL;
  if (!url) {
    _convexClient = null;
    return null;
  }
  try {
    _convexClient = new ConvexHttpClient(url);
    stderrLog(`[mcp] convex persistence enabled (${url})`);
    return _convexClient;
  } catch (e) {
    stderrLog(
      `[mcp] convex client init failed (${e instanceof Error ? e.message : String(e)}) — history persistence disabled`,
    );
    _convexClient = null;
    return null;
  }
}

// ── Best-effort macOS perms probe (Electron-API; safe to fail) ───────
//
// Mirrors checkActionPermissions() in electron/main.ts:451-461. We do
// this through a dynamic import so the MCP server (plain Node, NOT
// Electron) doesn't crash trying to read systemPreferences. When the
// probe is unavailable we just skip — the user's host process (Claude
// Code, Terminal, etc.) needs the perms anyway, and screenshots will
// fail loudly if Screen Recording is missing.

async function probePermsBestEffort(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    // Dynamic import + try/catch: in non-Electron contexts `electron`
    // resolves to a path string and `systemPreferences` is undefined,
    // which would throw on first method call. Catching here means we
    // simply don't probe in MCP-from-Node — the user's host process is
    // what needs perms and we'd be probing the wrong app anyway.
    const mod = (await import("../perms.js")) as typeof import("../perms.js");
    const r = await mod.probe();
    const missing: string[] = [];
    if (r.accessibility !== "granted") missing.push("Accessibility");
    if (r.screenRecording !== "granted") missing.push("Screen Recording");
    if (missing.length === 0) return null;
    return (
      `${missing.join(" + ")} permission missing for the host process. ` +
      "Open System Settings → Privacy & Security → " +
      missing.join(" + ") +
      ", enable the app launching this MCP server (Claude Code / Terminal " +
      "/ Claude Desktop / etc.), then restart it."
    );
  } catch {
    // Probe not available (non-Electron context, perms.ts couldn't
    // load systemPreferences, etc.). Proceed without gating; the
    // first screenshot or click will surface a clear error from the
    // OS if perms are actually missing.
    return null;
  }
}

/**
 * Register all browser+screen tools on the given McpServer instance.
 * Call once per `new McpServer(...)` — for stdio that's once at boot;
 * for HTTP it's once per request (servers are constructed per-request
 * in stateless mode).
 */
export function registerTools(server: McpServer): void {
  // ── HIGH-LEVEL: hand off a focused subtask to the inner Holo3 loop ──
  //
  // PREFERRED entry point. Describe WHAT you want, not HOW. The inner
  // loop handles screenshots, vision-grounding, browser refs, anti-stuck
  // guards, and step budgeting internally. Use this for any goal-shaped
  // ask — the orchestrator should NOT try to coordinate clicks itself.
  server.registerTool(
    "agent_do",
    {
      title: `${MCP_BRAND}: Do ONE atomic OS-level mouse step`,
      description:
        "Run ONE atomic OS-level mouse-aimed step that you can't do with browser_* / " +
        "screen_type / screen_hotkey alone. The orchestrator declares the SURFACE " +
        "explicitly (file-picker, finder, spotlight, dock, menu-bar, native-dialog, " +
        "drag-drop, other) so we don't have to infer it from the task text — that " +
        "inference produced false positives in the past (rejecting valid Finder " +
        "tasks because they didn't say 'finder', accepting compound tasks that " +
        "happened to have few commas). " +
        "Examples of GOOD inputs (with surface): " +
        "{task: 'select the most recent screenshot and click Open', surface: " +
        "'file-picker'}; {task: 'click the green Playwriter extension icon', " +
        "surface: 'menu-bar'}; {task: 'drag the README.md icon to the trash', " +
        "surface: 'drag-drop'}. " +
        "Anti-pattern: passing surface='other' for an in-Chrome click — for " +
        "anything with a [eN] ref in browser_snapshot use browser_click instead, " +
        "regardless of surface. " +
        "Capped at 8 inner steps by default — atomic means atomic; if the brain " +
        "can't finish in ~8 steps the orchestrator should re-plan with fresh state " +
        "via browser_snapshot / screen_screenshot. Auto-forwards to the Electron " +
        "Holo3 app's bridge when running so your tray-menu provider + perms are in " +
        "effect. Returns a transcript + outcome (done | exhausted | " +
        "cancelled | infeasible). 'infeasible' is a deliberate, verified " +
        "verdict that a concrete blocker makes the task impossible — treat " +
        "it as a real answer, not a failure to retry." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        task: z
          .string()
          .min(1)
          .describe(
            "Natural-language description of ONE atomic mouse-aimed step. Should fit " +
              "in one sentence. The inner brain is small — keep tasks tight (one verb, " +
              "one target). For multi-step goals, decompose into multiple tool calls " +
              "and observe state (browser_snapshot / screen_screenshot) between them, " +
              "or pass multistep:true to let the inner loop decompose once and " +
              "verify-advance through the steps itself.",
          ),
        multistep: z
          .boolean()
          .optional()
          .describe(
            "Declare the task as genuinely multi-step (e.g. 'enter 47×8 on the " +
              "calculator and read the result'). The inner loop then makes ONE " +
              "strong-model planning call to split it into atomic steps and only " +
              "advances past each step when a verifier confirms it landed — fixes " +
              "the mis-sequencing failure mode where the per-step brain loses track " +
              "of which sub-step it is on. Requires the PONDER_DECOMPOSE env gate " +
              "on the server; without it this flag is inert and the task runs flat. " +
              "Leave unset for true single-action calls (the common case).",
          ),
        // Marked optional in the schema so a missing value falls
        // through to our handler-side validator, which returns a
        // friendly LLM-shaped error message instead of the bare Zod
        // "Required" payload (the MCP SDK formats Zod errors as raw
        // JSON which is hard for the model to act on). The
        // description still says REQUIRED so well-formed callers
        // include it.
        surface: z
          .enum([
            "file-picker",
            "finder",
            "spotlight",
            "dock",
            "menu-bar",
            "native-dialog",
            "drag-drop",
            "other",
          ])
          .optional()
          .describe(
            "REQUIRED. Where the action lands. " +
              "'file-picker' = Open/Save dialog (typically opened by a Chrome upload " +
              "button — but PREFER browser_set_input_files when you can; it skips the " +
              "dialog entirely). " +
              "'finder' = a Finder window. " +
              "'spotlight' = the Spotlight overlay. " +
              "'dock' / 'menu-bar' = those macOS chrome surfaces. " +
              "'native-dialog' = any other system prompt (permission, alert, system " +
              "settings). " +
              "'drag-drop' = OS-level drag where source or target is outside Chrome. " +
              "'other' = anything that doesn't fit. " +
              "If the action is in a Chrome page, do NOT use agent_do — use " +
              "browser_click / browser_type / browser_set_input_files with a [eN] " +
              "ref instead.",
          ),
        context: z
          .string()
          .optional()
          .describe(
            "Optional one-sentence framing for the inner brain. e.g. \"we're " +
              'uploading a screenshot to a Marketplace listing". Helps the brain ' +
              "disambiguate weird intermediate states. Keep it short — gets prepended " +
              "to the brain's per-step prompt.",
          ),
        goal: z
          .string()
          .optional()
          .describe(
            "Optional higher-level goal this atomic step contributes to. Threaded " +
              "into the brain's prompt as `(this is part of: …)` so it stays oriented " +
              "when the immediate task is just the next mechanical step.",
          ),
        targetApp: z
          .string()
          .optional()
          .describe(
            "macOS-only speedup. When set, every screenshot the inner Holo3 loop " +
              "takes is cropped to the front window of this process before being sent " +
              "to /plan and /ground. Empirically a 6× wall-time reduction per step " +
              "for a typical 230×408 app window vs. a 1512×982 full-screen capture " +
              "(image-patch tokens scale with pixel count: ~4100 → ~175 per call). " +
              "ALSO defends against the embedded-screenshot decoy (when a chat / IDE " +
              "elsewhere on the same display is showing a screenshot of the same app, " +
              "the vision model can ground against the picture instead of the real " +
              "window — cropping deletes the decoy from the model's input). " +
              "Use the System Events process name: 'Calculator', 'Finder', 'Safari', " +
              "'Google Chrome', etc. Falls back to uncropped grounding silently if " +
              "the app isn't running, has no front window, or the bridge's window-" +
              "bounds query fails — never blocks the run.",
          ),
      },
    },
    async ({ task, surface, context, goal, targetApp, multistep }, extra) => {
      return chainAgentDo(async () => {
        const t0 = Date.now();

        // Surface is REQUIRED. The schema marks it optional only so we
        // can return this friendly message instead of the bare Zod
        // "Required" error the MCP SDK would otherwise emit (which
        // shows up as a raw JSON validation payload in the orchestrator's
        // tool result — hard to act on). The text-heuristic guards
        // (compound-task by separator count, in-Chrome by click-verb
        // regex) that used to live here are intentionally GONE — they
        // generated too many false positives by inferring intent from
        // punctuation and verb shape. The orchestrator now declares
        // surface explicitly; that's the contract.
        if (!surface) {
          return fail(
            "agent_do requires a `surface` declaration so we know what kind of " +
              "OS surface you're driving (and confirm the target isn't reachable " +
              "via browser_*). Pass one of:\n" +
              "  • file-picker — native Open/Save dialog\n" +
              "  • finder — a Finder window\n" +
              "  • spotlight — the Spotlight overlay\n" +
              "  • dock — the macOS dock\n" +
              "  • menu-bar — the macOS menu bar / status icons\n" +
              "  • native-dialog — system permission/alert prompts\n" +
              "  • drag-drop — OS-level drag-and-drop (source or target outside Chrome)\n" +
              "  • other — anything else (also supply `context` describing the surface)\n\n" +
              "If the action is in a Chrome page (anything with a [eN] ref in " +
              "browser_snapshot), use browser_click / browser_type / " +
              "browser_set_input_files instead — agent_do does not see Chrome's " +
              "accessibility tree and will vision-ground from pixels.\n\n" +
              "Need a file path on disk for an upload? Use a Bash tool " +
              "(ls -t ~/Desktop/Screenshot*.png | head -1, find …, mdfind …) " +
              "to read the path, then pass it to browser_set_input_files. " +
              "Do NOT call agent_do(surface: 'finder') just to find a file.",
          );
        }
        // Belt-and-suspenders: 'other' is the catch-all surface, and a
        // missing context strongly suggests an in-Chrome click was meant.
        if (surface === "other" && !context) {
          return fail(
            "agent_do called with surface='other' and no context. The 'other' " +
              "surface is for genuinely unusual cases (a third-party native window, " +
              "a custom OS overlay) — supply a context string explaining what's on " +
              "screen so the inner brain has framing. If this is actually an " +
              "in-Chrome click, switch to browser_click(ref) — agent_do does not " +
              "see Chrome's accessibility tree and will vision-ground from pixels.",
          );
        }
        // Build the inner-brain task: prepend context (if given) so the
        // brain has framing, and let runTask thread `goal` as overallGoal.
        const augmentedTask = context
          ? `${task}\n[Context: ${context}; surface: ${surface}]`
          : `${task}\n[Surface: ${surface}]`;

        // Progress notifications keep the MCP client's per-request
        // timeout from firing on long tasks. Each notification resets
        // the deadline. We send one for every status/thought/action so
        // a 90s agent_do never trips the client's 30-60s default.
        // No-op if the client didn't pass a progressToken.
        const progressToken =
          (extra as { _meta?: { progressToken?: string | number } } | undefined)
            ?._meta?.progressToken;
        let progressCount = 0;
        const sendProgress = async (msg: string): Promise<void> => {
          if (progressToken === undefined) return;
          progressCount += 1;
          try {
            await extra!.sendNotification({
              method: "notifications/progress",
              params: {
                progressToken,
                progress: progressCount,
                message: msg.length > 200 ? msg.slice(0, 197) + "..." : msg,
              },
            });
          } catch {
            // Best-effort: client may have disconnected, that's fine.
          }
        };

        // ── Try the Electron bridge first ─────────────────────────────
        //
        // The Electron Holo3 app, if running, exposes a localhost HTTP
        // bridge at :7900 (or PONDER_BRIDGE_PORT) where macOS Privacy
        // perms (Screen Recording, Accessibility) ARE granted. The MCP
        // server runs in a separate process spawned by Claude Code
        // where those perms are typically NOT granted, so screen
        // capture fails on step 0. Forwarding to the bridge solves
        // that — and as a bonus the user's tray-menu provider choice
        // is automatically active (the bridge runs against the
        // Electron app's WarmupQueue + provider state).
        //
        // Probe is short (1.5s timeout) so a missing bridge falls
        // through to the local path quickly.
        // Forward the augmented task (with surface + context baked in)
        // so the bridge-side runTask sees the same framing the local
        // path would. The bridge protocol is task-only today; threading
        // surface/goal as separate fields is a follow-up that requires
        // an Electron-side bump.
        const bridgeResult = await tryForwardToBridge(
          augmentedTask,
          sendProgress,
          {
            targetApp,
            surface,
            rawTask: task,
            decompose: multistep === true,
            mirrorTrace: true,
          },
        );
        if (bridgeResult !== null) {
          stderrLog(
            `[mcp] agent_do forwarded to bridge: outcome=${bridgeResult.isError ? "error" : "ok"}`,
          );
          return bridgeResult.payload;
        }

        // Bridge not available — fall through to running locally.
        // Best-effort perms probe (will likely fail here too, but at
        // least the error message is clearer).
        const permsMsg = await probePermsBestEffort();
        if (permsMsg) return fail(permsMsg);

        let provider: ProviderClient;
        let warmError: string | null = null;
        try {
          ({ provider, warmError } = await getProviderWarmed());
        } catch (e: unknown) {
          // This catch handles the "provider not configured" case
          // (no API key, no Modal creds, etc.) — that's a hard config
          // error, not a transient upstream issue. Surface clearly.
          return fail(
            `Provider not configured: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
        if (warmError) {
          // Warmup transient failure (503, rate limit, network blip).
          // Log to the transcript so the orchestrator sees it, but
          // proceed — runTask may succeed against a freshly-recovered
          // endpoint.
          await sendProgress(
            `Warmup probe returned ${warmError}; proceeding anyway`,
          );
        }

        // TANDEM MODE: vision and CDP run side-by-side, not as fallbacks.
        // Sites are visual AND code-heavy; the orchestrator's `surface`
        // declaration lets us bias correctly per step.
        //
        // We pass BOTH the browser and the router to runTask:
        //   • browser → captures the Chrome accessibility snapshot every
        //     step. The brain sees Chrome refs alongside the screenshot
        //     and can emit `browser.click eN` even on agent_do calls
        //     (e.g., dismissing Chrome UI after an OS-level upload).
        //   • router → qwen3.5:0.8b short-circuits browser.* actions in
        //     ~500ms when the snapshot covers the goal. Saves a Holo3
        //     round-trip on every step where Chrome IS the right surface.
        //
        // The historical reason for null/null was correct then but obsolete
        // now. Two newer guards make tandem mode safe:
        //   1. `browserStalled` in loop.ts (snapshot byte-equal across
        //      steps but screen pixels moved) detects OS overlays on top
        //      of Chrome and forces vision for that step + tells the
        //      brain via routerHint that the AX tree is stale.
        //   2. The `surface` enum in agent_do is threaded into the brain
        //      task as `[Surface: file-picker]` etc., so the brain knows
        //      it's operating an OS surface even on step 1 (before any
        //      stall-detect history exists).
        // Together those mean the router won't hijack a file-picker step
        // by emitting `browser.click eN` against the page underneath.
        // Best-effort: if Playwriter isn't attached, browser stays null
        // and we run vision-only — same as before.
        const browser = await getBrowserOrNull();
        const router = getRouter();
        const mode =
          browser && router
            ? "tandem"
            : browser
              ? "vision+browser"
              : router
                ? "vision+router"
                : "vision-only";
        await sendProgress(
          `Started agent_do (provider=${provider.name}, mode=${mode}, surface=${surface})`,
        );
        stderrLog(
          `[mcp] agent_do start: surface=${surface} mode=${mode} task="${task.length > 80 ? task.slice(0, 77) + "..." : task}"` +
            (goal ? ` goal="${goal.slice(0, 60)}"` : ""),
        );

        // Convex persistence — when VITE_CONVEX_URL is set, mirror
        // every event to Convex so this agent_do appears in the
        // Electron app's History page alongside Electron-initiated
        // sessions. Failures here are NEVER fatal: the orchestrator
        // already gets the transcript in the tool result, Convex is
        // purely a UI nicety.
        const convex = getConvex();
        let sessionId: string | null = null;
        if (convex) {
          try {
            const id = (await convex.mutation(convexApi.sessions.create, {
              prompt: task,
              provider: executorNameFor(provider.name),
            })) as unknown as string;
            sessionId = id;
            await convex.mutation(convexApi.sessions.setStatus, {
              sessionId: id as never,
              status: "running",
            });
          } catch (e) {
            stderrLog(
              `[mcp] convex session create failed (${e instanceof Error ? e.message : String(e)}) — continuing without history persistence`,
            );
          }
        }
        type StepArgs =
          | { kind: "thought" | "status" | "error" | "result"; text: string }
          | { kind: "ground"; coords: { x: number; y: number } }
          | {
              kind: "action";
              action: { type: string; payload: Record<string, unknown> };
            };
        const persistStep = async (args: StepArgs): Promise<void> => {
          if (!convex || !sessionId) return;
          try {
            await convex.mutation(convexApi.steps.append, {
              sessionId: sessionId as never,
              ...args,
            });
          } catch {
            // Schema drift, network blip — silent skip.
          }
        };

        // Build the transcript callbacks. We capture every event into a
        // single text array, prefixed with elapsed seconds so the
        // outer model can read what happened in order. We ALSO pump
        // each event into a progress notification so the MCP client's
        // request timeout never fires on long tasks AND mirror to
        // Convex so the History view sees this run.
        const transcript: string[] = [];
        const elapsed = (): string =>
          `[t=${((Date.now() - t0) / 1000).toFixed(1)}s]`;
        let lastSnapshot: BrowserSnapshot | undefined;
        // Latch the most recent screenshot PNG so we can attach it to the
        // tool reply. Without this the orchestrator gets transcript-only
        // and has to call screen_screenshot itself to see the final state
        // (which the small Holo3 model often forgets to do, leading to
        // panic-retries on `exhausted`). Including the final frame in the
        // agent_do response gives the orchestrator visual ground truth in
        // the same tool call.
        let lastPng: Buffer | undefined;
        let stepCount = 0;

        // Session recorder — captures every emitted action + the
        // natural-language intent + the AX snapshot at the time of the
        // action, so we can render a self-contained Playwright spec
        // file at end-of-run. The user gets the script inline in the
        // MCP reply AND on disk under ~/.holo3-agent/sessions/, so
        // they can replay it later via ponder_session_replay or paste
        // it into their own Playwright suite. The recorder is purely
        // observational — it never changes runTask's behavior.
        const recorder = createSessionRecorder({
          task,
          provider: executorNameFor(provider.name),
          surface,
        });

        const events: AgentEvents = {
          onStatus: async (text) => {
            transcript.push(`${elapsed()} status: ${text}`);
            await sendProgress(`status: ${text}`);
            await persistStep({ kind: "status", text });
          },
          onThought: async (text) => {
            transcript.push(`${elapsed()} thought: ${text}`);
            await sendProgress(`thought: ${text}`);
            await persistStep({ kind: "thought", text });
          },
          onGround: async (coords) => {
            await persistStep({ kind: "ground", coords });
          },
          onAction: async (action) => {
            stepCount += 1;
            const payload =
              action.payload && Object.keys(action.payload).length > 0
                ? ` ${JSON.stringify(action.payload).slice(0, 120)}`
                : "";
            transcript.push(`${elapsed()} action: ${action.type}${payload}`);
            await sendProgress(`action: ${action.type}${payload}`);
            await persistStep({ kind: "action", action });
            // Record the structured action so the post-run script
            // generator can emit a Playwright statement for it. The
            // recorder consumes the most recent onHistory text as the
            // step's "intent" comment.
            recorder.onAction(action);
          },
          onScreenshot: async (png) => {
            // Latch the latest frame for the final tool reply.
            lastPng = png;
            // Tiny progress ping; we don't upload the PNG to Convex
            // (would balloon storage, MCP runs are usually short).
            await sendProgress("screenshot");
          },
          onError: async (message) => {
            transcript.push(`${elapsed()} error: ${message}`);
            await sendProgress(`error: ${message}`);
            await persistStep({ kind: "error", text: message });
          },
          onResult: async (text) => {
            transcript.push(`${elapsed()} result: ${text}`);
            await sendProgress(`result: ${text}`);
            await persistStep({ kind: "result", text });
          },
        };

        // Hard 90s ceiling. Slightly under the typical 120s server-side
        // limit and well above Claude Code's default ~30s client-side
        // window. Progress notifications keep the client awake within
        // this window so a long inner loop doesn't trip its timeout.
        // Override with PONDER_AGENT_DO_TIMEOUT_MS in .env.
        //
        // Bumped from 90s → 240s. With H Company's 6.5s rate-limit pause
        // the per-step cost is ~10–13s; 90s = ~7 steps which often kills
        // the executor "just as it's getting started", and the
        // orchestrator then panics and fires more agent_do calls instead
        // of observing the in-progress state. 240s = ~22 steps at hcompany
        // pace and ~150 steps at local pace, matching MAX_STEPS (50) for
        // the standard provider mix. Progress notifications continue to
        // keep the MCP client's per-request timer fresh during the run.
        const HARD_TIMEOUT_MS = Number(
          process.env.PONDER_AGENT_DO_TIMEOUT_MS ?? 240_000,
        );
        let timedOut = false;
        const cancelled = (): boolean =>
          timedOut || (extra?.signal?.aborted ?? false);

        let outcome: "done" | "cancelled" | "exhausted" | "infeasible" | "error" = "error";
        let errorMsg: string | undefined;
        const timeoutHandle = setTimeout(() => {
          timedOut = true;
        }, HARD_TIMEOUT_MS);

        try {
          outcome = await runTask({
            task: augmentedTask,
            provider,
            events,
            browser,
            router,
            // agent_do is "ONE atomic OS-level mouse step" by contract —
            // skip the hierarchical Ollama planner so it can't over-
            // decompose into wrong subtasks ("Open Chrome" when Chrome
            // is already open) that the brain can't recognize as DONE.
            // See loop.ts RunOptions.flat for the rationale.
            flat: true,
            // Declared-multi-step decomposition (NEXT-WORK Item 2);
            // inert unless PONDER_DECOMPOSE is also on server-side.
            ...(multistep === true ? { decompose: true } : {}),
            // Tandem-mode safety: forward the declared surface so the
            // loop can seed step 1's routerHint and suppress the router
            // when an OS overlay is on top of Chrome. From step 2
            // onward browserStalled handles it.
            surface,
            // Cap inner steps tight. Atomic means atomic — if 8 steps
            // can't get there, the orchestrator should re-plan with
            // fresh state via browser_snapshot / screen_screenshot
            // instead of letting the brain spin for 50 retries. Override
            // via PONDER_AGENT_DO_MAX_STEPS for legacy callers.
            maxSteps: Number(process.env.PONDER_AGENT_DO_MAX_STEPS ?? 8),
            // Tighter inter-step pause for atomic OS-level work. UI
            // settle is handled separately (settleMs: 250ms base,
            // 1400ms post-type, 2500ms post-Spotlight); this is just
            // the inter-step breather. 500ms (was 1500ms) — with
            // native-res crops a step is ~2-4s, so the old pause was
            // a third of the step. Override via
            // PONDER_AGENT_DO_STEP_PAUSE_MS.
            stepPause: Number(process.env.PONDER_AGENT_DO_STEP_PAUSE_MS ?? 500),
            // Thread the orchestrator's optional higher-level goal so
            // the brain stays oriented if the immediate task is just a
            // mechanical step.
            overallGoal: goal,
            shouldCancel: cancelled,
            onBrowserSnapshot: (snap) => {
              lastSnapshot = snap;
              // Feed the snapshot to the recorder so it can resolve
              // [eN] refs to role+name labels for the Playwright export.
              recorder.onBrowserSnapshot(snap);
            },
            // Capture the brain's natural-language action text. This is
            // what the recorder pairs with the next onAction event so
            // each generated Playwright statement gets an "// click on
            // the Open button"-style intent comment.
            onHistory: (entry) => {
              recorder.onHistory(entry);
            },
          });
          if (timedOut) outcome = "cancelled";
        } catch (e: unknown) {
          errorMsg = e instanceof Error ? e.message : String(e);
          outcome = "error";
        } finally {
          clearTimeout(timeoutHandle);
        }

        // Per-outcome advisory line. The orchestrator (outer Claude)
        // routinely misreads `exhausted` as "the task failed" and either
        // gives up or fires another agent_do without observing — but
        // exhausted is the most common shape for "the goal already
        // landed and the brain didn't recognize completion before
        // anti-loop fired" (e.g., file picker closed and upload thumbnail
        // appeared, but the brain emitted dock-clicks). Force the
        // orchestrator to observe before deciding the next move. Same
        // applies to cancelled (timeout / user stop) — final state is
        // unknown until observed.
        const advisory =
          outcome === "exhausted"
            ? "NOTE: 'exhausted' is NOT the same as failure. The goal may already be partially or fully achieved — the inner brain sometimes emits useless actions after success because it can't always recognize completion from the screen alone. Before retrying or reporting failure, call browser_snapshot AND screen_screenshot, then check whether the goal is already done."
            : outcome === "cancelled"
              ? "NOTE: 'cancelled' means the run stopped mid-flight (timeout or user stop). The final state is unknown until observed — call browser_snapshot AND screen_screenshot before deciding the next move."
              : outcome === "infeasible"
                ? "NOTE: 'infeasible' is a DELIBERATE verdict — the agent verified a concrete blocker (permission denied, read-only, login wall, system 'can't do that') makes this impossible. This is the CORRECT answer for a trap/impossible task; do NOT just retry. The blocker is in the transcript as 'INFEASIBLE: …' — report it to the user."
                : null;

        const header = [
          `Outcome: ${outcome}${
            timedOut ? ` (hit ${Math.round(HARD_TIMEOUT_MS / 1000)}s timeout)` : ""
          }`,
          `Steps: ${stepCount}`,
          advisory,
          lastSnapshot ? `Final URL: ${lastSnapshot.url}` : null,
          errorMsg ? `Error: ${errorMsg}` : null,
        ]
          .filter(Boolean)
          .join("\n");

        const body =
          transcript.length > 0
            ? `\n\nTranscript:\n${transcript.join("\n")}`
            : "\n\n(no events emitted)";

        // Finalize the recorder + persist to disk. We do this BEFORE
        // building the response so the script block is part of the
        // text the orchestrator (and the user) see in the tool reply.
        // saveSession is best-effort — when it fails (disk full, perms
        // denied) we still embed the script inline so the run isn't
        // wasted.
        recorder.setOutcome(outcome, errorMsg);
        const saved = await saveSession(recorder);
        if (saved) {
          stderrLog(
            `[mcp] agent_do session saved: id="${saved.id}" steps=${recorder.getSession().steps.length}`,
          );
        }
        const scriptBlock = renderScriptBlockFromRecorder(recorder, saved);

        const finalText = header + body + scriptBlock;

        // Persist the final agent_do response as a "result" step so the
        // History page shows what the orchestrator received. This is
        // the closing summary the user wanted to see in History — for
        // Electron-initiated runs the extractor produces it; for MCP
        // runs there's no extractor so the transcript-with-header IS
        // the result.
        if (sessionId && convex) {
          try {
            await persistStep({ kind: "result", text: finalText });
            await convex.mutation(convexApi.sessions.setStatus, {
              sessionId: sessionId as never,
              status:
                outcome === "done"
                  ? "done"
                  : outcome === "cancelled"
                    ? "cancelled"
                    : "error",
              error: errorMsg,
            });
          } catch (e) {
            stderrLog(
              `[mcp] convex finalize failed (${e instanceof Error ? e.message : String(e)})`,
            );
          }
        }

        // Build the final response. Include the latched final-frame
        // screenshot as an image content part when available — gives the
        // orchestrator visual ground truth in the same tool call so it
        // doesn't have to (1) trust the transcript blindly or (2) chain
        // a screen_screenshot just to see what landed. This is the
        // single biggest mitigation for the "orchestrator panics on
        // exhausted" pattern: it can SEE the screen right next to the
        // transcript and decide whether the goal landed.
        //
        // We deliberately do NOT include the screenshot when the run
        // was an `error` (no useful frame typically — error happens
        // before / during capture) or when no frame was ever latched
        // (provider failed before step 1's screenshot).
        const responseContent: Array<
          | { type: "text"; text: string }
          | { type: "image"; data: string; mimeType: string }
        > = [{ type: "text" as const, text: finalText }];
        if (lastPng && outcome !== "error") {
          responseContent.push({
            type: "image" as const,
            data: lastPng.toString("base64"),
            mimeType: "image/png",
          });
        }

        // Only treat actual exceptions as errors. `exhausted` and
        // `cancelled` are valid outcomes — the outer model decides
        // what to do with the transcript.
        if (outcome === "error") return fail(finalText);
        return { content: responseContent };
      });
    },
  );

  server.registerTool(
    "agp_do",
    {
      title: `${MCP_BRAND}: Run a whole browser task on the server-side AGP brain`,
      description:
        "Run an END-TO-END in-Chrome task on H-company's server-side Holo 3.1 agent — " +
        "the SAME brain the HoloTab extension uses. holo3-agent acts as a thin DRIVER: " +
        "the agent plans AND grounds on the server and streams driver commands " +
        "(navigate, observe, click, type, extract_table, extract_markdown, fill_form, " +
        "scroll, new_tab, …) which we execute against the user's real Chrome via the " +
        "Playwriter relay. There are NO client-side per-step screenshots or model " +
        "round-trips, so this is the FAST path for multi-step web work: searching, " +
        "browsing, filling forms, and bulk-extracting structured data from a page. " +
        "Give it the WHOLE goal in one call (e.g. 'find the 3 cheapest 1997 Camrys on " +
        "Marketplace and report title+price+link'), not one atomic step. " +
        "Contrast with agent_do, which runs the LOCAL composite vision loop ONE atomic " +
        "OS-level step at a time — use agent_do only for OS surfaces outside Chrome " +
        "(Finder, file-picker, menu-bar). For anything that happens inside a Chrome " +
        "page, prefer agp_do. Requires HAI_API_KEY and an attached Playwriter tab " +
        "(same as the browser_* tools). Returns the run status, the agent's final " +
        "answer, and a compact transcript of the commands it drove." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        task: z
          .string()
          .min(1)
          .describe(
            "The full natural-language goal to accomplish in the browser. Unlike " +
              "agent_do, this is NOT one atomic step — describe the whole task and let " +
              "the server brain plan it (e.g. 'list my Facebook Marketplace items with " +
              "their prices and sold/active status').",
          ),
        startUrl: z
          .string()
          .url()
          .optional()
          .describe(
            "Optional URL the brain should start on. If omitted, the brain works from " +
              "the currently-attached tab (so navigate there first, or pass it here).",
          ),
        agent: z
          .string()
          .optional()
          .describe(
            "Optional AGP agent id override. Defaults to the live EU Holo 3.1 HoloTab " +
              "agent. Only set this if you know a specific client-driven agent id.",
          ),
        timeoutSec: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Overall wall-clock budget in seconds (default 600)."),
        maxCommands: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Hard cap on driver commands executed (runaway backstop; default 120)."),
      },
    },
    async ({ task, startUrl, agent, timeoutSec, maxCommands }) => {
      // Serialize against agent_do: both drive the user's ONE Chrome session
      // through the shared Playwriter client, so they must not run concurrently.
      return chainAgentDo(async () => {
        const client = getAgpClient();
        if (!client.configured) {
          return fail(
            "AGP brain not configured. Set HAI_API_KEY (or HCOMPANY_API_KEY) in the " +
              "environment so holo3-agent can authenticate to H-company's Agent " +
              "Platform. Until then, use agent_do (local composite loop) instead.",
          );
        }
        const notAttached = await ensureAttached();
        if (notAttached) return fail(notAttached);
        const browser = await getBrowser();

        // Collect a compact transcript from the server event + command streams.
        const trace: string[] = [];
        const result = await runAgpTask({
          task,
          startUrl: startUrl ?? null,
          agentId: agent,
          client,
          browser,
          timeoutMs: timeoutSec ? timeoutSec * 1000 : undefined,
          maxCommands,
          onEvent: (ev) => {
            if (ev.kind === "policy_event" && ev.text) {
              trace.push(`· ${ev.text.replace(/\s+/g, " ").slice(0, 200)}`);
            } else if (ev.kind === "error_event" && ev.error) {
              trace.push(`! ${ev.error.slice(0, 200)}`);
            }
          },
          onCommand: (name, args) => {
            const argStr = Object.keys(args).length
              ? ` ${JSON.stringify(args).slice(0, 100)}`
              : "";
            trace.push(`  - ${name}${argStr}`);
          },
        });

        const head = `AGP ${result.status} — ${result.commandCount} commands (traj ${
          result.trajectoryId ?? "?"
        }).`;
        const answer = result.answer ? `\n\nAnswer:\n${result.answer}` : "";
        const err = result.error ? `\n\nError: ${result.error}` : "";
        // Last 40 trace lines keep the reply bounded on long runs.
        const tail = trace.length ? `\n\nTranscript:\n${trace.slice(-40).join("\n")}` : "";
        const body = `${head}${answer}${err}${tail}`;
        return result.status === "failed" || result.status === "error"
          ? fail(body)
          : ok(body);
      });
    },
  );

  server.registerTool(
    "long_task",
    {
      title: `${MCP_BRAND}: Run a long, multi-step task (orchestrated)`,
      description:
        "Run a BIG multi-step goal end-to-end. Decomposes the goal into sub-tasks ONCE, " +
        "then runs each via the cheapest capable path — replay a saved automation › a " +
        "coarse extract/write › the AGP agent — and checkpoints progress to a durable run " +
        "file so it RESUMES after a crash/restart (pass back the returned runId). " +
        "Accumulated rows live in a scratchpad, not the context, so it scales to hundreds " +
        "of steps without blowing up cost. Use this for goals like 'list/collect/cross-post/" +
        "reprice across many items or pages'. For a single atomic action use browser_* or " +
        "agp_do instead. Needs HAI_API_KEY (agent tier) + an attached Chrome tab. Returns " +
        "status, the sub-task trace, accumulated row count, and the runId to resume." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        goal: z.string().min(1).describe("The full high-level goal to accomplish."),
        maxSubtasks: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Cap how many sub-tasks run (default: all)."),
        maxAgentCalls: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Cap the expensive AGP-agent tier — the cost/drift governor."),
        runId: z
          .string()
          .optional()
          .describe("Resume a prior run: pass the runId it returned; completed sub-tasks are skipped."),
      },
    },
    async ({ goal, maxSubtasks, maxAgentCalls, runId }) => {
      return chainAgentDo(async () => {
        const client = getAgpClient();
        if (!client.configured) {
          return fail(
            "Long tasks need the AGP brain for the agent tier — set HAI_API_KEY (or " +
              "HCOMPANY_API_KEY). The replay + coarse tiers still work, but novel sub-tasks " +
              "need the agent.",
          );
        }
        const notAttached = await ensureAttached();
        if (notAttached) return fail(notAttached);
        const browser = await getBrowser();
        const deps = buildOrchestratorDeps({ browser, agpClient: client });

        const trace: string[] = [];
        const result = await runLongTask(
          goal,
          {
            ...deps,
            onProgress: (ev) =>
              trace.push(
                `[${ev.index + 1}/${ev.total}] ${ev.via} · ${ev.subtask.description}` +
                  (ev.result.note ? ` — ${ev.result.note}` : ""),
              ),
          },
          {
            ...(runId ? { runId } : {}),
            budget: {
              ...(maxSubtasks ? { maxSubtasks } : {}),
              ...(maxAgentCalls ? { maxAgentCalls } : {}),
            },
          },
        );

        const head =
          `Long task ${result.status} — ${result.done}/${result.total} sub-tasks, ` +
          `${result.agentCalls} agent call(s).`;
        const reason = result.reason ? `\nStopped: ${result.reason}` : "";
        const rowsNote = result.rows.length
          ? `\n\nAccumulated ${result.rows.length} row(s)${
              result.headers.length ? ` [${result.headers.join(", ")}]` : ""
            }.`
          : "";
        const traceTxt = trace.length ? `\n\nSub-tasks:\n${trace.join("\n")}` : "";
        const body =
          `${head}${reason}${rowsNote}${traceTxt}\n\n` +
          `Resume/continue with long_task(runId: "${result.runId}").`;
        return result.status === "aborted" && result.done === 0 ? fail(body) : ok(body);
      });
    },
  );

  server.registerTool(
    "browser_status",
    {
      title: `${MCP_BRAND}: Browser status`,
      description:
        "Check whether the user's Chrome browser is connected and ready to be controlled. " +
        "Returns the current URL/title + the count of attached tabs when attached, or " +
        "instructions to attach when not. ALWAYS call this first when starting any web " +
        "task — posting a listing, scraping a page, filling a form, navigating a site, " +
        "automating a flow in Chrome — to confirm the browser is reachable before issuing " +
        "other browser_* calls. " +
        "If multiple tabs are attached, the response notes how to switch via " +
        "browser_list_tabs / browser_switch_tab — useful when the user has the green " +
        "Playwriter icon clicked on more than one tab and the snapshot URL doesn't match " +
        "what they're looking at." +
        BRAND_TAG_SUFFIX,
      inputSchema: {},
    },
    async () => {
      const not = await ensureAttached();
      if (not) return ok(not);
      try {
        const browser = await getBrowser();
        const snap = await browser.snapshot();
        // listTabs() returns only "real" tabs (welcome tabs filtered out)
        // — same set the orchestrator can switch between.
        let tabCount = 1;
        let multiTabSuffix = "";
        try {
          const tabs = await browser.listTabs();
          tabCount = Math.max(tabs.length, 1);
          if (tabs.length > 1) {
            // Build a compact list with index + URL so the orchestrator
            // can switchTab without a separate listTabs call.
            const tabList = tabs
              .map(
                (t) =>
                  `  [${t.index}] ${t.isCurrent ? "* " : "  "}${t.url}`,
              )
              .join("\n");
            multiTabSuffix =
              `\n\n${tabs.length} tabs attached:\n${tabList}\n` +
              `If this URL doesn't match what the user described, call ` +
              `browser_switch_tab({urlIncludes: "<substring>"}) or ` +
              `browser_switch_tab({index: N}) to switch. The snapshot/click/` +
              `type tools target the * tab.`;
          }
        } catch {
          // listTabs failure is non-fatal — fall back to single-tab text.
        }
        return ok(
          `Attached.\nURL: ${snap.url}\nTitle: ${snap.title}\n` +
            `(${snap.ax.split("\n").length} interactive elements visible, ${tabCount} ${tabCount === 1 ? "tab" : "tabs"} attached)` +
            multiTabSuffix,
        );
      } catch (e) {
        return fail(
          `Snapshot failed after available()=true: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );

  server.registerTool(
    "browser_list_tabs",
    {
      title: `${MCP_BRAND}: List attached tabs`,
      description:
        "Enumerate every Chrome tab the user has attached the Playwriter extension to " +
        "(every tab where the green icon is clicked). Returns each tab's index, URL, " +
        "title, and whether it's the CURRENT tab — the one snapshot/click/type/etc. will " +
        "target. Welcome tabs (auto-spawned chrome-extension://…/welcome.html pages) are " +
        "filtered out — they're never the user's intent. " +
        "Use this when browser_snapshot returns an unexpected URL: you'll see all tabs, " +
        "then call browser_switch_tab to change the active one. Multi-tab attachment is " +
        "the normal case whenever the user has clicked the extension on more than one tab." +
        BRAND_TAG_SUFFIX,
      inputSchema: {},
    },
    async () => {
      const not = await ensureAttached();
      if (not) return fail(not);
      try {
        const tabs = await (await getBrowser()).listTabs();
        if (tabs.length === 0) {
          return ok(
            "No real tabs attached (only welcome tabs visible). Click the green " +
              "Playwriter icon on the Chrome tab you want to control.",
          );
        }
        const lines = tabs.map((t) => {
          const star = t.isCurrent ? "* " : "  ";
          const titleText = t.title ? ` — "${t.title.slice(0, 60)}"` : "";
          return `[${t.index}] ${star}${t.url}${titleText}`;
        });
        return ok(
          `${tabs.length} attached ${tabs.length === 1 ? "tab" : "tabs"} ` +
            `(* = current — that's the one snapshot/click/type targets):\n` +
            lines.join("\n") +
            "\n\nSwitch with browser_switch_tab({urlIncludes: '<substring>'}) " +
            "or browser_switch_tab({index: N}).",
        );
      } catch (e) {
        return fail(
          `List tabs failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );

  server.registerTool(
    "browser_switch_tab",
    {
      title: `${MCP_BRAND}: Switch active tab`,
      description:
        "Change which attached Chrome tab subsequent browser_* calls target. Match by " +
        "absolute index from browser_list_tabs (`{index: 2}`), by case-insensitive URL " +
        "substring (`{urlIncludes: 'edit'}`), or by case-insensitive regex (`{pattern: " +
        "'/listing_id=\\\\d+/'}`). The matched tab is also brought to the front in Chrome " +
        "so the user can see it. " +
        "Use this when browser_snapshot returns a different URL than the user described " +
        "— typically because they have the Playwriter icon clicked on multiple tabs and " +
        "we picked the wrong one first. Errors include the list of currently attached " +
        "tabs so the orchestrator can re-call without a separate browser_list_tabs." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        index: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "Zero-based index from browser_list_tabs. Wins over the other match params " +
              "if multiple are passed — use this when URLs/titles might be ambiguous.",
          ),
        urlIncludes: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Case-insensitive substring to find in the tab URL. Most common shape: " +
              "`{urlIncludes: 'edit'}` for a Marketplace listing edit page.",
          ),
        pattern: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Case-insensitive regex (JS syntax) matched against the tab URL. Use only " +
              "when urlIncludes isn't expressive enough.",
          ),
      },
    },
    async ({ index, urlIncludes, pattern }) => {
      const not = await ensureAttached();
      if (not) return fail(not);
      if (index === undefined && !urlIncludes && !pattern) {
        return fail(
          "browser_switch_tab requires one of: index, urlIncludes, pattern. " +
            "Call browser_list_tabs first if you don't know what's attached.",
        );
      }
      try {
        const result = await (await getBrowser()).switchTab({
          ...(index !== undefined ? { index } : {}),
          ...(urlIncludes ? { urlIncludes } : {}),
          ...(pattern ? { pattern } : {}),
        });
        return ok(
          `Switched to tab [${result.index}]: ${result.url}` +
            (result.title ? ` — "${result.title.slice(0, 60)}"` : "") +
            "\nCall browser_snapshot now to see this tab's interactive elements.",
        );
      } catch (e) {
        return fail(
          `Switch tab failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );

  server.registerTool(
    "browser_new_tab",
    {
      title: `${MCP_BRAND}: Open a new tab`,
      description:
        "Open a NEW Chrome tab in the controlled group and make it the active tab " +
        "(subsequent browser_* calls target it). Pass a url to load it immediately, or " +
        "omit url for a blank tab you then browser_navigate. " +
        "Use this to work across several pages at once WITHOUT losing the page you're on — " +
        "e.g. keep a Marketplace listing index open in one tab while opening each post in " +
        "its own tab to pull title / price / SKU / photo URLs, then browser_switch_tab back " +
        "to the index. The new tab is auto-attached (no green-icon click needed). " +
        "Pair with browser_list_tabs (see all open tabs) and browser_switch_tab (jump between them)." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        url: z
          .string()
          .optional()
          .describe(
            "Absolute URL to load in the new tab, e.g. " +
              "https://www.facebook.com/marketplace/item/123. Omit for a blank tab.",
          ),
      },
    },
    async ({ url }) => {
      const not = await ensureAttached();
      if (not) return fail(not);
      try {
        const browser = await getBrowser();
        if (typeof browser.newTab !== "function") {
          return fail(
            "This browser driver can't open tabs. Use browser_navigate to reuse the " +
              "current tab instead.",
          );
        }
        await browser.newTab(url);
        await new Promise((r) => setTimeout(r, url ? 900 : 300));
        const tabs = await browser.listTabs();
        const current = tabs.find((t) => t.isCurrent) ?? tabs[tabs.length - 1];
        return ok(
          `Opened a new tab${current ? ` [${current.index}]: ${current.url}` : ""}. ` +
            `${tabs.length} tab${tabs.length === 1 ? "" : "s"} now attached. ` +
            "It's the active tab — call browser_snapshot to see it, or browser_switch_tab to go back.",
        );
      } catch (e) {
        return fail(
          `Open tab failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );

  server.registerTool(
    "browser_navigate",
    {
      title: `${MCP_BRAND}: Navigate`,
      description:
        "Open a URL or website in the user's Chrome browser. Use this whenever a task " +
        "involves visiting a specific site (Facebook, Amazon, Marketplace, GitHub, a docs " +
        "page, an internal tool, etc.) or any goal that starts with 'go to <site>' / " +
        "'open <site>' / 'visit <url>'. Returns the URL the tab actually landed on after " +
        "any redirects, so you can detect when a site rewrites your URL " +
        "(e.g. /marketplace/<city>/search → /marketplace/category/search/)." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        url: z
          .string()
          .describe("Absolute URL, e.g. https://www.facebook.com/marketplace"),
      },
    },
    async ({ url }) => {
      const not = await ensureAttached();
      if (not) return fail(not);
      try {
        const browser = await getBrowser();
        await browser.navigate(url);
        // Brief settle so the next snapshot/read reflects the new page.
        await new Promise((r) => setTimeout(r, 800));
        const snap = await browser.snapshot();
        // This snapshot just RE-STAMPED every data-holo-ref on the new
        // page — refresh the refLabel latch to match, or a post-navigate
        // ref reuse would record the OLD page's role/name and URL as a
        // confidently-wrong refLabel.
        lastMcpSnapshotRefs = parseAxRefs(snap.ax);
        lastMcpSnapshotUrl = snap.url;
        const note = snap.url !== url ? " (redirected)" : "";
        recordAction({
          type: "browser_navigate",
          payload: { url },
          url: snap.url,
        });
        return ok(`Navigated to ${snap.url}${note}\nTitle: ${snap.title}`);
      } catch (e) {
        return fail(
          `Navigate failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );

  server.registerTool(
    "browser_snapshot",
    {
      title: `${MCP_BRAND}: Snapshot active tab`,
      description:
        "List every clickable / typable element on the current Chrome page with refs you " +
        "can target. Use this to discover what's on the page before clicking or typing — " +
        "buttons, links, search boxes, listing tiles, dropdown options, form fields. " +
        "Each element is tagged [eN]; pass that ref to browser_click or browser_type. " +
        'Disabled controls are flagged "(disabled)" (UNCLICKABLE — pick the prerequisite ' +
        'first); autocomplete options are flagged "(suggestion)"; file uploads have role ' +
        '"file-input" and are flagged "(use browser_set_input_files, accepts=…)" — that ' +
        "is the right tool for them, NEVER browser_click or agent_do. File-inputs are " +
        "surfaced even when CSS-hidden (the common pattern for styled 'Add photo' " +
        "buttons). Always call this right after browser_navigate or after the page " +
        "changes." +
        BRAND_TAG_SUFFIX,
      inputSchema: {},
    },
    async () => {
      const not = await ensureAttached();
      if (not) return fail(not);
      try {
        const snap = await (await getBrowser()).snapshot();
        // Latch ref→(role,name) labels + URL so the trace buffer can
        // stamp durable refLabels onto subsequent direct browser_click /
        // browser_type / browser_set_input_files records WITHOUT a
        // post-action snapshot. The orchestrator necessarily snapshotted
        // to learn the ref, so this costs nothing and gives recipe
        // codegen page.getByRole(...) selectors (and replay-time
        // self-healing) instead of stale [data-holo-ref] fallbacks.
        lastMcpSnapshotRefs = parseAxRefs(snap.ax);
        lastMcpSnapshotUrl = snap.url;
        return ok(
          `URL: ${snap.url}\nTitle: ${snap.title}\n\n` +
            `Interactive elements (refs in [eN]):\n${snap.ax}`,
        );
      } catch (e) {
        return fail(
          `Snapshot failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );

  server.registerTool(
    "browser_click",
    {
      title: `${MCP_BRAND}: Click element`,
      description:
        "Click on a button, link, listing, dropdown option, or any other interactive " +
        "element on the current Chrome page. Pass the [eN] ref from browser_snapshot. " +
        "Use this for any task verb that means 'press', 'tap', 'open', 'select', or " +
        "'choose' an on-page element — clicking a Marketplace listing, opening a search " +
        "result, picking a category, hitting Apply / Submit / Continue buttons. Times " +
        'out at 2s if the ref vanished. Do NOT click refs flagged "(disabled)" — pick ' +
        "the prerequisite (usually an autocomplete suggestion) first." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        ref: z.string().describe("Element ref like 'e12'"),
      },
    },
    async ({ ref }) => {
      const not = await ensureAttached();
      if (not) return fail(not);
      try {
        await (await getBrowser()).click(ref);
        // Record into the trace buffer with NO post-click snapshot.
        // Earlier versions of this handler did a snapshot() right after
        // the click to extract the [eN]'s role+name for the recipe
        // codegen — but that:
        //   1) added ~200-500ms latency to every click,
        //   2) returned the POST-click page state (where the ref is
        //      typically gone — clicks navigate or close modals),
        //   3) raced with any navigation the click triggered.
        // For direct MCP browser_click calls, the recipe codegen
        // falls back to the `[data-holo-ref="eN"]` selector. The
        // agent_do path still captures full refLabels via its own
        // recorder.onBrowserSnapshot hook (see the agent_do handler
        // below), where the snapshot was already taken anyway.
        recordAction({
          type: "browser_click",
          payload: { ref },
          ...mcpRefMeta(ref),
        });
        return ok(`Clicked ${ref}`);
      } catch (e) {
        return fail(
          `Click ${ref} failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`,
        );
      }
    },
  );

  server.registerTool(
    "browser_set_input_files",
    {
      title: `${MCP_BRAND}: Upload file(s) to input`,
      description:
        "Programmatically attach one or more files from disk to a file-input " +
        "element on the current Chrome page. BYPASSES the native OS file picker " +
        "entirely — there is NO Finder dialog to navigate, no vision grounding, " +
        "no anti-stuck loop. This is the right tool for ANY 'upload a file' " +
        "intent on the web: profile photos, listing photos, document attachments, " +
        "resume uploads, etc. Pass the [eN] ref of an element flagged 'file-input' " +
        "in browser_snapshot. The snapshot now surfaces file-inputs even when " +
        "they're CSS-hidden (the common pattern for styled 'Add photo' buttons " +
        "on Facebook, Twitter, etc.) — look for the '(use browser_set_input_files" +
        ", accepts=…)' flag. If you only see a styled 'Add photo' button with no " +
        "file-input ref, click that button first, then re-snapshot. Paths must be " +
        "ABSOLUTE on the host filesystem (e.g. '/Users/you/Desktop/photo.png'). " +
        "DO NOT use agent_do to drive the file picker." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        ref: z
          .string()
          .describe(
            "Element ref like 'e15'. Should be a 'file-input' from browser_snapshot. " +
              "Targeting any other element type produces a Playwright error.",
          ),
        paths: z
          .array(z.string())
          .min(1)
          .describe(
            "Absolute file paths (e.g. ['/Users/you/Desktop/photo.png']). Pass " +
              "multiple paths to attach multiple files when the input is flagged " +
              "'multi-file'.",
          ),
      },
    },
    async ({ ref, paths }) => {
      const not = await ensureAttached();
      if (not) return fail(not);
      try {
        await (await getBrowser()).setInputFiles(ref, paths);
        const names = paths
          .map((p) => p.split("/").pop() || p)
          .join(", ");
        recordAction({
          type: "browser_set_input_files",
          payload: { ref, paths },
          ...mcpRefMeta(ref),
        });
        return ok(
          `Attached ${paths.length} file${paths.length === 1 ? "" : "s"} to ${ref}: ${names}. ` +
            "Call browser_snapshot to verify the page accepted the upload " +
            "(thumbnail / progress UI should now be visible).",
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
        // ENOENT despite our whitespace-tolerant resolver = the path is
        // genuinely wrong (typo in dir, file deleted, etc.). Give the
        // orchestrator a pointer to the right recovery instead of a
        // bare error string.
        if (/ENOENT|no such file/i.test(msg)) {
          return fail(
            `Set input files on ${ref} failed: ${msg}\n\n` +
              `One of the paths doesn't exist on disk. The harness already auto-tolerates ` +
              `whitespace mismatches (e.g., macOS Screenshot's U+202F vs ASCII space) and ` +
              `case differences, so this isn't a typography issue — the file is genuinely ` +
              `missing or in a different directory than the path you passed. ` +
              `Run a Bash 'ls' or 'find' to confirm the actual location, then re-call ` +
              `with the corrected absolute path.`,
          );
        }
        return fail(`Set input files on ${ref} failed: ${msg}`);
      }
    },
  );

  server.registerTool(
    "browser_type",
    {
      title: `${MCP_BRAND}: Type into field`,
      description:
        "Type text into a search box, form field, comment box, or any input on the " +
        "current Chrome page by its [eN] ref. Use this for any task that involves " +
        "filling out a form, searching a site, writing a description, entering a price, " +
        "composing a message, etc. Pass submit=true to press Enter after typing — but " +
        "rarely the right move: most forms want a click on Submit/Apply/Search/Post, and " +
        "search fields with autocomplete want a click on a suggestion." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        ref: z.string(),
        text: z.string(),
        submit: z
          .boolean()
          .optional()
          .describe("Press Enter after typing. Default false."),
      },
    },
    async ({ ref, text, submit }) => {
      const not = await ensureAttached();
      if (not) return fail(not);
      try {
        await (await getBrowser()).type(ref, text, { submit });
        // Settle so autocomplete dropdowns have a chance to render before
        // the next snapshot the client takes. Matches the loop's
        // POST_TYPE_SETTLE_MS (1400ms).
        await new Promise((r) => setTimeout(r, 1400));
        recordAction({
          type: "browser_type",
          payload: { ref, text, ...(submit ? { submit: true } : {}) },
          ...mcpRefMeta(ref),
        });
        return ok(
          `Typed "${text}" into ${ref}${submit ? " and pressed Enter" : ""}. ` +
            "Call browser_snapshot next — autocomplete suggestions may have appeared.",
        );
      } catch (e) {
        return fail(
          `Type into ${ref} failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`,
        );
      }
    },
  );

  server.registerTool(
    "browser_scroll",
    {
      title: `${MCP_BRAND}: Scroll`,
      description:
        "Scroll the current Chrome page up or down to reveal more content (more search " +
        "results, more listings, more comments). Pass a ref to scroll a specific scrollable " +
        "element (a sidebar, a modal, a feed inside a feed) instead of the whole page. " +
        "Default amount is 800px for the page / 600px for an element." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        direction: z.enum(["up", "down"]),
        ref: z
          .string()
          .optional()
          .describe("Element ref to scroll. Omit to scroll the page."),
        amount: z.number().optional().describe("Pixels to scroll."),
      },
    },
    async ({ direction, ref, amount }) => {
      const not = await ensureAttached();
      if (not) return fail(not);
      try {
        const browser = await getBrowser();
        if (ref) {
          await browser.scrollElement(ref, direction, amount);
          recordAction({
            type: "browser_scroll_element",
            payload: {
              ref,
              dir: direction,
              ...(amount !== undefined ? { amount } : {}),
            },
          });
          return ok(`Scrolled element ${ref} ${direction}`);
        } else {
          await browser.scrollPage(direction, amount);
          recordAction({
            type: "browser_scroll_page",
            payload: {
              dir: direction,
              ...(amount !== undefined ? { amount } : {}),
            },
          });
          return ok(`Scrolled page ${direction}`);
        }
      } catch (e) {
        return fail(`Scroll failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "browser_read",
    {
      title: `${MCP_BRAND}: Read page text`,
      description:
        "Get the actual readable text of the current Chrome page — listing titles, prices, " +
        "descriptions, article body, product details, comments, the whole copy. Use this " +
        "any time the user asks you to find / list / summarize / extract / report what's " +
        "on a page. Output is Firecrawl-style cleaned: nav/header/footer/sidebar/scripts " +
        "stripped, and links are annotated inline as 'Link Text (https://absolute-url)' " +
        "so you can cite real URLs in your answer. Pass a ref to read a single element. " +
        "Distinct from browser_snapshot, which only gives you element roles+names; THIS " +
        "is where the actual page copy lives." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        ref: z.string().optional(),
      },
    },
    async ({ ref }) => {
      const not = await ensureAttached();
      if (not) return fail(not);
      try {
        const text = await (await getBrowser()).readText(ref);
        return ok(text || "(page is empty)");
      } catch (e) {
        return fail(`Read failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "extract",
    {
      title: `${MCP_BRAND}: Extract structured rows from the page`,
      description:
        "Turn the CURRENT Chrome page into structured rows in ONE call — reads the " +
        "whole page (Firecrawl-style cleaned text) and shapes it into a table with a " +
        "fast model pass, instead of scrolling + reading screenshots row by row. Give " +
        "`columns` (e.g. ['Item','Price','Status']) and/or freeform `instructions`. " +
        "Set `to:'clipboard'` to drop the rows straight onto the clipboard as TSV " +
        "(then click A1 and paste into a sheet), or `to:'csv'` to write a file — so " +
        "'list/export/collect X into a sheet' becomes a single step. Without `to`, " +
        "returns the rows as JSON to pass to copy_table / write_csv. This is the FAST " +
        "path for data tasks — no per-row clicking, no vision loop." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        columns: z
          .array(z.string())
          .optional()
          .describe("Desired columns, in order. Omit to let the model infer them."),
        instructions: z
          .string()
          .optional()
          .describe("Freeform guidance: what to pull, how to filter (e.g. 'only active listings')."),
        ref: z
          .string()
          .optional()
          .describe("Optional [eN] ref to read just one element instead of the whole page."),
        to: z
          .enum(["clipboard", "csv"])
          .optional()
          .describe("Optionally write the rows: 'clipboard' (TSV, paste into a sheet) or 'csv' (file)."),
        path: z.string().optional().describe("CSV destination path when to='csv'."),
      },
    },
    async ({ columns, instructions, ref, to, path }) => {
      const not = await ensureAttached();
      if (not) return fail(not);
      try {
        const pageText = await (await getBrowser()).readText(ref);
        if (!pageText || !pageText.trim()) {
          return fail("Page has no readable text to extract from (try browser_navigate first, or scroll to load content).");
        }
        const { headers, rows } = await extractRows({ pageText, columns, instructions });
        if (!rows.length) {
          return ok("No rows matched that request on this page. Try different columns/instructions, or scroll to load more items.");
        }
        if (to === "clipboard") {
          copyTableToClipboard({ rows, headers });
          return ok(
            `Extracted ${rows.length} row(s) × ${headers.length} col(s) and copied as TSV. ` +
              "Now click the destination cell (e.g. A1) and paste (Cmd/Ctrl+V) to fill the grid.",
          );
        }
        if (to === "csv") {
          const written = writeCsvFile({ rows, headers }, path);
          return ok(`Extracted ${rows.length} row(s) → ${written}`);
        }
        const json = JSON.stringify({ headers, rows });
        return ok(`Extracted ${rows.length} row(s) × ${headers.length} col(s):\n${json}`);
      } catch (e) {
        return fail(`extract failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "copy_table",
    {
      title: `${MCP_BRAND}: Copy rows to clipboard (TSV)`,
      description:
        "Put a whole table of rows onto the system clipboard as TSV in ONE call — " +
        "the fast, no-auth way to fill a Google Sheet / Excel: call copy_table, then " +
        "click the target cell (e.g. A1) and paste (Cmd/Ctrl+V); the sheet expands " +
        "the TSV into a full grid instantly. Use this instead of typing cells one by " +
        "one. Pass `rows` as an array of arrays (each inner array is one row); " +
        "optional `headers` become the first row. Pairs with browser_read/extract " +
        "(the read half) to do list-into-sheet tasks in seconds." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        rows: z
          .array(z.array(z.union([z.string(), z.number()])))
          .describe("Array of rows; each row is an array of cell values (strings or numbers)."),
        headers: z
          .array(z.string())
          .optional()
          .describe("Optional column headers, written as the first row."),
      },
    },
    async ({ rows, headers }) => {
      try {
        const { rows: n, cols } = copyTableToClipboard({ rows, headers });
        return ok(
          `Copied ${n} row(s) × ${cols} col(s) to the clipboard as TSV. ` +
            "Now click the destination cell (e.g. A1) and paste (Cmd/Ctrl+V) to fill the grid.",
        );
      } catch (e) {
        return fail(`copy_table failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "write_csv",
    {
      title: `${MCP_BRAND}: Write rows to a CSV file`,
      description:
        "Write a whole table of rows to a .csv file on disk in ONE call (defaults to " +
        "~/Downloads). Pass `rows` as an array of arrays; optional `headers` become " +
        "the first row; optional `path` overrides the destination. Returns the file " +
        "path. Use for bulk export when the user wants a file rather than a sheet." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        rows: z
          .array(z.array(z.union([z.string(), z.number()])))
          .describe("Array of rows; each row is an array of cell values (strings or numbers)."),
        headers: z
          .array(z.string())
          .optional()
          .describe("Optional column headers, written as the first row."),
        path: z
          .string()
          .optional()
          .describe("Absolute path to write. Defaults to ~/Downloads/holo3-export-<timestamp>.csv"),
      },
    },
    async ({ rows, headers, path }) => {
      try {
        const written = writeCsvFile({ rows, headers }, path);
        return ok(`Wrote ${rows.length} row(s) to ${written}`);
      } catch (e) {
        return fail(`write_csv failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    "screen_screenshot",
    {
      title: `${MCP_BRAND}: Screenshot focused display`,
      description:
        "Take a PNG screenshot of the user's screen (the display the cursor is on). Use " +
        "this for INSPECTING state — checking what's visible after an action, debugging " +
        "when agent_do returned 'exhausted', reading a static UI, or describing what's on " +
        "screen back to the user. You do NOT need to chain a screenshot before screen_click " +
        "/ screen_drag / screen_move — those tools take their own screenshot internally and " +
        "ground a target description via the vision model. For web tasks prefer " +
        "browser_snapshot + browser_read (faster, structured). Multi-monitor only works " +
        "when launched from the Holo3 Electron app; under Claude Desktop / Cursor / etc. " +
        "only the primary display." +
        BRAND_TAG_SUFFIX,
      inputSchema: {},
    },
    async () => {
      // Bridge-first: when the Electron Holo3 app is running, the
      // screenshot capture happens inside that process where macOS
      // Screen Recording IS granted. The MCP host (Claude Code, etc.)
      // routinely lacks that perm, which produces BLANK screenshots —
      // the orchestrator then makes bad decisions because it can't
      // see anything. Bridge round-trip is ~5–20ms over localhost.
      const bridgeShot = await tryBridgeScreenCall<{
        pngBase64: string;
        width: number;
        height: number;
        offsetX: number;
        offsetY: number;
      }>("/screen/screenshot", {});
      if (bridgeShot) {
        return {
          content: [
            {
              type: "image" as const,
              data: bridgeShot.pngBase64,
              mimeType: "image/png",
            },
            {
              type: "text" as const,
              text:
                `Captured ${bridgeShot.width}x${bridgeShot.height} (via Electron bridge — host process perms not required)` +
                (bridgeShot.offsetX || bridgeShot.offsetY
                  ? ` (display at screen offset ${bridgeShot.offsetX},${bridgeShot.offsetY}; informational — screen_click takes a target description, not coords)`
                  : ""),
            },
          ],
        };
      }
      try {
        const shot = await screen.screenshot();
        return {
          content: [
            {
              type: "image" as const,
              data: shot.png.toString("base64"),
              mimeType: "image/png",
            },
            {
              type: "text" as const,
              text:
                `Captured ${shot.width}x${shot.height}` +
                (shot.offsetX || shot.offsetY
                  ? ` (display at screen offset ${shot.offsetX},${shot.offsetY}; informational — screen_click takes a target description, not coords)`
                  : " (primary display; bridge unavailable — start the Holo3 Electron app if screenshots come back blank)"),
            },
          ],
        };
      } catch (e) {
        return fail(
          `Screenshot failed: ${e instanceof Error ? e.message : String(e)}. ` +
            "Tip: start the Holo3 Electron app — its bridge has macOS Screen Recording perms granted and the MCP will forward screen_screenshot to it automatically.",
        );
      }
    },
  );

  // ── OS-LEVEL mouse / keyboard / vision-grounded tools ─────────────────
  //
  // These complement the in-page browser_* tools. Use them when the
  // target ISN'T a Chrome page element:
  //   • Spotlight, the app switcher, the macOS menu bar / dock
  //   • Native app windows (Calculator, Finder, Slack, VS Code, etc.)
  //   • Anything that doesn't have an [eN] ref because there's no
  //     accessibility-tree snapshot
  //
  // Background mode (cliclick) is auto-detected at boot — when on, the
  // agent's mouse events fire without moving the user's visible cursor.
  //
  // ── Vision-grounded primitives: agent_click, agent_drag, agent_observe
  //
  // The Stagehand `act` / `observe` split applied to OS-level work:
  // expose the vision-grounding primitive directly so atomic actions
  // skip the full plan→ground→exec→loop overhead. They take a natural-
  // language TARGET DESCRIPTION, never pixel coordinates. The harness
  // screenshots, asks the vision model to ground the description, adds
  // the multi-monitor offset, and executes. Round-trip ~2-3s vs
  // ~10-15s for the autonomous agent_do loop.
  //
  // When to use which:
  //   • agent_click / agent_drag — you KNOW what to click (you saw it
  //     in a screenshot, the OS surface is predictable). Single
  //     atomic action; no autonomous decision-making. Same shape as
  //     browser_click but for the OS layer.
  //   • agent_observe — preview where a click would land (returns
  //     coords without executing). Useful for "is this thing on
  //     screen?" sanity checks before committing.
  //   • agent_do — open-ended autonomous flow. The brain decides the
  //     verb AND the target as it goes. Use when you don't know what
  //     you'll find on screen yet.
  //
  // The previous "no low-level click" design was deliberately cautious
  // (worried about wrong-ground footguns). The harness now has enough
  // verification surface (the orchestrator can take screen_screenshot
  // before/after, agent_observe before agent_click, etc.) that direct
  // primitives are safe — and they make atomic actions feel like
  // Playwriter's `page.locator(...).click()`: one call, ~2s,
  // deterministic.

  server.registerTool(
    "agent_click",
    {
      title: `${MCP_BRAND}: Click an element described in natural language`,
      description:
        "Vision-grounded click on an element you describe in plain English — no pixel " +
        "coordinates, no [eN] ref. The harness screenshots, asks the vision model where " +
        "the description lands, adds the multi-monitor offset, and clicks. Round-trip is " +
        "~2-3 seconds, same shape as browser_click but for the OS layer (file pickers, " +
        "Finder, Spotlight, native dialogs, dock, menu bar). " +
        "Modes: 'single' (default), 'double', 'right', 'triple'. Returns the grounded " +
        "coordinates AND a fresh post-click screenshot so you can verify the click " +
        "landed without a separate screen_screenshot. " +
        "Pick this over agent_do when you KNOW the verb and the target — agent_do is " +
        "the autonomous-loop version for when you don't yet. Pick this over " +
        "browser_click when the target is OUTSIDE Chrome (no [eN] ref). For Chrome " +
        "elements with refs, browser_click is faster (no vision)." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        target: z
          .string()
          .min(1)
          .describe(
            "Plain-English description of the element to click. Be specific enough " +
              "that the vision model can pick the right pixel: 'the Open button in " +
              "the file picker', 'the Calculator icon in the dock', 'the highlighted " +
              "Screenshot file in the Today section'. Avoid 'the button' / 'it' / " +
              "ambiguous references.",
          ),
        targetApp: z
          .string()
          .optional()
          .describe(
            "macOS-only speedup + accuracy aid: crop the screenshot to this " +
              "app's front window before grounding (System Events process " +
              "name: 'Calculator', 'Finder', 'Google Chrome'). 6-20× fewer " +
              "image tokens → ~2-4× faster grounding, and deletes screen " +
              "clutter that pulls the vision model off-target. Use whenever " +
              "the click target lives in ONE known app window. Falls back to " +
              "full-frame silently if the app isn't running.",
          ),
        mode: z
          .enum(["single", "double", "right", "triple"])
          .optional()
          .describe(
            "Click mode. Default 'single' (left click). 'double' for opening files / " +
              "selecting words; 'right' for context menus; 'triple' to select a paragraph.",
          ),
      },
    },
    async ({ target, mode, targetApp }) => {
      const t0 = Date.now();
      // 1. Capture screenshot — bridge first for perms.
      const bridgeShot = await tryBridgeScreenCall<{
        pngBase64: string;
        width: number;
        height: number;
        offsetX: number;
        offsetY: number;
      }>("/screen/screenshot", {});
      let png: Buffer;
      let width: number;
      let height: number;
      let offsetX: number;
      let offsetY: number;
      if (bridgeShot) {
        png = Buffer.from(bridgeShot.pngBase64, "base64");
        width = bridgeShot.width;
        height = bridgeShot.height;
        offsetX = bridgeShot.offsetX;
        offsetY = bridgeShot.offsetY;
      } else {
        try {
          const shot = await screen.screenshot();
          png = shot.png;
          width = shot.width;
          height = shot.height;
          offsetX = shot.offsetX;
          offsetY = shot.offsetY;
        } catch (e) {
          return fail(
            `Screenshot failed: ${e instanceof Error ? e.message : String(e)}. ` +
              "Tip: start the Holo3 Electron app — its bridge has macOS Screen " +
              "Recording perms granted.",
          );
        }
      }
      // 1b. Optional window crop — the same image-token reduction the
      // agent_do loop gets; direct (occlusion-proof) capture preferred
      // when the frame came from local capture.
      let cropNote: string | undefined;
      if (targetApp) {
        const croppedFrame = await cropFrameToApp(
          { png, width, height, offsetX, offsetY },
          targetApp,
          !bridgeShot,
        );
        ({ png, width, height, offsetX, offsetY } = croppedFrame);
        cropNote = croppedFrame.cropNote;
      }

      // 2. Ground via the vision model.
      let provider: ProviderClient;
      try {
        ({ provider } = await getProviderWarmed());
      } catch (e) {
        return fail(
          `Provider not configured: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      let coords: { x: number; y: number } | null;
      try {
        const r = await provider.ground({
          instruction: target,
          screenshotB64: png.toString("base64"),
          screen: [width, height],
        });
        coords = r.error ? null : { x: r.x, y: r.y };
      } catch (e) {
        return fail(
          `Grounding failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (!coords) {
        return fail(
          `Couldn't ground "${target}" on the current screen. Take a screen_screenshot ` +
            "to see what's visible, then refine the description (mention surface, " +
            'position, or a visual cue: "the Open button in the bottom-right of the ' +
            'file picker").',
        );
      }
      // 3. Multi-monitor offset (screenshot space → screen space).
      const screenX = coords.x + offsetX;
      const screenY = coords.y + offsetY;
      const tGround = Date.now() - t0;

      // 4. Execute click — bridge first for perms.
      const clickMode = mode ?? "single";
      const bridgedClick = await tryBridgeScreenCall<{ ok: boolean }>(
        "/screen/click",
        { x: screenX, y: screenY, mode: clickMode },
      );
      if (!bridgedClick?.ok) {
        try {
          await screen.click(screenX, screenY, {
            double: clickMode === "double",
            triple: clickMode === "triple",
            button: clickMode === "right" ? "right" : "left",
          });
        } catch (e) {
          return fail(
            `Click at (${screenX}, ${screenY}) failed: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
      }
      const tExec = Date.now() - t0 - tGround;

      // Record into the trace buffer. The recorded type maps onto the
      // codegen verbs (click / double_click / triple_click / right_click)
      // so the generated recipe emits the right `screen.click(...)` call.
      const recordType =
        clickMode === "double"
          ? "double_click"
          : clickMode === "triple"
            ? "triple_click"
            : clickMode === "right"
              ? "right_click"
              : "click";
      recordAction({
        type: recordType,
        payload: { x: screenX, y: screenY },
        intent: target,
      });

      // 5. Brief settle, then capture post-click screenshot for verification.
      await screen.sleep(300);
      let postPng: Buffer | undefined;
      const postShot = await tryBridgeScreenCall<{
        pngBase64: string;
      }>("/screen/screenshot", {});
      if (postShot) {
        postPng = Buffer.from(postShot.pngBase64, "base64");
      } else {
        try {
          const s = await screen.screenshot();
          postPng = s.png;
        } catch {
          /* skip post-shot if we can't get it */
        }
      }

      const totalMs = Date.now() - t0;
      const summary =
        `Clicked "${target}" with mode=${clickMode} at (${screenX}, ${screenY}). ` +
        `Ground ${tGround}ms, exec ${tExec}ms, total ${totalMs}ms. ` +
        (targetApp ? `(cropped to ${targetApp} ${width}×${height}) ` : "") +
        (bridgedClick?.ok ? "(via Electron bridge) " : "") +
        (cropNote ? `\n${cropNote}\n` : "") +
        "Post-click screenshot attached — verify the click landed.";
      const responseContent: Array<
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      > = [{ type: "text" as const, text: summary }];
      if (postPng) {
        responseContent.push({
          type: "image" as const,
          data: postPng.toString("base64"),
          mimeType: "image/png",
        });
      }
      return { content: responseContent };
    },
  );

  server.registerTool(
    "agent_drag",
    {
      title: `${MCP_BRAND}: Drag from one element to another`,
      description:
        "Vision-grounded drag-and-drop between two elements you describe in plain " +
        "English. The harness screenshots ONCE, grounds source AND target IN PARALLEL " +
        "(both via the vision model on the same screenshot), then performs the drag. " +
        "Round-trip is ~2-3 seconds — only one extra ground call vs agent_click. " +
        "Use for: file icons → trash, slider handles, items across panes, anywhere a " +
        "click won't do because the element needs to MOVE. Both endpoints must be on " +
        "the same screen at the same time (no scroll between source and target). " +
        "NOTE: drag inherently moves the visible cursor (~200-400ms) even in " +
        "background mode — there's no way to post drag CGEvents at coords without " +
        "moving the cursor at the OS level." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        from: z
          .string()
          .min(1)
          .describe("Source element description (what to grab)."),
        to: z
          .string()
          .min(1)
          .describe("Target element description (where to drop)."),
      },
    },
    async ({ from, to }) => {
      const t0 = Date.now();
      // 1. Single screenshot — both endpoints come from the same frame.
      const bridgeShot = await tryBridgeScreenCall<{
        pngBase64: string;
        width: number;
        height: number;
        offsetX: number;
        offsetY: number;
      }>("/screen/screenshot", {});
      let png: Buffer;
      let width: number;
      let height: number;
      let offsetX: number;
      let offsetY: number;
      if (bridgeShot) {
        png = Buffer.from(bridgeShot.pngBase64, "base64");
        width = bridgeShot.width;
        height = bridgeShot.height;
        offsetX = bridgeShot.offsetX;
        offsetY = bridgeShot.offsetY;
      } else {
        try {
          const shot = await screen.screenshot();
          png = shot.png;
          width = shot.width;
          height = shot.height;
          offsetX = shot.offsetX;
          offsetY = shot.offsetY;
        } catch (e) {
          return fail(
            `Screenshot failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      const screenshotB64 = png.toString("base64");

      let provider: ProviderClient;
      try {
        ({ provider } = await getProviderWarmed());
      } catch (e) {
        return fail(
          `Provider not configured: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      // 2. Ground source + target IN PARALLEL — Promise.all on two API calls.
      // Both run against the same screenshot bytes, so we can fire them
      // simultaneously and pay max(t_source, t_target) instead of sum.
      const tGroundStart = Date.now();
      const [fromR, toR] = await Promise.all([
        provider.ground({
          instruction: from,
          screenshotB64,
          screen: [width, height],
        }),
        provider.ground({
          instruction: to,
          screenshotB64,
          screen: [width, height],
        }),
      ]);
      const tGround = Date.now() - tGroundStart;

      if (fromR.error || toR.error) {
        return fail(
          `Couldn't ground both endpoints. From: ${fromR.error ? `FAILED (${fromR.error})` : `(${fromR.x}, ${fromR.y})`}. ` +
            `To: ${toR.error ? `FAILED (${toR.error})` : `(${toR.x}, ${toR.y})`}.`,
        );
      }
      const fromX = fromR.x + offsetX;
      const fromY = fromR.y + offsetY;
      const toX = toR.x + offsetX;
      const toY = toR.y + offsetY;

      // 3. Execute drag — bridge first.
      const tExecStart = Date.now();
      const bridgedDrag = await tryBridgeScreenCall<{ ok: boolean }>(
        "/screen/drag",
        { fromX, fromY, toX, toY },
      );
      if (!bridgedDrag?.ok) {
        try {
          await screen.drag(fromX, fromY, toX, toY);
        } catch (e) {
          return fail(
            `Drag failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      const tExec = Date.now() - tExecStart;

      recordAction({
        type: "drag",
        payload: { from: { x: fromX, y: fromY }, to: { x: toX, y: toY } },
        intent: `drag "${from}" → "${to}"`,
      });

      // 4. Post-drag screenshot for verification.
      await screen.sleep(300);
      let postPng: Buffer | undefined;
      const postShot = await tryBridgeScreenCall<{
        pngBase64: string;
      }>("/screen/screenshot", {});
      if (postShot) {
        postPng = Buffer.from(postShot.pngBase64, "base64");
      } else {
        try {
          const s = await screen.screenshot();
          postPng = s.png;
        } catch {
          /* skip */
        }
      }

      const totalMs = Date.now() - t0;
      const summary =
        `Dragged "${from}" → "${to}": (${fromX}, ${fromY}) → (${toX}, ${toY}). ` +
        `Ground (parallel) ${tGround}ms, exec ${tExec}ms, total ${totalMs}ms. ` +
        (bridgedDrag?.ok ? "(via Electron bridge) " : "") +
        "Post-drag screenshot attached.";
      const responseContent: Array<
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      > = [{ type: "text" as const, text: summary }];
      if (postPng) {
        responseContent.push({
          type: "image" as const,
          data: postPng.toString("base64"),
          mimeType: "image/png",
        });
      }
      return { content: responseContent };
    },
  );

  server.registerTool(
    "agent_click_sequence",
    {
      title: `${MCP_BRAND}: Click N elements in order, sharing one screenshot + parallel grounding`,
      description:
        "Drop-in replacement for N sequential agent_click calls when the UI is STATIC " +
        "across the whole sequence (calculator buttons, a series of toggles, picking " +
        "items from a fixed list, multi-step forms where every target is visible from " +
        "the start). Captures ONE screenshot, grounds all N targets IN PARALLEL via " +
        "Promise.all, then clicks them serially in the order given. " +
        "For 6 clicks on remote providers (H Company / Modal): typically 18s → ~5s — " +
        "you pay max(grounding) once instead of sum(grounding) N times. " +
        "Local Ollama benefits less: parallel requests there serialize on the GPU, so " +
        "the win is mostly the saved screenshot captures (~150ms each). " +
        "DO NOT use when the screen layout changes between clicks (a wizard with " +
        "N pages, dropdowns that close after click, a list that re-orders on selection) " +
        "— each later target won't exist on the initial screenshot. Use individual " +
        "agent_click calls in those cases so each grounding sees the fresh state. " +
        "Returns a summary of each click's grounded coords + ONE final post-sequence " +
        "screenshot (NOT one per click — saves ~N × 300ms of settle+capture)." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        steps: z
          .array(
            z.object({
              target: z
                .string()
                .min(1)
                .describe(
                  "Plain-English description of the element to click for THIS step. " +
                    "Same shape as agent_click's target. Be specific.",
                ),
              mode: z
                .enum(["single", "double", "right", "triple"])
                .optional()
                .describe("Click mode for THIS step. Default 'single'."),
              delayMs: z
                .number()
                .int()
                .min(0)
                .max(2000)
                .optional()
                .describe(
                  "Per-step override for the delay AFTER this click before the next " +
                    "one fires. Takes precedence over the global stepDelayMs. Useful " +
                    "for mixed-pacing sequences — e.g. when ONE button in the chain " +
                    "triggers a re-render that needs 300ms to settle, but the rest are " +
                    "instant native buttons. Ignored on the last step (no 'next click').",
                ),
            }),
          )
          .min(2)
          .max(12)
          .describe(
            "Ordered list of clicks. Min 2 (otherwise just use agent_click). Max 12 " +
              "(sanity cap — long sequences usually hide a state-change you missed; " +
              "split into multiple agent_click_sequence calls).",
          ),
        stepDelayMs: z
          .number()
          .int()
          .min(0)
          .max(2000)
          .optional()
          .describe(
            "Default delay between clicks within the sequence, in ms. Default 150ms — " +
              "conservative for animation-heavy web UIs. For native macOS apps that " +
              "respond synchronously to cliclick (Calculator, Finder, Spotlight) drop " +
              "to 30-50ms. Bump to 300-500ms for animation-heavy UIs. Per-step " +
              "`step.delayMs` overrides this for individual steps.",
          ),
        targetApp: z
          .string()
          .optional()
          .describe(
            "macOS-only. When set, the screenshot is cropped to the front window of " +
              "this process before grounding, defending against the 'embedded-screenshot " +
              "decoy' (a chat / IDE showing a screenshot of the same app on the same " +
              "display — the vision model can ground against the picture instead of the " +
              "real window). Use the System Events process name (Calculator, Finder, " +
              "Safari, 'Google Chrome'). Requires Accessibility permission for the " +
              "spawning process; falls back to UNCROPPED grounding if perms missing or " +
              "the app isn't running. On grounded coords landing OUTSIDE the cropped " +
              "window, the tool returns a `target_outside_window` structured error and " +
              "performs no clicks — orchestrator should recover with cmd+tab + retry.",
          ),
      },
    },
    async ({ steps, stepDelayMs, targetApp }) => {
      const t0 = Date.now();
      const delayMs = stepDelayMs ?? 150;

      // 1. Single screenshot — every grounding shares this frame.
      const bridgeShot = await tryBridgeScreenCall<{
        pngBase64: string;
        width: number;
        height: number;
        offsetX: number;
        offsetY: number;
        scaleFactor?: number;
      }>("/screen/screenshot", {});
      let png: Buffer;
      let width: number;
      let height: number;
      let offsetX: number;
      let offsetY: number;
      // scaleFactor = PNG physical pixels / logical pixels. Defaults to
      // 1 (or auto-detected from PNG header) when the bridge is too old
      // to surface it. Used below to scale crop coords from logical to
      // physical so the server-side PIL crop hits the right region —
      // without it, the server crops the top-left ¼ of where the target
      // window actually is (the 2026-05-13 Retina regression).
      let scaleFactor: number;
      if (bridgeShot) {
        png = Buffer.from(bridgeShot.pngBase64, "base64");
        width = bridgeShot.width;
        height = bridgeShot.height;
        offsetX = bridgeShot.offsetX;
        offsetY = bridgeShot.offsetY;
        if (typeof bridgeShot.scaleFactor === "number") {
          scaleFactor = bridgeShot.scaleFactor;
        } else {
          // Old bridge — derive from PNG bytes. PNG IHDR width is at
          // offset 16 (big-endian uint32).
          try {
            scaleFactor = Math.max(1, png.readUInt32BE(16) / width);
          } catch {
            scaleFactor = 1;
          }
        }
      } else {
        try {
          const shot = await screen.screenshot();
          png = shot.png;
          width = shot.width;
          height = shot.height;
          offsetX = shot.offsetX;
          offsetY = shot.offsetY;
          scaleFactor = shot.scaleFactor;
        } catch (e) {
          return fail(
            `Screenshot failed: ${e instanceof Error ? e.message : String(e)}. ` +
              "Tip: start the Holo3 Electron app — its bridge has macOS Screen " +
              "Recording perms granted.",
          );
        }
      }
      const screenshotB64 = png.toString("base64");

      let provider: ProviderClient;
      try {
        ({ provider } = await getProviderWarmed());
      } catch (e) {
        return fail(
          `Provider not configured: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      // 1b. Optional window-bounds crop (defends against the embedded-
      //     screenshot decoy — see schema description for `targetApp`).
      //     We resolve the crop rect HERE so the same rect can be:
      //       (a) sent to provider.groundBatch via its `crop` arg
      //          (in PHYSICAL pixel coords — the server PIL-crops the
      //          raw PNG bytes which are at physical resolution on
      //          Retina), AND
      //       (b) used for client-side bounds validation of returned
      //          coords (in CROPPED-image LOGICAL space, since the
      //          server returns coords normalized against the logical
      //          crop size we tell it).
      //     If anything fails (non-darwin, perms denied, app not running,
      //     window-bounds query times out), we set `crop = null` and the
      //     rest of the pipeline behaves exactly like the un-targetApp path.
      let crop: { x: number; y: number; w: number; h: number } | null = null;
      if (targetApp && process.platform === "darwin") {
        const bounds = await screen.getMacWindowBounds(targetApp);
        if (bounds) {
          // Translate screen-space window bounds into screenshot-pixel
          // space. On a single-display machine offsetX/Y are 0 and this
          // is a no-op; on a multi-monitor setup where the cursor (and
          // thus the captured display) is the secondary, bounds.x will
          // be in screen-space and we subtract the display's offset to
          // get a rect inside the captured PNG.
          const cropX = bounds.x - offsetX;
          const cropY = bounds.y - offsetY;
          // Clamp to the captured frame so a partially-offscreen window
          // still produces a valid rect.
          const clampedX = Math.max(0, Math.min(width, cropX));
          const clampedY = Math.max(0, Math.min(height, cropY));
          const clampedW = Math.max(
            0,
            Math.min(width - clampedX, bounds.width + (cropX - clampedX)),
          );
          const clampedH = Math.max(
            0,
            Math.min(height - clampedY, bounds.height + (cropY - clampedY)),
          );
          if (clampedW > 0 && clampedH > 0) {
            // Send the PHYSICAL crop rect to the server so its PIL crop
            // slices the right region from the raw PNG bytes. Without
            // this multiplication, on a Retina Mac we'd slice the
            // top-left ¼ of where the target window actually is — the
            // 2026-05-13 vision-quality regression.
            crop = {
              x: Math.round(clampedX * scaleFactor),
              y: Math.round(clampedY * scaleFactor),
              w: Math.round(clampedW * scaleFactor),
              h: Math.round(clampedH * scaleFactor),
            };
          } else {
            stderrLog(
              `[agent_click_sequence] targetApp="${targetApp}" window is fully offscreen ` +
                `relative to the captured display — falling back to uncropped grounding.`,
            );
          }
        } else {
          stderrLog(
            `[agent_click_sequence] targetApp="${targetApp}": no front window bounds ` +
              `returned (process not running, no window, or Accessibility perms denied) — ` +
              `falling back to uncropped grounding.`,
          );
        }
      } else if (targetApp && process.platform !== "darwin") {
        stderrLog(
          `[agent_click_sequence] targetApp="${targetApp}" ignored on non-darwin platform.`,
        );
      }

      // 2. Parallel grounding — all targets fire simultaneously against the
      //    same screenshot bytes. Total wall time ≈ max(per-call grounding)
      //    instead of sum, which is the whole point of this tool.
      //
      //    PREFER provider.groundBatch when available: ONE HTTP round-trip,
      //    ONE image upload, server-side fan-out into the model's parallel
      //    inference slots (e.g. llama-server --parallel 4 on Modal). Falls
      //    back to N parallel ground() calls when the provider doesn't
      //    implement batch — still saves the per-call screenshot capture
      //    but pays N HTTP round-trips.
      //
      //    When `crop` is set, the model only sees the targetApp window
      //    (decoy defense). Grounded coords come back in CROPPED-image
      //    space and we translate them back below.
      const tGroundStart = Date.now();
      let groundResults: GroundResult[];
      let groundPath: "batch" | "parallel-fallback";
      if (typeof provider.groundBatch === "function") {
        try {
          groundResults = await provider.groundBatch({
            instructions: steps.map((s) => s.target),
            screenshotB64,
            screen: crop ? [crop.w, crop.h] : [width, height],
            ...(crop ? { crop } : {}),
          });
          groundPath = "batch";
        } catch (e) {
          // Server-side batch errors out (validation failure, container
          // crash, etc.) — fall through to the per-call path so the
          // sequence still has a chance to land. The orchestrator will
          // see the slower wall time but doesn't have to retry by hand.
          console.error(
            `[agent_click_sequence] provider.groundBatch failed (${e instanceof Error ? e.message : String(e)}); falling back to N parallel ground() calls`,
          );
          groundResults = await Promise.all(
            steps.map((s) =>
              provider.ground({
                instruction: s.target,
                screenshotB64,
                screen: [width, height],
              }),
            ),
          );
          groundPath = "parallel-fallback";
        }
      } else {
        groundResults = await Promise.all(
          steps.map((s) =>
            provider.ground({
              instruction: s.target,
              screenshotB64,
              screen: [width, height],
            }),
          ),
        );
        groundPath = "parallel-fallback";
      }
      const tGround = Date.now() - tGroundStart;

      // 3. Fail-fast if ANY ground failed. The orchestrator gets a clear
      //    per-step list so it can re-run individual agent_click calls
      //    against a refined description, or re-screenshot and try again.
      const failures = groundResults
        .map((r, i) => ({ r, i }))
        .filter((x) => x.r.error);
      if (failures.length > 0) {
        const lines = groundResults.map((r, i) =>
          r.error
            ? `  step ${i + 1} "${steps[i]!.target}" → FAILED (${r.error})`
            : `  step ${i + 1} "${steps[i]!.target}" → (${r.x}, ${r.y})`,
        );
        return fail(
          `Couldn't ground ${failures.length}/${steps.length} target(s) on the current ` +
            `screen. No clicks were performed. Per-step results:\n${lines.join("\n")}\n` +
            "Refine the failed descriptions and re-run, or split into individual " +
            "agent_click calls so each grounding sees the freshest state.",
        );
      }

      // 3b. When `crop` was applied AND we took the batch path that
      //     honors it: validate every returned coord falls within the
      //     cropped window. Out-of-bounds means either the model's
      //     grounding is wrong or (much more likely) the embedded-
      //     screenshot decoy is hitting and the model returned coords
      //     for a target that exists on the picture but not in the
      //     real window — refuse to click and let the orchestrator
      //     recover (cmd+tab + retry).
      if (crop && groundPath === "batch") {
        const oob = groundResults
          .map((r, i) => ({ r, i }))
          .filter(
            ({ r }) => r.x < 0 || r.y < 0 || r.x > crop!.w || r.y > crop!.h,
          );
        if (oob.length > 0) {
          const lines = oob
            .map(
              ({ r, i }) =>
                `  step ${i + 1} "${steps[i]!.target}" → (${r.x}, ${r.y}) ` +
                `(outside cropped ${crop!.w}×${crop!.h} window)`,
            )
            .join("\n");
          return fail(
            `target_outside_window: ${oob.length}/${steps.length} target(s) grounded ` +
              `outside ${targetApp}'s window — likely the embedded-screenshot decoy is ` +
              `hitting (the vision model picked targets from a picture-of-the-app shown ` +
              `in another window on the same display). No clicks were performed. ` +
              `Recover with screen_hotkey('cmd+tab') to refocus ${targetApp} on its ` +
              `display, then re-run this sequence. Out-of-bounds steps:\n${lines}`,
          );
        }
      }

      // 4. Sequential click execution. Bridge per click for perms; small
      //    delay between clicks so each press registers before the next.
      //    Per-step `step.delayMs` overrides the global `delayMs` so a
      //    mixed-pacing sequence (e.g. one slow button in a chain of fast
      //    ones) doesn't have to flatten to its slowest member.
      const tExecStart = Date.now();
      const clicked: Array<{
        target: string;
        mode: string;
        screenX: number;
        screenY: number;
        viaBridge: boolean;
      }> = [];
      // Track whether every click took the bridge path. Used to decide
      // whether the trailing post-settle can be the short 80ms (bridge
      // is synchronous on macOS) or has to be the conservative 300ms
      // (nut-js needs that long for the cursor animation + click event
      // to drain before the post-shot is meaningful). We compute this
      // ALONGSIDE the loop instead of after, so the value is available
      // for the next-iteration delay decision too.
      let allBridgeSoFar = true;
      // Time spent in actual `screen.sleep(delay)` calls. Surfaced in
      // the summary so a slow run is debuggable without re-reading the
      // input args ("did the orchestrator pass stepDelayMs:300 by
      // accident?").
      let totalDelayMs = 0;
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i]!;
        const r = groundResults[i]!;
        // ground errors filtered above — r.x / r.y safe here.
        //
        // Two coord systems:
        //   • CROPPED batch path: `crop` is in PHYSICAL pixels (server
        //     PIL-cropped the raw PNG bytes at physical resolution).
        //     The model returned r.x/r.y in PHYSICAL coords within the
        //     cropped image (since we passed `screen=[crop.w, crop.h]`
        //     where those are physical). Translate by adding the
        //     physical crop offset, then divide by scaleFactor to get
        //     LOGICAL pixels, then add the logical display offset.
        //   • UNCROPPED / parallel fallback: r.x/r.y are already LOGICAL
        //     (server saw the full PNG, we told it `screen=[logical]`).
        //     Just add the display offset.
        let screenX: number;
        let screenY: number;
        if (crop && groundPath === "batch") {
          const xPhysInFrame = r.x + crop.x;
          const yPhysInFrame = r.y + crop.y;
          screenX = xPhysInFrame / scaleFactor + offsetX;
          screenY = yPhysInFrame / scaleFactor + offsetY;
        } else {
          screenX = r.x + offsetX;
          screenY = r.y + offsetY;
        }
        const clickMode = step.mode ?? "single";
        const bridgedClick = await tryBridgeScreenCall<{ ok: boolean }>(
          "/screen/click",
          { x: screenX, y: screenY, mode: clickMode },
        );
        if (!bridgedClick?.ok) {
          allBridgeSoFar = false;
          try {
            await screen.click(screenX, screenY, {
              double: clickMode === "double",
              triple: clickMode === "triple",
              button: clickMode === "right" ? "right" : "left",
            });
          } catch (e) {
            // Mid-sequence failure: report what landed + which step broke,
            // so the orchestrator can pick up from there with agent_click.
            const partial = clicked
              .map(
                (c, idx) =>
                  `  step ${idx + 1} "${c.target}" → clicked at (${c.screenX}, ${c.screenY})`,
              )
              .join("\n");
            return fail(
              `Click failed at step ${i + 1} "${step.target}" (${screenX}, ${screenY}): ` +
                `${e instanceof Error ? e.message : String(e)}.\n` +
                `Completed ${clicked.length}/${steps.length} clicks before failure:\n${partial}`,
            );
          }
        }
        clicked.push({
          target: step.target,
          mode: clickMode,
          screenX,
          screenY,
          viaBridge: !!bridgedClick?.ok,
        });
        const recordType =
          clickMode === "double"
            ? "double_click"
            : clickMode === "triple"
              ? "triple_click"
              : clickMode === "right"
                ? "right_click"
                : "click";
        recordAction({
          type: recordType,
          payload: { x: screenX, y: screenY },
          intent: step.target,
        });
        // Don't delay after the LAST click — we go straight to the post-shot
        // settle, no point doubling the wait. Per-step override beats the
        // global default so callers can tune individual steps.
        if (i < steps.length - 1) {
          const stepDelay = step.delayMs ?? delayMs;
          if (stepDelay > 0) {
            await screen.sleep(stepDelay);
            totalDelayMs += stepDelay;
          }
        }
      }
      const tExec = Date.now() - tExecStart;

      // 5. ONE post-sequence screenshot for verification (vs. one per click).
      //    Settle duration is conditional on bridge mode:
      //      - 80ms when every click took the bridge path. cliclick on
      //        macOS posts CGEvents synchronously into the HID event tap;
      //        80ms is one display-refresh frame plus margin, enough for
      //        the destination app to paint the post-click state.
      //      - 300ms otherwise. nut-js animates the OS cursor and the
      //        click event lands AFTER the cursor arrives; 300ms covers
      //        the worst-case 600px diagonal at the configured speed.
      const postSettleMs = allBridgeSoFar ? 80 : 300;
      await screen.sleep(postSettleMs);
      let postPng: Buffer | undefined;
      const postShot = await tryBridgeScreenCall<{
        pngBase64: string;
      }>("/screen/screenshot", {});
      if (postShot) {
        postPng = Buffer.from(postShot.pngBase64, "base64");
      } else {
        try {
          const s = await screen.screenshot();
          postPng = s.png;
        } catch {
          /* skip post-shot if we can't get it */
        }
      }

      const totalMs = Date.now() - t0;
      const allViaBridge = clicked.every((c) => c.viaBridge);
      const perStepLines = clicked.map(
        (c, i) =>
          `  ${i + 1}. "${c.target}" → (${c.screenX}, ${c.screenY})${
            c.mode !== "single" ? ` [${c.mode}]` : ""
          }`,
      );
      const groundLabel =
        groundPath === "batch"
          ? `provider.groundBatch (1 HTTP, server-side fan-out)`
          : `Promise.all of ${steps.length} ground() calls`;
      const cropTag =
        crop && groundPath === "batch"
          ? `(cropped to ${targetApp} window: ${crop.w}×${crop.h} at ${crop.x},${crop.y}) `
          : targetApp && !crop
            ? `(targetApp="${targetApp}" requested but crop unavailable — see stderr) `
            : "";
      const summary =
        `Clicked ${clicked.length} targets in sequence, sharing one screenshot:\n` +
        perStepLines.join("\n") +
        `\nGround via ${groundLabel}: ${tGround}ms, ` +
        `exec ${tExec}ms (incl. ${totalDelayMs}ms inter-click delay), ` +
        `post-settle ${postSettleMs}ms, total ${totalMs}ms. ` +
        (allViaBridge ? "(via Electron bridge) " : "") +
        cropTag +
        "Post-sequence screenshot attached.";
      const responseContent: Array<
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      > = [{ type: "text" as const, text: summary }];
      if (postPng) {
        responseContent.push({
          type: "image" as const,
          data: postPng.toString("base64"),
          mimeType: "image/png",
        });
      }
      return { content: responseContent };
    },
  );

  // ── BROWSER ENSURE: one entry point for "make a tab driveable" ────
  //
  // Today, half a dozen failure modes happen between "agent calls a
  // tool" and "a tab is driving" — Chrome not running, extension not
  // installed, no green tab, wrong URL. Roll them all into ONE entry
  // point so the agent never has to reason about them. The vision
  // model handles the green-icon click; the OS launchers handle the
  // "Chrome isn't even running" case; the URL/tab matching handles
  // the rest.

  server.registerTool(
    "ponder_browser_ensure",
    {
      title: `${MCP_BRAND}: Ensure a Chrome tab is attached and ready`,
      description:
        "One-shot cold-start: makes sure Chrome is running, the Playwriter " +
        "extension is installed, a tab is attached (vision will click the green " +
        "icon if needed), and — if `url` is supplied — that tab is on the " +
        "right page (navigates or switches tabs as needed). Returns " +
        "{ url, title, viaLaunch?, viaAttach? }. ALWAYS call this before any " +
        "browser_* tool in a fresh session — replaces the old 'click the green " +
        "Playwriter icon yourself' instruction. Caches success for the lifetime " +
        "of this MCP process so subsequent calls short-circuit." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        url: z
          .string()
          .optional()
          .describe(
            "Optional URL to ensure the attached tab is on. If a different tab " +
              "matches, switches to it; otherwise navigates the current one.",
          ),
        tabHint: z
          .string()
          .optional()
          .describe(
            "Optional URL substring to prefer when multiple tabs are attached.",
          ),
        launch: z
          .enum(["user", "managed"])
          .optional()
          .describe(
            "Where to launch Chrome from when it isn't running. 'user' " +
              "(default) opens the user's Chrome with their profile + extensions. " +
              "'managed' spawns a clean Playwriter-managed Chromium for isolation.",
          ),
        session: z
          .string()
          .optional()
          .describe(
            "Optional Ponder session name. Defaults to 'default'. Used for " +
              "isolation across parallel agent flows in the same process.",
          ),
      },
    },
    async ({ url, tabHint, launch, session: sessionName }) => {
      const session = sessionName ?? "default";
      const launchMode = launch ?? "user";
      const wantUrl = url ?? null;
      const wantHint = tabHint ?? null;

      // State 1: already attached on the right tab → return immediately.
      const cached = browserEnsureCache.get(session);
      if (cached && cached.attached) {
        try {
          const browser = await getBrowser();
          if (await browser.available()) {
            const snap = await browser.snapshot();
            if (
              !wantUrl ||
              snap.url === wantUrl ||
              snap.url.startsWith(wantUrl)
            ) {
              return ok(
                `Already attached to ${snap.url} (session "${session}"). ` +
                  `Title: ${snap.title}`,
              );
            }
          }
        } catch {
          /* fall through to full state machine */
        }
      }

      // State 2/3/4: try to attach. We use a lightweight, mostly best-
      // effort flow:
      //   • Try browser.available() first.
      //   • If false, try opening Chrome (state 2) — `open -a "Google Chrome"`.
      //   • Then dispatch a vision agent_do to "Click the green Playwriter
      //     icon" — vision handles the wait + click.
      //   • Poll available() for up to ~6s.
      const browser = await getBrowser();
      let viaLaunch: string | undefined;
      let viaAttach = false;

      if (!(await browser.available())) {
        if (launchMode === "user" && process.platform === "darwin") {
          try {
            const { spawn } = await import("node:child_process");
            spawn("open", ["-a", "Google Chrome"], { detached: true }).unref();
            viaLaunch = "user";
          } catch {
            /* best-effort */
          }
        } else if (launchMode === "managed") {
          // Managed Chromium = spawn a Playwriter `browser start` here in
          // a follow-up; for now we surface that the user can `playwriter
          // browser start` themselves. Auto-launching managed Chromium
          // requires `playwriter` CLI on PATH (gated by `ponder setup`).
          viaLaunch = "managed";
        }
        for (let i = 0; i < 25; i++) {
          await screen.sleep(200);
          if (await browser.available()) break;
        }
      }

      if (!(await browser.available())) {
        // Bridge-based vision click: the agent_do "click the green
        // Playwriter icon" prompt is the user-gesture proxy.
        viaAttach = true;
        try {
          const bridged = await tryForwardToBridge(
            "Click the green Playwriter extension icon in Chrome's toolbar to attach this tab to Playwriter. " +
              (wantHint ? `Prefer the tab whose URL contains "${wantHint}". ` : "") +
              "Surface: menu-bar.",
            async () => {},
            { surface: "menu-bar" },
          );
          if (bridged && !bridged.isError) {
            // Vision flow ran — give the relay 2-3s to register.
            for (let i = 0; i < 15; i++) {
              await screen.sleep(200);
              if (await browser.available()) break;
            }
          }
        } catch {
          /* swallow — handled by available() check below */
        }
      }

      if (!(await browser.available())) {
        const env = new PonderError("BROWSER_NOT_ATTACHED", {
          message:
            "Could not attach a Chrome tab to Playwriter even after auto-attach.",
          hint:
            "Verify the Playwriter extension is installed at " +
            "https://playwriter.dev. Then re-call ponder_browser_ensure.",
        }).toEnvelope();
        return fail(PonderError.format(env));
      }

      // Optional URL targeting.
      let snap = await browser.snapshot();
      if (wantUrl && !snap.url.startsWith(wantUrl)) {
        // Try switching to a matching tab first.
        let switched = false;
        try {
          const tabs = await browser.listTabs();
          const match = tabs.find(
            (t) =>
              t.url === wantUrl ||
              t.url.startsWith(wantUrl) ||
              (wantHint && t.url.toLowerCase().includes(wantHint.toLowerCase())),
          );
          if (match && !match.isCurrent) {
            await browser.switchTab({ index: match.index });
            snap = await browser.snapshot();
            switched = true;
          }
        } catch {
          /* fall through */
        }
        if (!switched) {
          await browser.navigate(wantUrl);
          await screen.sleep(700);
          snap = await browser.snapshot();
        }
      }

      browserEnsureCache.set(session, { attached: true });

      const parts: string[] = [];
      parts.push(`Attached. URL: ${snap.url}`);
      parts.push(`Title: ${snap.title}`);
      parts.push(`Session: ${session}`);
      if (viaLaunch) parts.push(`viaLaunch: ${viaLaunch}`);
      if (viaAttach) parts.push(`viaAttach: true (vision)`);
      return ok(parts.join("\n"));
    },
  );

  // ── PONDER SESSIONS (lightweight names over Playwriter sessions) ──
  //
  // A Ponder session is a logical name a consumer (the MCP process,
  // or an HTTP bridge consumer like anorha) uses to isolate its
  // browser state. One process can hold many named sessions; the
  // default session is "default".
  //
  // These tools are intentionally thin — Playwriter still owns the
  // execution-sandbox abstraction; Ponder just labels the lease so
  // parallel agents don't stomp on each other's tabs.

  server.registerTool(
    "ponder_session_new",
    {
      title: `${MCP_BRAND}: Create a named Ponder session`,
      description:
        "Reserve a named session for isolation. Multiple sessions can run " +
        "in parallel without sharing tabs/cookies." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(40)
          .regex(/^[a-zA-Z0-9_-]+$/)
          .describe("Session name. Letters, digits, '-' and '_' only."),
      },
    },
    async ({ name }) => {
      ponderSessions.add(name);
      return ok(`Created session "${name}". Pass session: "${name}" to ponder_browser_ensure.`);
    },
  );

  server.registerTool(
    "ponder_session_use",
    {
      title: `${MCP_BRAND}: Switch the default Ponder session`,
      description:
        "Change which named session subsequent ponder_browser_ensure / " +
        "browser_* calls default to when no `session` is passed." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        name: z.string().min(1).max(40).regex(/^[a-zA-Z0-9_-]+$/),
      },
    },
    async ({ name }) => {
      defaultPonderSession = name;
      ponderSessions.add(name);
      return ok(`Default Ponder session is now "${name}".`);
    },
  );

  server.registerTool(
    "ponder_session_list",
    {
      title: `${MCP_BRAND}: List active Ponder sessions`,
      description:
        "Enumerate the named sessions reserved in this MCP process. " +
        "Marks the current default with *." +
        BRAND_TAG_SUFFIX,
      inputSchema: {},
    },
    async () => {
      if (ponderSessions.size === 0) {
        return ok(`No named sessions reserved. Default is "${defaultPonderSession}".`);
      }
      const lines = [...ponderSessions].map(
        (s) => `  ${s === defaultPonderSession ? "*" : " "} ${s}`,
      );
      return ok(`Active Ponder sessions:\n${lines.join("\n")}`);
    },
  );

  // ── RECIPE BUFFER: control the process-wide trace buffer ──────────
  //
  // Every browser_* / screen_* tool call (and every agent_do internal
  // action) is appended to a single rolling trace buffer (see
  // recordAction in src/agent/recorder.ts). These tools control that
  // buffer:
  //
  //   • ponder_recipe_start  — clear the buffer; mark "I'm starting a flow"
  //   • ponder_recipe_buffer — read the current buffer (no save)
  //   • ponder_recipe_save   — snapshot the buffer into a saved recipe

  server.registerTool(
    "ponder_recipe_start",
    {
      title: `${MCP_BRAND}: Mark the start of a new recipe recording`,
      description:
        "Clear the process-wide trace buffer and mark this point as the " +
        "start of a new logical flow. OPTIONAL — every action is recorded " +
        "regardless; calling start just gives you a clean buffer + a task " +
        "label for the eventual ponder_recipe_save. Use it at the top of " +
        "any multi-step flow you intend to save as a reusable recipe." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        task: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Human-readable description of the flow. Surfaced as the recipe " +
              "title when saved.",
          ),
      },
    },
    async ({ task }) => {
      startNewTrace({ ...(task ? { task } : {}) });
      const meta = getTraceMeta();
      return ok(
        `Started recipe trace at ${meta.startedAt}. ` +
          `Task: ${meta.task}. Call ponder_recipe_save when the flow finishes.`,
      );
    },
  );

  server.registerTool(
    "ponder_recipe_buffer",
    {
      title: `${MCP_BRAND}: Peek at the current trace buffer`,
      description:
        "Read the current process-wide trace buffer without saving. Returns " +
        "the action count + a compact list of recent actions. Useful when " +
        "the orchestrator wants to inspect what's been captured before " +
        "deciding whether to ponder_recipe_save." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        fromIndex: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "Optional starting index — slice from this offset to the end.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Cap on entries shown in the reply (default 25)."),
      },
    },
    async ({ fromIndex, limit }) => {
      const steps = snapshotTrace(fromIndex);
      const meta = getTraceMeta();
      const cap = limit ?? 25;
      const shown = steps.slice(-cap);
      const lines = shown.map((s, i) => {
        const idx = (steps.length - shown.length + i + 1).toString().padStart(3);
        const payload = JSON.stringify(s.executed.payload).slice(0, 80);
        return `  ${idx}. ${s.executed.type} ${payload}${
          s.intent ? `  // ${s.intent.slice(0, 60)}` : ""
        }`;
      });
      return ok(
        `Trace buffer: ${steps.length} action${steps.length === 1 ? "" : "s"} ` +
          `(task="${meta.task}", started ${meta.startedAt}).\n` +
          (lines.length > 0
            ? `Last ${shown.length}:\n${lines.join("\n")}`
            : "(empty — nothing captured yet)"),
      );
    },
  );

  server.registerTool(
    "ponder_recipe_save",
    {
      title: `${MCP_BRAND}: Save the current trace as a reusable recipe`,
      description:
        "Snapshot the process-wide trace buffer (or a slice starting at " +
        "fromIndex) into a saved recipe on disk under ~/.ponder/recipes/. " +
        "Returns the recipe id + paths + a code block with the generated " +
        "Playwright body. The recipe is replayable via ponder_recipe_replay " +
        "or `ponder run <id>` (no LLM in the loop)." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        id: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Optional id override. By default we derive it from the task " +
              "title + start timestamp.",
          ),
        task: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Optional task description. Falls back to the value set in " +
              "ponder_recipe_start (or 'ponder-trace').",
          ),
        fromIndex: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "Optional starting index — save only the slice from here to the end.",
          ),
      },
    },
    async ({ task, fromIndex }) => {
      const recipe = buildRecipeFromTrace({
        ...(task ? { task } : {}),
        ...(fromIndex !== undefined ? { fromIndex } : {}),
      });
      if (recipe.steps.length === 0) {
        return fail(
          PonderError.format(
            new PonderError("RECIPE_EMPTY", {
              message: "No actions in the trace buffer — nothing to save.",
              hint:
                "Call a browser_* or screen_* tool first, then re-try " +
                "ponder_recipe_save. (Or call ponder_recipe_start to clear " +
                "an old buffer.)",
            }).toEnvelope(),
          ),
        );
      }
      const saved = await saveRecipe(recipe);
      if (!saved) {
        return fail(
          PonderError.format(
            new PonderError("RECIPE_SAVE_FAILED", {
              message: "Disk write failed; recipe was NOT persisted.",
              hint:
                `Verify ~/.ponder/recipes/ is writable. Recipe in-memory still ` +
                `intact (${recipe.steps.length} steps).`,
            }).toEnvelope(),
          ),
        );
      }
      const script = renderRecipeScriptInline(recipe);
      return ok(
        `Saved recipe "${saved.id}" (${recipe.steps.length} step${
          recipe.steps.length === 1 ? "" : "s"
        }).\n` +
          `  • code      ${saved.recipePath}\n` +
          `  • manifest  ${saved.jsonPath}\n\n` +
          `Re-run via:\n` +
          `  ponder run    ${saved.id}\n` +
          `  ponder_recipe_replay({ id: "${saved.id}" })\n\n` +
          `\`\`\`ts\n${script.trimEnd()}\n\`\`\``,
      );
    },
  );

  // ── RECIPE STORE: list / show / replay (recipe-named) ─────────────
  //
  // Renamed from ponder_session_*. The legacy names stay registered
  // below as redirect stubs so old orchestrator code keeps working.

  server.registerTool(
    "ponder_recipe_list",
    {
      title: `${MCP_BRAND}: List recorded recipes`,
      description:
        "Enumerate every recipe recorded to disk under ~/.ponder/recipes/. " +
        "Each entry shows the recipe id, the original task, when it ran, the " +
        "outcome, the step count, and the absolute paths to the JSON manifest " +
        "and the .recipe.ts Playwright script. Use this when the user says " +
        "'show me my recordings', 'what have I run?', 'find the upload from " +
        "yesterday', etc. Newest first." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Cap on rows returned (default 25)."),
        contains: z
          .string()
          .optional()
          .describe(
            "Case-insensitive substring filter on the task text.",
          ),
      },
    },
    async ({ limit, contains }) => {
      const entries = await listRecipes();
      const filtered = contains
        ? entries.filter((e) =>
            e.task.toLowerCase().includes(contains.toLowerCase()),
          )
        : entries;
      const max = limit ?? 25;
      const shown = filtered.slice(0, max);
      if (shown.length === 0) {
        return ok(
          contains
            ? `No recipes match "${contains}". (${entries.length} total in ${RECIPES_DIR})`
            : `No recipes recorded yet — run agent_do or any browser_*/screen_* ` +
                `tool and call ponder_recipe_save when the flow finishes. ` +
                `Recipes land in ${RECIPES_DIR}.`,
        );
      }
      const rows = shown.map((e) => {
        const dur =
          e.durationMs !== undefined
            ? ` ${(e.durationMs / 1000).toFixed(1)}s`
            : "";
        const outcome = e.outcome ? ` [${e.outcome}]` : "";
        return (
          `• ${e.id}\n` +
          `    task: ${e.task.slice(0, 100)}${e.task.length > 100 ? "…" : ""}\n` +
          `    ${e.startedAt}${outcome}${dur}  ${e.steps} step${e.steps === 1 ? "" : "s"}\n` +
          `    code:     ${e.recipePath}\n` +
          `    manifest: ${e.jsonPath}`
        );
      });
      const footer =
        filtered.length > shown.length
          ? `\n\n…and ${filtered.length - shown.length} more (raise \`limit\` to see them).`
          : "";
      return ok(
        `${shown.length} of ${filtered.length} recipe(s) ` +
          `from ${RECIPES_DIR}:\n\n${rows.join("\n\n")}${footer}\n\n` +
          `Open a recipe with ponder_recipe_show({ id: "..." }) ` +
          `or replay one with ponder_recipe_replay({ id: "..." }). ` +
          `From the terminal: \`ponder run <id>\`.`,
      );
    },
  );

  server.registerTool(
    "ponder_recipe_show",
    {
      title: `${MCP_BRAND}: Show a recorded recipe (.recipe.ts or .json)`,
      description:
        "Read a saved recipe's contents — the editable .recipe.ts file " +
        "(default) or the JSON manifest. Returns the file in a fenced code " +
        "block so the orchestrator can echo, edit, or extract pieces." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe(
            "Recipe id from ponder_recipe_list.",
          ),
        format: z
          .enum(["code", "json", "both"])
          .optional()
          .describe(
            "'code' = the editable .recipe.ts file (default). " +
              "'json' = the manifest. 'both' = concatenated.",
          ),
      },
    },
    async ({ id, format }) => {
      const { jsonPath, recipePath } = pathsFor(id);
      const want = format ?? "code";
      const fsp = await import("node:fs/promises");
      const out: string[] = [];
      if (want === "code" || want === "both") {
        try {
          const code = await fsp.readFile(recipePath, "utf-8");
          out.push(
            `# ${recipePath}\n\n\`\`\`ts\n${code.trimEnd()}\n\`\`\``,
          );
        } catch (e) {
          return fail(
            `Could not read recipe code at ${recipePath}: ${
              e instanceof Error ? e.message : String(e)
            }. Call ponder_recipe_list to see available ids.`,
          );
        }
      }
      if (want === "json" || want === "both") {
        try {
          const json = await fsp.readFile(jsonPath, "utf-8");
          out.push(`# ${jsonPath}\n\n\`\`\`json\n${json.trimEnd()}\n\`\`\``);
        } catch (e) {
          if (want === "json") {
            return fail(
              `Could not read manifest at ${jsonPath}: ${
                e instanceof Error ? e.message : String(e)
              }. Call ponder_recipe_list to see available ids.`,
            );
          }
          out.push(
            `# ${jsonPath}\n\n(manifest missing — recipe may have been edited or pruned)`,
          );
        }
      }
      return ok(out.join("\n\n"));
    },
  );

  server.registerTool(
    "ponder_recipe_replay",
    {
      title: `${MCP_BRAND}: Replay a recipe — no LLM in the loop`,
      description:
        "Re-execute every step from a saved recipe manifest, in order, " +
        "natively through the same executors agent_do uses (Playwright for " +
        "browser_* actions, screen.* primitives for OS-level mouse / " +
        "keyboard). NO vision model, NO planner, NO router — deterministic " +
        "script. " +
        "For OS-level coordinate clicks, pass `reground: true` to re-ground " +
        "via the vision model using the step's intent text (recommended for " +
        "any replay across sessions)." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe("Recipe id from ponder_recipe_list."),
        reground: z
          .boolean()
          .optional()
          .describe(
            "Re-ground OS-level coordinate clicks via the vision model. " +
              "Recommended for cross-session replay.",
          ),
        stepDelayMs: z
          .number()
          .int()
          .min(0)
          .max(10_000)
          .optional()
          .describe(
            "Fixed pause between steps in ms. When omitted, replay paces from " +
              "the RECORDED step timestamps (clamped 150-2000ms; up to 8000ms " +
              "after navigations/app launches). Pass a value only to force " +
              "uniform pacing.",
          ),
        params: z
          .record(z.string(), z.any())
          .optional()
          .describe(
            "Per-run values substituted into {{token}} placeholders — in typed " +
              "text, navigated urls, file-input paths (a path of {{photoPaths}} " +
              "expands to the array), AND parameterized click targets (a refLabel " +
              "name like '{{category}}' resolves the matching option/button at " +
              "replay). Turns one recorded flow into a data-driven automation: " +
              "{title, price, category, condition, description, photoPaths}.",
          ),
      },
    },
    async ({ id, reground, stepDelayMs, params }) => {
      const recipe = await loadRecipe(id);
      if (!recipe) {
        return fail(
          PonderError.format(
            new PonderError("RECIPE_NOT_FOUND", {
              message: `Recipe "${id}" not found.`,
              hint: `Call ponder_recipe_list to see available ids (or check ${RECIPES_DIR}).`,
            }).toEnvelope(),
          ),
        );
      }
      if (recipe.steps.length === 0) {
        return ok(`Recipe "${id}" has 0 recorded steps — nothing to replay.`);
      }
      const browser = await getBrowserOrNull();
      let provider: ProviderClient | null = null;
      if (reground) {
        try {
          ({ provider } = await getProviderWarmed());
        } catch (e) {
          return fail(
            `reground=true requires a configured provider: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
      } else {
        // Deterministic replay, but inject a provider (if one is configured)
        // so the per-step vision SELF-HEAL tier can fire on a deterministic
        // miss. Best-effort: an unconfigured/failed provider just means the
        // heal tier is unavailable and missing steps fail-stop as before.
        try {
          ({ provider } = await getProviderWarmed());
        } catch {
          provider = null;
        }
      }

      const lines: string[] = [];
      const t0 = Date.now();
      const result = await replaySession(recipe, {
        reground: !!reground,
        ...(stepDelayMs !== undefined ? { stepDelayMs } : {}),
        ...(params ? { params: params as Record<string, unknown> } : {}),
        browser,
        provider,
        // Self-improve: persist a vision-healed step's durable locator (and
        // refLabel drift) so the NEXT replay resolves deterministically.
        persist: (r) => saveRecipe(r),
        onStep: ({ index, step, status, error, ms }) => {
          const label = step.intent
            ? `"${step.intent.slice(0, 60)}"`
            : step.executed.type;
          if (status === "ok") {
            lines.push(
              `  ${index + 1}. ${step.executed.type} ${label} → ok (${ms}ms)`,
            );
          } else {
            lines.push(
              `  ${index + 1}. ${step.executed.type} ${label} → FAILED: ${(error ?? "").slice(0, 160)}`,
            );
          }
        },
      });
      const summary =
        `Replayed recipe "${id}": ` +
        `${result.ok}/${recipe.steps.length} steps ok, ${result.failed} failed ` +
        `(${((Date.now() - t0) / 1000).toFixed(1)}s).\n\n` +
        `Per-step results:\n${lines.join("\n")}\n\n` +
        (result.failed > 0
          ? `Replay halted at the first failure. Edit ${pathsFor(id).jsonPath} ` +
            `or re-record.`
          : `All steps succeeded. The recipe is reusable as-is.`);
      if (result.failed > 0) return fail(summary);
      return ok(summary);
    },
  );

  // ── Legacy aliases (ponder_session_*) — redirect to ponder_recipe_*
  //
  // Old orchestrator code may still call ponder_session_show / _replay.
  // We keep them registered so the calls succeed; each just delegates to
  // the recipe-named equivalent. `ponder_session_list` is NOT aliased
  // because the new Ponder-session lease tool now owns that name (it
  // lists active leases, not recipes — callers wanting the old behavior
  // should switch to `ponder_recipe_list`).

  server.registerTool(
    "ponder_session_show",
    {
      title: `${MCP_BRAND}: Show recording (alias for ponder_recipe_show)`,
      description:
        "Legacy alias for ponder_recipe_show. Same behavior; prefer the new name." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        id: z.string().min(1),
        format: z.enum(["code", "json", "both"]).optional(),
      },
    },
    async ({ id, format }) => {
      const { jsonPath, recipePath } = pathsFor(id);
      const want = format ?? "code";
      const fsp = await import("node:fs/promises");
      const out: string[] = [];
      if (want === "code" || want === "both") {
        try {
          const code = await fsp.readFile(recipePath, "utf-8");
          out.push(`# ${recipePath}\n\n\`\`\`ts\n${code.trimEnd()}\n\`\`\``);
        } catch (e) {
          return fail(`Could not read recipe code at ${recipePath}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (want === "json" || want === "both") {
        try {
          const json = await fsp.readFile(jsonPath, "utf-8");
          out.push(`# ${jsonPath}\n\n\`\`\`json\n${json.trimEnd()}\n\`\`\``);
        } catch (e) {
          if (want === "json") {
            return fail(`Could not read manifest at ${jsonPath}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
      return ok(out.join("\n\n"));
    },
  );

  server.registerTool(
    "ponder_session_replay",
    {
      title: `${MCP_BRAND}: Replay recording (alias for ponder_recipe_replay)`,
      description:
        "Legacy alias for ponder_recipe_replay. Same behavior; prefer the new name." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        id: z.string().min(1),
        reground: z.boolean().optional(),
        stepDelayMs: z.number().int().min(0).max(10_000).optional(),
      },
    },
    async ({ id, reground, stepDelayMs }) => {
      const recipe = await loadRecipe(id);
      if (!recipe) return fail(`Recipe "${id}" not found.`);
      if (recipe.steps.length === 0) return ok(`Recipe "${id}" has 0 steps.`);
      const browser = await getBrowserOrNull();
      let provider: ProviderClient | null = null;
      if (reground) {
        try {
          ({ provider } = await getProviderWarmed());
        } catch (e) {
          return fail(
            `reground=true requires a configured provider: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      const result = await replaySession(recipe, {
        reground: !!reground,
        ...(stepDelayMs !== undefined ? { stepDelayMs } : {}),
        browser,
        provider,
      });
      const summary = `Replayed "${id}": ${result.ok}/${recipe.steps.length} steps ok, ${result.failed} failed.`;
      if (result.failed > 0) return fail(summary);
      return ok(summary);
    },
  );

  // ── DIAGNOSTIC: report which commit this MCP server is loaded from ──
  //
  // The "stale MCP server PID" failure mode: a Claude Code session is
  // bound to a `tsx src/mcp/server.ts` PID spawned BEFORE the most
  // recent deploy. Symptoms surface much later (a tool's new optional
  // method shows up as undefined, a benchmark falls back to the slow
  // path, etc.) — and the session has no obvious way to detect it.
  //
  // Calling this tool from inside the session returns the exact commit
  // SHA + dirty bit + boot timestamp the loaded server module sees.
  // Compare to `git rev-parse HEAD` on disk; if they differ, the
  // session is stale — restart Claude Code (or run
  // `bash scripts/kill-stale-mcp.sh` between sessions).
  server.registerTool(
    "holo3_version",
    {
      title: `${MCP_BRAND}: Report this MCP server's build identity`,
      description:
        "Diagnostic: returns the git commit SHA, dirty bit, boot timestamp, " +
        "and tool list of the MCP server you're currently connected to. " +
        "Use BEFORE running a benchmark or any test that depends on a recent " +
        "deploy — if the returned `commit` doesn't match `git rev-parse HEAD` " +
        "on disk, the session is bound to a stale server PID. Recovery: ask the " +
        "user to run `bash scripts/kill-stale-mcp.sh` and restart Claude Code, " +
        "then re-call this tool. Cheap (no side effects, no I/O — values are " +
        "resolved once at server boot via src/mcp/build-info.ts and cached)." +
        BRAND_TAG_SUFFIX,
      inputSchema: {},
    },
    async () => {
      const text =
        `commit:      ${BUILD_INFO.commit}\n` +
        `commitShort: ${BUILD_INFO.commitShort}\n` +
        `dirty:       ${BUILD_INFO.dirty}\n` +
        `builtAt:     ${BUILD_INFO.builtAt}\n` +
        `tools (${TOOL_NAMES.length}): ${TOOL_NAMES.join(", ")}`;
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "agent_observe",
    {
      title: `${MCP_BRAND}: Preview where a click would land (no execute)`,
      description:
        "Vision-grounded preview: ground a target description on the current screen " +
        "WITHOUT clicking. Returns the screenshot the model used + the grounded " +
        "coordinates as a text annotation. Use this for: " +
        "(a) sanity-checking that the target you have in mind is actually on screen " +
        "before agent_click commits; " +
        "(b) checking 'is the file picker still open?' or 'did the popover close?' " +
        "without firing an action; " +
        "(c) reading off where the model thinks something is, when an agent_click " +
        "missed and you want to debug. " +
        "Same vision call as agent_click — pay one ~1-2s grounding round-trip, get " +
        "back the result. The orchestrator never receives raw coords for re-use; " +
        "agent_click re-grounds on its own (vision is fast and the screen may have " +
        "changed since)." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        target: z
          .string()
          .min(1)
          .describe("Plain-English description of the element to locate."),
        targetApp: z
          .string()
          .optional()
          .describe(
            "macOS-only speedup: crop to this app's front window before " +
              "grounding (same semantics as agent_click's targetApp). Use " +
              "whenever the target lives in ONE known app window.",
          ),
      },
    },
    async ({ target, targetApp }) => {
      const t0 = Date.now();
      const bridgeShot = await tryBridgeScreenCall<{
        pngBase64: string;
        width: number;
        height: number;
        offsetX: number;
        offsetY: number;
      }>("/screen/screenshot", {});
      let png: Buffer;
      let width: number;
      let height: number;
      let offsetX: number;
      let offsetY: number;
      if (bridgeShot) {
        png = Buffer.from(bridgeShot.pngBase64, "base64");
        width = bridgeShot.width;
        height = bridgeShot.height;
        offsetX = bridgeShot.offsetX;
        offsetY = bridgeShot.offsetY;
      } else {
        try {
          const shot = await screen.screenshot();
          png = shot.png;
          width = shot.width;
          height = shot.height;
          offsetX = shot.offsetX;
          offsetY = shot.offsetY;
        } catch (e) {
          return fail(
            `Screenshot failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      if (targetApp) {
        const croppedFrame = await cropFrameToApp(
          { png, width, height, offsetX, offsetY },
          targetApp,
          !bridgeShot,
        );
        ({ png, width, height, offsetX, offsetY } = croppedFrame);
      }

      let provider: ProviderClient;
      try {
        ({ provider } = await getProviderWarmed());
      } catch (e) {
        return fail(
          `Provider not configured: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      const tGroundStart = Date.now();
      let r;
      try {
        r = await provider.ground({
          instruction: target,
          screenshotB64: png.toString("base64"),
          screen: [width, height],
        });
      } catch (e) {
        return fail(
          `Grounding failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      const tGround = Date.now() - tGroundStart;

      if (r.error) {
        return fail(
          `Couldn't locate "${target}" on the current screen. ${r.error}. ` +
            "Take a screen_screenshot to see what's visible, then refine the description.",
        );
      }
      const screenX = r.x + offsetX;
      const screenY = r.y + offsetY;
      const summary =
        `Located "${target}" at (${screenX}, ${screenY}) ` +
        `[screenshot space (${r.x}, ${r.y}); display offset (${offsetX}, ${offsetY})]. ` +
        `Ground ${tGround}ms, total ${Date.now() - t0}ms. ` +
        "Screenshot attached — verify the location matches what you intended. " +
        "Call agent_click(target) with the SAME description to commit (it re-grounds; " +
        "don't pass coords back).";
      return {
        content: [
          { type: "text" as const, text: summary },
          {
            type: "image" as const,
            data: png.toString("base64"),
            mimeType: "image/png",
          },
        ],
      };
    },
  );

  server.registerTool(
    "screen_type",
    {
      title: `${MCP_BRAND}: OS type text`,
      description:
        "Type text into whatever currently has OS-level keyboard focus — Spotlight " +
        "(after cmd+space), a native app's text field, a Finder rename box, anywhere " +
        "OUTSIDE Chrome. For typing INSIDE a Chrome page use browser_type instead. " +
        "Pass thenPress to chain a key after typing (most often 'enter' to submit a " +
        "Spotlight query like 'open Calculator')." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        text: z.string(),
        thenPress: z
          .string()
          .optional()
          .describe(
            "Optional key/combo to press after typing — e.g. 'enter', 'tab', 'cmd+a'. Useful for 'open Spotlight, type the app name, press enter to launch' in one tool call... actually no, do those as 3 separate calls; this is just for the common 'type then submit' chain.",
          ),
      },
    },
    async ({ text, thenPress }) => {
      // Bridge-first — same rationale as screen_screenshot: keystrokes
      // need macOS Accessibility, which the MCP host often lacks.
      const bridged = await tryBridgeScreenCall<{ ok: boolean }>(
        "/screen/type",
        { text, ...(thenPress ? { thenPress } : {}) },
      );
      if (bridged?.ok) {
        recordAction({
          type: "type",
          payload: { text, ...(thenPress ? { thenPress } : {}) },
        });
        return ok(
          `typed "${text.length > 60 ? text.slice(0, 57) + "..." : text}"` +
            (thenPress ? ` and pressed ${thenPress}` : "") +
            " (via Electron bridge)",
        );
      }
      try {
        await screen.typeText(text);
        if (thenPress) {
          await screen.sleep(120);
          await screen.pressCombo(thenPress);
        }
        recordAction({
          type: "type",
          payload: { text, ...(thenPress ? { thenPress } : {}) },
        });
        return ok(
          `typed "${text.length > 60 ? text.slice(0, 57) + "..." : text}"` +
            (thenPress ? ` and pressed ${thenPress}` : ""),
        );
      } catch (e) {
        return fail(
          `Type failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );

  server.registerTool(
    "screen_hotkey",
    {
      title: `${MCP_BRAND}: OS hotkey / keyboard shortcut`,
      description:
        "Press a keyboard shortcut at the OS level. The fast way to switch apps, launch " +
        "Spotlight, dismiss modals, focus the URL bar, manage tabs/windows. Examples: " +
        "'cmd+space' (open Spotlight), 'cmd+tab' (cycle apps), 'cmd+`' (cycle windows " +
        "within the current app), 'cmd+l' (focus Chrome address bar), 'cmd+t' (new tab), " +
        "'cmd+w' (close window/tab), 'cmd+f' (in-page find), 'esc' (dismiss popover), " +
        "'enter', 'tab', 'shift+tab'. Use BEFORE browser_snapshot when the right tab " +
        "isn't focused yet, or when the answer is faster via keyboard than mouse." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        combo: z
          .string()
          .describe(
            "Plus-separated key combo. Modifiers: cmd, ctrl, alt/option, shift. Examples: 'cmd+space', 'enter', 'shift+tab', 'cmd+shift+t'.",
          ),
      },
    },
    async ({ combo }) => {
      // Bridge-first — same rationale as screen_screenshot.
      const bridged = await tryBridgeScreenCall<{ ok: boolean }>(
        "/screen/hotkey",
        { combo },
      );
      if (bridged?.ok) {
        recordAction({ type: "key", payload: { combo } });
        return ok(`pressed ${combo} (via Electron bridge)`);
      }
      try {
        await screen.pressCombo(combo);
        recordAction({ type: "key", payload: { combo } });
        return ok(`pressed ${combo}`);
      } catch (e) {
        return fail(
          `Hotkey failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );

  server.registerTool(
    "screen_scroll_os",
    {
      title: `${MCP_BRAND}: OS-level scroll wheel`,
      description:
        "Scroll the active OS-level surface — Finder lists, native app content areas, " +
        "anything OUTSIDE a Chrome page. For scrolling a web page use browser_scroll " +
        "instead (more reliable, scrolls the document viewport directly). Auto-recenters " +
        "the cursor to the right two-thirds of the screen before scrolling so the wheel " +
        "doesn't accidentally scroll a sidebar." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        direction: z.enum(["up", "down"]),
        amount: z
          .number()
          .int()
          .optional()
          .describe(
            "Wheel ticks. Default 50 (≈ 3/4 of a viewport). Floored at 50 to ensure visible movement on macOS.",
          ),
      },
    },
    async ({ direction, amount }) => {
      // Bridge-first — same rationale as screen_screenshot.
      const bridged = await tryBridgeScreenCall<{ ok: boolean; ticks: number }>(
        "/screen/scroll",
        { direction, ...(amount !== undefined ? { amount } : {}) },
      );
      if (bridged?.ok) {
        recordAction({
          type: "scroll",
          payload: { direction, amount: bridged.ticks },
        });
        return ok(
          `scrolled ${direction} ${bridged.ticks} ticks (via Electron bridge)`,
        );
      }
      try {
        const SCROLL_FLOOR = 50;
        const ticks = Math.max(SCROLL_FLOOR, amount ?? SCROLL_FLOOR);
        const signed = direction === "up" ? ticks : -ticks;
        await screen.scroll(signed);
        recordAction({
          type: "scroll",
          payload: { direction, amount: ticks },
        });
        return ok(`scrolled ${direction} ${ticks} ticks`);
      } catch (e) {
        return fail(
          `Scroll failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );

  server.registerTool(
    "screen_wait",
    {
      title: `${MCP_BRAND}: Sleep / wait`,
      description:
        "Pause for N milliseconds. Use sparingly — most flows don't need explicit waits " +
        "because browser_navigate and browser_type already settle for typical async UI. " +
        "Reach for this when something genuinely takes longer than the built-in waits: a " +
        "slow app launch, a heavy page load, an animation that won't be settled by other " +
        "tools." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        ms: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .describe("Milliseconds to sleep (capped at 30000 to prevent runaway)."),
      },
    },
    async ({ ms }) => {
      await screen.sleep(ms);
      recordAction({ type: "wait", payload: { ms } });
      return ok(`waited ${ms}ms`);
    },
  );

  // ── Redirect-stubs: catch the orchestrator's most-common naming mistakes
  //
  // The orchestrator (Claude / etc.) pattern-matches the screen_* group
  // and sometimes invents `screen_click` / `screen_drag` / `screen_observe`
  // — those don't exist. The real OS-level vision-grounded tools live in
  // the agent_* namespace (agent_click / agent_drag / agent_observe)
  // because the agent_* prefix means "uses vision grounding" while screen_*
  // means "no grounding — keyboard or scroll".
  //
  // These stubs ALWAYS return a friendly redirect. They never execute.
  // The orchestrator pays one wasted ~10ms call but learns the right tool
  // name, and the next call lands on agent_*. Cheaper than renaming the
  // Phase 9 tools (breaking change) and more discoverable than docs alone
  // (the redirect fires at the moment of the mistake).
  //
  // Schemas mirror the agent_* equivalents so the orchestrator can re-run
  // the same JSON args verbatim against agent_click / agent_drag /
  // agent_observe — copy-paste recovery.

  const screenClickRedirect =
    "screen_click is not a real tool — the OS-level vision-grounded click " +
    "primitive is `agent_click`. The agent_* namespace = vision-grounded; " +
    "screen_* = keyboard / scroll / inspection. Re-call the same args " +
    "against agent_click(target: '<description>', mode?: 'single'|'double'|'right'|'triple').";
  server.registerTool(
    "screen_click",
    {
      title: `${MCP_BRAND}: (use agent_click)`,
      description:
        "REDIRECT: this tool does not exist as a primitive. The OS-level " +
        "vision-grounded click is `agent_click(target, mode?)`. Re-call there." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        target: z.string().optional(),
        mode: z.enum(["single", "double", "right", "triple"]).optional(),
      },
    },
    async ({ target, mode }) => {
      const example = target
        ? `agent_click(target: ${JSON.stringify(target)}${mode ? `, mode: ${JSON.stringify(mode)}` : ""})`
        : `agent_click(target: '<description>', mode?: 'single'|'double'|'right'|'triple')`;
      return fail(`${screenClickRedirect}\n\nExample: ${example}`);
    },
  );

  const screenDragRedirect =
    "screen_drag is not a real tool — the OS-level vision-grounded drag-and-drop " +
    "primitive is `agent_drag`. Re-call the same args against " +
    "agent_drag(from: '<source description>', to: '<target description>').";
  server.registerTool(
    "screen_drag",
    {
      title: `${MCP_BRAND}: (use agent_drag)`,
      description:
        "REDIRECT: this tool does not exist as a primitive. The OS-level " +
        "vision-grounded drag-and-drop is `agent_drag(from, to)`. Re-call there." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        from: z.string().optional(),
        to: z.string().optional(),
      },
    },
    async ({ from, to }) => {
      const example =
        from && to
          ? `agent_drag(from: ${JSON.stringify(from)}, to: ${JSON.stringify(to)})`
          : `agent_drag(from: '<source description>', to: '<target description>')`;
      return fail(`${screenDragRedirect}\n\nExample: ${example}`);
    },
  );

  const screenObserveRedirect =
    "screen_observe is not a real tool — the OS-level vision-grounded preview " +
    "primitive is `agent_observe`. Re-call the same args against " +
    "agent_observe(target: '<description>').";
  server.registerTool(
    "screen_observe",
    {
      title: `${MCP_BRAND}: (use agent_observe)`,
      description:
        "REDIRECT: this tool does not exist as a primitive. The OS-level " +
        "vision-grounded preview is `agent_observe(target)`. Re-call there." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        target: z.string().optional(),
      },
    },
    async ({ target }) => {
      const example = target
        ? `agent_observe(target: ${JSON.stringify(target)})`
        : `agent_observe(target: '<description>')`;
      return fail(`${screenObserveRedirect}\n\nExample: ${example}`);
    },
  );
}

/** List of tool names the server exposes. Used in the boot log so it's
 *  obvious from one line which tools are registered without grepping
 *  the handler. Grouped: agent_do is the high-level loop (PREFERRED for
 *  any OS-level mouse work — has anti-stuck guards); browser_* are
 *  in-page Chrome tools (via Playwriter accessibility refs); screen_*
 *  are OS keyboard / scroll / inspection — none of them aim a mouse at
 *  pixel coordinates. */
export const TOOL_NAMES = [
  // High-level: hand off a focused subtask to the inner Holo3 loop
  "agent_do",
  // Whole-task on H-company's server-side AGP brain (thin-driver fast path)
  "agp_do",
  // Long multi-step task: decompose → route(replay>coarse>agent) → checkpoint/resume
  "long_task",
  // Cold-start one-shot: ensure Chrome + extension + tab are ready
  "ponder_browser_ensure",
  // Ponder session management (lightweight names over Playwriter sessions)
  "ponder_session_new",
  "ponder_session_use",
  "ponder_session_list",
  // In-page browser control (Playwriter / Chrome accessibility refs)
  "browser_status",
  "browser_list_tabs",
  "browser_switch_tab",
  "browser_new_tab",
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_set_input_files",
  "browser_type",
  "browser_scroll",
  "browser_read",
  // Read half: page → structured rows (one fast model pass).
  "extract",
  // Bulk data output — the "write" half of a data task (no-auth).
  "copy_table",
  "write_csv",
  // OS-level vision-grounded primitives (Stagehand-style act/observe split)
  "agent_click",
  "agent_click_sequence",
  "agent_drag",
  "agent_observe",
  // OS-level keyboard / scroll / inspection
  "screen_screenshot",
  "screen_type",
  "screen_hotkey",
  "screen_scroll_os",
  "screen_wait",
  // Redirect stubs
  "screen_click",
  "screen_drag",
  "screen_observe",
  // Recipe recording — process-wide trace buffer + saved recipe store.
  // Every browser_* / screen_* / agent_do action flows through the same
  // buffer; ponder_recipe_save snapshots it into a replayable recipe.
  "ponder_recipe_start",
  "ponder_recipe_buffer",
  "ponder_recipe_save",
  "ponder_recipe_list",
  "ponder_recipe_show",
  "ponder_recipe_replay",
  // Legacy aliases for ponder_recipe_* — kept registered so old code works.
  "ponder_session_show",
  "ponder_session_replay",
  // Diagnostic
  "holo3_version",
] as const;
