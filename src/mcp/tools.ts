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
import type { BrowserClient, BrowserSnapshot } from "../agent/browser/types.js";
import { runTask } from "../agent/loop.js";
import {
  computeDefaultProvider,
  isProviderConfigured,
  makeProvider,
  humanProviderLabel,
} from "../agent/factory.js";
import type { AgentEvents, ProviderClient } from "../agent/types.js";

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
  return (
    "No Chrome tab is attached to Playwriter. " +
    "Open Chrome, install the Playwriter extension if needed, then click " +
    "its icon on the tab you want me to control (the icon turns green). " +
    "Re-call this tool once attached."
  );
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
  outcome: "done" | "cancelled" | "exhausted" | "error";
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
 *   - null when the bridge isn't reachable (caller should fall back) */
async function tryForwardToBridge(
  task: string,
  sendProgress: (msg: string) => Promise<void>,
): Promise<{ isError: boolean; payload: ToolResult } | null> {
  if (!(await bridgeAvailable())) return null;

  await sendProgress(
    `Forwarding to Electron bridge at :${BRIDGE_PORT} (Holo3 app handles the work)`,
  );
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BRIDGE_RUN_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/agent_do`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task }),
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
          : null;
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
    const text = header + body;
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
        "screen_type / screen_hotkey alone. Examples of GOOD inputs: 'select the most " +
        "recent screenshot in this Desktop file picker and click Open', 'click the green " +
        "Playwriter extension icon in Chrome's toolbar', 'drag the README.md icon to the " +
        "trash in the dock'. " +
        "DO NOT pass multi-step goals — those produce wrong inner-planner decompositions " +
        "and almost always exhaust. Anti-patterns: 'open Marketplace, find the Bulbasaur " +
        "listing, click Add, select my screenshot, upload it' (that's 5+ tool calls — YOU " +
        "drive that loop). 'post a Marketplace listing for X' (10+ tool calls — YOU drive). " +
        "Rule: if your task contains more than one verb chained with 'and' / 'then', it " +
        "should probably be that many separate tool calls instead. " +
        "For in-Chrome work prefer browser_* tools directly. agent_do auto-forwards to the " +
        "Electron Holo3 app's bridge when running so your tray-menu provider + perms are " +
        "in effect. Returns a transcript + outcome (done | exhausted | cancelled)." +
        BRAND_TAG_SUFFIX,
      inputSchema: {
        task: z
          .string()
          .min(1)
          .describe(
            "Natural-language description of ONE atomic mouse-aimed step. Should fit " +
              "in one sentence. If you find yourself writing 'and then... and then...', " +
              "you have a multi-step plan — break it into multiple tool calls and observe " +
              "state (browser_snapshot / screen_screenshot) between them. The inner " +
              "agent's planner is small and unreliable for compound goals.",
          ),
      },
    },
    async ({ task }, extra) => {
      return chainAgentDo(async () => {
        const t0 = Date.now();

        // Compound-task guard. If the orchestrator passes a clearly
        // multi-step goal ("open Marketplace, find listing, click Add,
        // select photo, upload"), the inner planner over-decomposes,
        // gets stuck, and exhausts 90s for nothing. Refuse upfront and
        // tell the orchestrator to drive the loop itself.
        //
        // Heuristic: count major clause separators (commas, " and ",
        // " then ", semicolons). 2+ separators = likely compound. Tuned
        // to accept tight single-step descriptions like "select X and
        // click Open" (one separator) while catching multi-goal prompts
        // like "open X, find Y, and upload Z" (two separators).
        const separators =
          (task.match(/,/g) ?? []).length +
          (task.match(/;/g) ?? []).length +
          (task.toLowerCase().match(/\sand\s/g) ?? []).length +
          (task.toLowerCase().match(/\sthen\s/g) ?? []).length;
        const isCompound = separators >= 2;
        if (isCompound) {
          return fail(
            "agent_do received a multi-step task. Break it into separate tool calls and " +
              "observe state between them — YOU are the planner, agent_do is for ONE atomic " +
              "OS-level mouse step (when browser_* won't reach it). Pattern:\n" +
              "  1. browser_snapshot or screen_screenshot   (observe current state)\n" +
              "  2. ONE next-step tool call                 (browser_click, browser_navigate, " +
              "browser_type, agent_do for ONE mouse step, screen_hotkey, etc.)\n" +
              "  3. observe again, decide next step, repeat\n\n" +
              `Rejected task (${task.length} chars, ${separators} clause separators): ` +
              `"${task.length > 200 ? task.slice(0, 197) + "..." : task}"\n\n` +
              "Re-call with just the FIRST step. After it lands, observe the new state " +
              "and call back with the next step.",
          );
        }

        // In-Chrome click guard. The orchestrator keeps misusing agent_do
        // for clicks that have a [eN] ref in the latest browser_snapshot
        // — e.g. "click the Add photo button". Those should be
        // browser_click(ref) so the click happens via Playwright (fast,
        // reliable) rather than vision-grounded agent_do (slow, can
        // pick the wrong element). The trigger: short task starting
        // with "click X" / "tap X" / "press X" with no OS-surface
        // locator keyword. False positives can re-call with explicit
        // OS surface ("click Open in the file picker") to confirm.
        const trimmedLower = task.toLowerCase().trim();
        const startsWithClickVerb =
          /^(?:click|tap)\s+[^\s]/.test(trimmedLower) ||
          // "press <button name>" but NOT "press enter / esc / a key"
          (/^press\s+[^\s]/.test(trimmedLower) &&
            !/^press\s+(?:enter|return|esc(?:ape)?|tab|space|delete|backspace|key|any\s+key|the\s+\w+\s+key)\b/.test(
              trimmedLower,
            ));
        const hasOsLocator =
          /\b(?:file picker|file dialog|save dialog|open dialog|finder|finder window|dock|menu bar|spotlight|system (?:settings|prompt|dialog)|native (?:app|dialog|popup)|os[ -]level|drag\s|drop\s|on\s+the\s+(?:dock|menu bar))\b/.test(
            trimmedLower,
          ) ||
          // App names that imply OS-level surface
          /\b(?:in|on|inside|via)\s+(?:calculator|finder|slack|notes|mail|terminal|spotlight|launchpad|preview|messages|safari|firefox)\b/.test(
            trimmedLower,
          );
        const isLikelyInChromeClick =
          startsWithClickVerb && task.length < 200 && !hasOsLocator;
        if (isLikelyInChromeClick) {
          return fail(
            "agent_do is for OS-level mouse work (file pickers, native apps, drag-and-drop). " +
              `Your task "${task}" looks like an in-Chrome click — call browser_snapshot to ` +
              "find the [eN] ref, then browser_click(ref). browser_click is faster and more " +
              "reliable than vision-grounded agent_do for elements that exist in the Chrome " +
              "accessibility tree.\n\n" +
              "If the target is genuinely OS-level (in a native dialog / Finder / app window), " +
              'mention the surface explicitly so this guard doesn\'t fire: e.g. ' +
              '"click Open in the file picker", "click the New Folder button in Finder", ' +
              '"click the Send button in Slack".',
          );
        }

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
        const bridgeResult = await tryForwardToBridge(task, sendProgress);
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

        // VISION-ONLY by design. We deliberately do NOT pass the
        // Playwriter browser client or the router fast-path here:
        //
        //   • agent_do is meant for OS-level work (file pickers, native
        //     apps, Spotlight, drag-and-drop) where the underlying
        //     Chrome tab's accessibility snapshot is MISLEADING — a
        //     native file dialog is on top of Chrome but Playwriter
        //     still reports the underlying Marketplace page.
        //   • The router (qwen3.5:0.8b) sees that Chrome snapshot and
        //     keeps emitting `browser.navigate` for every subtask,
        //     short-circuiting the vision path entirely. The user's
        //     transcript showed this exact loop: planner decomposes
        //     into "navigate to Desktop, find file, click Open" and
        //     the router responds with `browser.navigate marketplace`
        //     for every subtask. No actual screen work happens.
        //
        // For in-browser orchestration the orchestrator should call
        // browser_* directly — that surface keeps using [eN] refs.
        // agent_do = pure vision, no Chrome context.
        const browser = null;
        const router = null;
        await sendProgress(
          `Started agent_do (provider=${provider.name}, vision-only)`,
        );
        stderrLog(
          `[mcp] agent_do start: ${task.length > 80 ? task.slice(0, 77) + "..." : task}`,
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
              provider: provider.name,
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

        let outcome: "done" | "cancelled" | "exhausted" | "error" = "error";
        let errorMsg: string | undefined;
        const timeoutHandle = setTimeout(() => {
          timedOut = true;
        }, HARD_TIMEOUT_MS);

        try {
          outcome = await runTask({
            task,
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
            shouldCancel: cancelled,
            onBrowserSnapshot: (snap) => {
              lastSnapshot = snap;
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

        const finalText = header + body;

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
    "browser_status",
    {
      title: `${MCP_BRAND}: Browser status`,
      description:
        "Check whether the user's Chrome browser is connected and ready to be controlled. " +
        "Returns the current URL/title when attached, or instructions to attach when not. " +
        "ALWAYS call this first when starting any web task — posting a listing, scraping a " +
        "page, filling a form, navigating a site, automating a flow in Chrome — to confirm " +
        "the browser is reachable before issuing other browser_* calls." +
        BRAND_TAG_SUFFIX,
      inputSchema: {},
    },
    async () => {
      const not = await ensureAttached();
      if (not) return ok(not);
      try {
        const snap = await (await getBrowser()).snapshot();
        return ok(
          `Attached.\nURL: ${snap.url}\nTitle: ${snap.title}\n` +
            `(${snap.ax.split("\n").length} interactive elements visible)`,
        );
      } catch (e) {
        return fail(
          `Snapshot failed after available()=true: ${e instanceof Error ? e.message : String(e)}`,
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
        const note = snap.url !== url ? " (redirected)" : "";
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
        return ok(
          `Attached ${paths.length} file${paths.length === 1 ? "" : "s"} to ${ref}: ${names}. ` +
            "Call browser_snapshot to verify the page accepted the upload " +
            "(thumbnail / progress UI should now be visible).",
        );
      } catch (e) {
        return fail(
          `Set input files on ${ref} failed: ${
            e instanceof Error ? e.message.split("\n")[0] : String(e)
          }`,
        );
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
          return ok(`Scrolled element ${ref} ${direction}`);
        } else {
          await browser.scrollPage(direction, amount);
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

  // ── OS-LEVEL mouse / keyboard tools ───────────────────────────────────
  //
  // These complement the in-page browser_* tools. Use them when the
  // target ISN'T a Chrome page element:
  //   • Spotlight, the app switcher, the macOS menu bar / dock
  //   • Native app windows (Calculator, Finder, Slack, VS Code, etc.)
  //   • Anything that doesn't have an [eN] ref because there's no
  //     accessibility-tree snapshot
  //   • Recovery when browser_click keeps failing — vision-grounded
  //     screen_click via the same Holo3 model that powers agent_do
  //     bypasses the ref/overlay layer entirely.
  //
  // The action tools (screen_click, screen_drag, screen_move) take a
  // natural-language TARGET DESCRIPTION, not pixel coordinates. They
  // screenshot, ask the vision model to ground the description, and add
  // the multi-monitor offset internally. The orchestrator never supplies
  // (x, y) — describe what you want clicked / dragged / hovered.
  //
  // Background mode (cliclick) is auto-detected at boot — when on, the
  // agent's mouse events fire without moving the user's visible cursor.

  // NOTE: there is intentionally NO low-level OS-mouse "click at target"
  // tool exposed via MCP. The orchestrator should never be aiming a
  // single mouse click — for any OS-level mouse work, use agent_do(task)
  // and let the inner Holo3 loop handle aim + retry + anti-stuck guards.
  // Single one-shot vision clicks (which we used to expose) are
  // foot-guns: a wrong ground = a wrong click with no recovery, and
  // chained vision calls amplify latency without the loop's protections.

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
        return ok(`pressed ${combo} (via Electron bridge)`);
      }
      try {
        await screen.pressCombo(combo);
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
        return ok(
          `scrolled ${direction} ${bridged.ticks} ticks (via Electron bridge)`,
        );
      }
      try {
        const SCROLL_FLOOR = 50;
        const ticks = Math.max(SCROLL_FLOOR, amount ?? SCROLL_FLOOR);
        const signed = direction === "up" ? ticks : -ticks;
        await screen.scroll(signed);
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
      return ok(`waited ${ms}ms`);
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
  // In-page browser control (Playwriter / Chrome accessibility refs)
  "browser_status",
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_set_input_files",
  "browser_type",
  "browser_scroll",
  "browser_read",
  // OS-level keyboard / scroll / inspection (no mouse aiming)
  "screen_screenshot",
  "screen_type",
  "screen_hotkey",
  "screen_scroll_os",
  "screen_wait",
] as const;
