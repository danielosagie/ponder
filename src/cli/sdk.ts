/**
 * Ponder SDK — programmatic surface for recording, building, and
 * replaying browser+desktop recipes.
 *
 * The whole package boils down to:
 *
 *   import { defineRecipe, connectToUserChrome, ensureAttached } from "ponder";
 *
 *   // Generated `.recipe.ts` files use this:
 *   export default defineRecipe({
 *     task: "Search Marketplace for bulbasaur",
 *     async run({ page, screen }) {
 *       await page.goto("https://www.facebook.com/marketplace");
 *       await page.getByRole("textbox", { name: "Search" }).fill("bulbasaur");
 *     },
 *   });
 *
 *   // Programmatic — just want a Page bound to the user's Chrome:
 *   const { page, close } = await connectToUserChrome();
 *   await page.goto("https://google.com");
 *   await close();
 *
 *   // Talk to a running Ponder bridge from a separate process (anorha
 *   // and any other consumer):
 *   const client = createPonderClient({ token: "pndr_live_…" });
 *   await client.ensureAttached({ url: "https://example.com" });
 *   const snap = await client.browser.snapshot();
 *
 * Chrome bridge: Playwriter (https://playwriter.dev). We connect to the
 * user's REAL Chrome — same cookies, same logins, same extensions —
 * rather than spawning a fresh Chromium.
 *
 * OS-level primitives (`screen.click`, `screen.type`, `screen.scroll`,
 * etc.) re-ground via the vision model against a fresh screenshot
 * using the original natural-language target — so recordings that
 * involve Finder / Spotlight / native dialogs survive layout shifts.
 *
 * Backwards-compatible aliases — `defineSession` (= `defineRecipe`),
 * `replaySession` (= `replayRecipe`), `createSessionRecorder`, etc. —
 * stay exported so existing imports keep compiling during the rename.
 */

import {
  type RecordedStep,
  type RecordedRecipe,
} from "../agent/recorder.js";
import { createPlaywriterClient } from "../agent/browser/playwriter.js";
import type { BrowserClient } from "../agent/browser/types.js";
import * as screenLow from "../screen.js";
import {
  computeDefaultProvider,
  isProviderConfigured,
  makeProvider,
} from "../agent/factory.js";
import type { ProviderClient } from "../agent/types.js";
import { PonderError } from "../errors.js";

// Re-exports — the public surface of the recorder module.
export {
  createRecipeRecorder,
  createSessionRecorder,
  recordFromBridgeTranscript,
  saveRecipe,
  saveSession,
  loadRecipe,
  loadSession,
  listRecipes,
  listSessions,
  pathsFor,
  resolveRecipeId,
  resolveSessionId,
  latestRecipeId,
  latestSessionId,
  RECIPES_DIR,
  SESSIONS_DIR,
  renderRecipeScript,
  renderSessionScript,
  recordAction,
  snapshotTrace,
  traceLength,
  startNewTrace,
  getTraceMeta,
  buildRecipeFromTrace,
  onTraceStep,
} from "../agent/recorder.js";
export type {
  RecordedStep,
  RecordedRecipe,
  RecordedSession,
  RecipeRecorder,
  SessionRecorder,
  RecipeListEntry,
  SessionListEntry,
  SavedRecipePaths,
  SavedSessionPaths,
  TraceEntry,
} from "../agent/recorder.js";

export { PonderError } from "../errors.js";
export type { PonderErrorCode, PonderErrorEnvelope } from "../errors.js";

// ── defineRecipe — the user-facing authoring API ─────────────────────

/**
 * The arguments a `.recipe.ts` run function receives. Mirrors
 * Playwright's `test({ page })` fixture shape so the muscle memory
 * carries over, plus `screen` for OS-level work that Playwright
 * doesn't cover (Finder, Spotlight, native dialogs, vision-grounded
 * clicks on macOS).
 */
export interface RecipeContext {
  /** Stock Playwright Page, bound to the user's real Chrome via
   *  Playwriter. Use `page.getByRole(...)`, `page.fill(...)`, etc. */
  page: import("playwright-core").Page;
  /** OS-level primitives — re-ground via the vision model where
   *  possible. Use these for actions outside the page viewport. */
  screen: ScreenHandle;
  /** The Playwright browser connection. */
  browser: import("playwright-core").Browser;
}

/** Backwards-compatible alias. */
export type SessionContext = RecipeContext;

/** Options accepted by `defineRecipe`. */
export interface RecipeDefinition {
  /** Short natural-language description of the flow. */
  task: string;
  /** Optional explicit Chrome CDP URL — defaults to the Playwriter
   *  relay at `ws://127.0.0.1:19988/playwright`. */
  chromeUrl?: string;
  /** Per-step timeout (ms) for OS-level vision grounding. Default 20_000. */
  timeoutMs?: number;
  /** The recorded / hand-written steps. Standard Playwright APIs on
   *  `page`, Ponder helpers on `screen`. Throw to abort early. */
  run(ctx: RecipeContext): Promise<void> | void;
}

/** Backwards-compatible alias. */
export type SessionDefinition = RecipeDefinition;

/** Result of running a recipe via `definedRecipe.execute()`. */
export interface RecipeRunResult {
  ok: boolean;
  durationMs: number;
  error?: string;
}

/** Backwards-compatible alias. */
export type SessionRunResult = RecipeRunResult;

/** What `defineRecipe()` returns. Callable + carries metadata. */
export interface DefinedRecipe {
  task: string;
  execute(opts?: {
    chromeUrl?: string;
    timeoutMs?: number;
    onStep?: (event: { intent?: string; ms: number }) => void;
  }): Promise<RecipeRunResult>;
}

/** Backwards-compatible alias. */
export type DefinedSession = DefinedRecipe;

/**
 * Author a Ponder recipe. The returned object is what every
 * `.recipe.ts` file default-exports.
 */
export function defineRecipe(def: RecipeDefinition): DefinedRecipe {
  const recipe: DefinedRecipe = {
    task: def.task,
    async execute(opts = {}): Promise<RecipeRunResult> {
      const t0 = Date.now();
      const chromeUrl = opts.chromeUrl ?? def.chromeUrl;
      const connected = await connectToUserChrome(
        chromeUrl ? { url: chromeUrl } : {},
      );
      const screen = createScreenHandle({
        timeoutMs: opts.timeoutMs ?? def.timeoutMs ?? 20_000,
      });
      try {
        await def.run({
          page: connected.page,
          screen,
          browser: connected.browser,
        });
        return { ok: true, durationMs: Date.now() - t0 };
      } catch (e) {
        return {
          ok: false,
          durationMs: Date.now() - t0,
          error: e instanceof Error ? e.message : String(e),
        };
      } finally {
        await connected.close();
      }
    },
  };
  if (shouldAutoRun()) {
    void recipe.execute().then((result) => {
      if (!result.ok) {
        process.stderr.write(`Ponder recipe failed: ${result.error}\n`);
        process.exit(1);
      } else {
        process.stderr.write(
          `Ponder recipe ok (${(result.durationMs / 1000).toFixed(1)}s)\n`,
        );
        process.exit(0);
      }
    });
  }
  return recipe;
}

/** Backwards-compatible alias for callers still using `defineSession`. */
export const defineSession = defineRecipe;

function shouldAutoRun(): boolean {
  if (process.env.PONDER_NO_AUTORUN === "1") return false;
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return (
      entry.endsWith(".recipe.ts") ||
      entry.endsWith(".recipe.js") ||
      entry.endsWith(".session.ts") ||
      entry.endsWith(".session.js")
    );
  } catch {
    return false;
  }
}

// ── ensureAttached — Chrome cold-start helper (in-process SDK) ───────

/**
 * In-process equivalent of the `ponder_browser_ensure` MCP tool —
 * make sure Chrome + Playwriter relay + a green tab are ready. SDK
 * consumers can call this before `connectToUserChrome` / Playwright
 * APIs so they don't have to handle the cold-start matrix themselves.
 *
 * Returns the current attached URL + title. Throws PonderError when
 * the relay is genuinely unreachable.
 */
export async function ensureAttached(opts: {
  url?: string;
  tabHint?: string;
  timeoutMs?: number;
} = {}): Promise<{ url: string; title: string }> {
  const timeout = opts.timeoutMs ?? 10_000;
  const client = await createPlaywriterClient({});
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await client.available()) {
      const snap = await client.snapshot();
      if (opts.url && !snap.url.startsWith(opts.url)) {
        try {
          const tabs = await client.listTabs();
          const match = tabs.find(
            (t) =>
              t.url === opts.url ||
              t.url.startsWith(opts.url!) ||
              (opts.tabHint && t.url.toLowerCase().includes(opts.tabHint.toLowerCase())),
          );
          if (match && !match.isCurrent) {
            await client.switchTab({ index: match.index });
          } else {
            await client.navigate(opts.url);
          }
          await new Promise((r) => setTimeout(r, 600));
          const after = await client.snapshot();
          return { url: after.url, title: after.title };
        } catch {
          /* fall through */
        }
      }
      return { url: snap.url, title: snap.title };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new PonderError("BROWSER_NOT_ATTACHED", {
    message: "Playwriter relay is not ready (timed out).",
    hint:
      "Open Chrome, install the Playwriter extension from " +
      "https://playwriter.dev, and click its icon on the tab you " +
      "want to drive. From the MCP, call ponder_browser_ensure to " +
      "automate the icon click via vision.",
  });
}

// ── screen.* fixture (OS-level helpers, Playwriter-bridged) ──────────

export interface ScreenHandle {
  click(
    target: string,
    opts?: {
      mode?: "single" | "double" | "triple" | "right";
      fallback?: { x: number; y: number };
    },
  ): Promise<void>;
  drag(opts: { from: { x: number; y: number }; to: { x: number; y: number } }): Promise<void>;
  type(text: string, opts?: { thenPress?: string }): Promise<void>;
  key(combo: string): Promise<void>;
  scroll(direction: "up" | "down", ticks?: number): Promise<void>;
  wait(ms: number): Promise<void>;
}

function createScreenHandle(opts: { timeoutMs: number }): ScreenHandle {
  let providerPromise: Promise<ProviderClient | null> | null = null;
  async function provider(): Promise<ProviderClient | null> {
    if (!providerPromise) {
      providerPromise = (async () => {
        const name = computeDefaultProvider();
        if (!isProviderConfigured(name)) return null;
        const p = makeProvider(name);
        await p.warm().catch(() => {});
        return p;
      })();
    }
    return providerPromise;
  }
  async function ground(target: string): Promise<{ x: number; y: number }> {
    const p = await provider();
    if (!p) {
      throw new PonderError("PROVIDER_NOT_CONFIGURED", {
        message:
          `No vision provider configured — ` +
          `screen.click("${target.slice(0, 60)}") needs grounding.`,
        hint:
          "Set HAI_API_KEY (preferred) or MODAL_BASE_URL+MODAL_BEARER_TOKEN, " +
          "or install Ollama with the holo3 model.",
      });
    }
    const shot = await screenLow.screenshot();
    const r = await Promise.race([
      p.ground({
        instruction: target,
        screenshotB64: shot.png.toString("base64"),
        screen: [shot.width, shot.height],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new PonderError("TIMEOUT", {
                message: `Grounding timed out after ${opts.timeoutMs}ms.`,
                hint: "Bump `timeoutMs` in defineRecipe options or retry.",
              }),
            ),
          opts.timeoutMs,
        ),
      ),
    ]);
    if (r.error) {
      throw new PonderError("GROUNDING_FAILED", {
        message: `Grounding "${target}" failed: ${r.error}`,
        hint:
          "Take a screen_screenshot to see what's visible, then refine " +
          "the description (mention surface or visual cue).",
      });
    }
    return { x: r.x + shot.offsetX, y: r.y + shot.offsetY };
  }
  return {
    async click(target, o = {}) {
      let pt: { x: number; y: number };
      try {
        pt = await ground(target);
      } catch (e) {
        if (o.fallback) {
          pt = o.fallback;
        } else {
          throw e;
        }
      }
      const mode = o.mode ?? "single";
      const cf = {
        double: mode === "double",
        triple: mode === "triple",
        ...(mode === "right" ? { button: "right" as const } : {}),
      };
      await screenLow.click(pt.x, pt.y, cf);
    },
    async drag({ from, to }) {
      await screenLow.drag(from.x, from.y, to.x, to.y);
    },
    async type(text, o = {}) {
      await screenLow.typeText(text);
      if (o.thenPress) {
        await screenLow.sleep(120);
        await screenLow.pressCombo(o.thenPress);
      }
    },
    async key(combo) {
      await screenLow.pressCombo(combo);
    },
    async scroll(direction, ticks = 50) {
      const signed = direction === "up" ? ticks : -ticks;
      await screenLow.scroll(signed);
    },
    async wait(ms) {
      await screenLow.sleep(ms);
    },
  };
}

// ── Replay engine (used by the CLI + MCP tool) ───────────────────────

export interface ReplayStepEvent {
  index: number;
  step: RecordedStep;
  status: "ok" | "error";
  error?: string;
  ms: number;
  failureScreenshot?: Buffer;
}

export interface ReplayResult {
  ok: number;
  failed: number;
  durationMs: number;
  failureScreenshotPath?: string;
}

export interface ReplayOptions {
  reground?: boolean;
  stepDelayMs?: number;
  startStep?: number;
  maxSteps?: number;
  browser?: BrowserClient | null;
  provider?: ProviderClient | null;
  captureFailureScreenshot?: boolean;
  failureScreenshotPath?: string;
  onStep?: (event: ReplayStepEvent) => void | Promise<void>;
  shouldCancel?: () => boolean;
}

/**
 * Replay a saved recipe step-by-step.
 * Halts on first failure.
 */
export async function replayRecipe(
  recipe: RecordedRecipe,
  opts: ReplayOptions = {},
): Promise<ReplayResult> {
  const delay = opts.stepDelayMs ?? 400;
  const browser =
    opts.browser ?? (await createPlaywriterClient({}).catch(() => null));
  let provider: ProviderClient | null = opts.provider ?? null;
  if (opts.reground && !provider) {
    const name = computeDefaultProvider();
    if (!isProviderConfigured(name)) {
      throw new PonderError("PROVIDER_NOT_CONFIGURED", {
        message: "reground=true requires a configured provider.",
        hint:
          "Set HAI_API_KEY (preferred) or MODAL_BASE_URL+MODAL_BEARER_TOKEN, " +
          "or install Ollama with the holo3 model.",
      });
    }
    provider = makeProvider(name);
    await provider.warm().catch(() => {});
  }
  const start = Math.max(0, opts.startStep ?? 0);
  const end =
    opts.maxSteps !== undefined
      ? Math.min(recipe.steps.length, start + opts.maxSteps)
      : recipe.steps.length;

  const t0 = Date.now();
  let ok = 0;
  let failed = 0;
  let failureScreenshotPath: string | undefined;
  for (let i = start; i < end; i++) {
    if (opts.shouldCancel?.()) break;
    const step = recipe.steps[i]!;
    const tStep = Date.now();
    try {
      await replayStep(step, {
        browser,
        provider,
        reground: !!opts.reground,
      });
      ok += 1;
      await opts.onStep?.({
        index: i,
        step,
        status: "ok",
        ms: Date.now() - tStep,
      });
    } catch (e) {
      failed += 1;
      const msg = e instanceof Error ? e.message : String(e);
      let failureScreenshot: Buffer | undefined;
      if (opts.captureFailureScreenshot !== false) {
        try {
          const shot = await screenLow.screenshot();
          failureScreenshot = shot.png;
        } catch {
          /* skip */
        }
        if (failureScreenshot) {
          try {
            const { default: fsp } = await import("node:fs/promises");
            const target =
              opts.failureScreenshotPath ??
              (await defaultFailureScreenshotPath(recipe));
            await fsp.writeFile(target, failureScreenshot);
            failureScreenshotPath = target;
          } catch {
            /* disk write failed */
          }
        }
      }
      await opts.onStep?.({
        index: i,
        step,
        status: "error",
        error: msg,
        ms: Date.now() - tStep,
        ...(failureScreenshot ? { failureScreenshot } : {}),
      });
      break;
    }
    if (i < end - 1 && delay > 0) {
      await screenLow.sleep(delay);
    }
  }
  return {
    ok,
    failed,
    durationMs: Date.now() - t0,
    ...(failureScreenshotPath ? { failureScreenshotPath } : {}),
  };
}

/** Backwards-compatible alias. */
export const replaySession = replayRecipe;

async function defaultFailureScreenshotPath(
  recipe: RecordedRecipe,
): Promise<string> {
  const { RECIPES_DIR } = await import("../agent/recorder.js");
  const path = await import("node:path");
  const iso = recipe.startedAt.replace(/[:.]/g, "-").replace("T", "_").slice(
    0,
    19,
  );
  const slug =
    recipe.task
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task";
  return path.join(RECIPES_DIR, `${iso}-${slug}.last-failure.png`);
}

// ── Single-step replay ───────────────────────────────────────────────

interface ReplayCtx {
  browser: BrowserClient | null;
  provider: ProviderClient | null;
  reground: boolean;
}

async function replayStep(step: RecordedStep, ctx: ReplayCtx): Promise<void> {
  const { executed } = step;
  const p = executed.payload as Record<string, unknown>;
  switch (executed.type) {
    case "browser_navigate":
      if (!ctx.browser) throw new Error("Chrome not attached for browser_navigate");
      await ctx.browser.navigate(String(p.url));
      return;
    case "browser_click":
      if (!ctx.browser) throw new Error("Chrome not attached for browser_click");
      await ctx.browser.click(String(p.ref));
      return;
    case "browser_type":
      if (!ctx.browser) throw new Error("Chrome not attached for browser_type");
      await ctx.browser.type(String(p.ref), String(p.text ?? ""), {
        submit: !!p.submit,
      });
      return;
    case "browser_set_input_files":
      if (!ctx.browser)
        throw new Error("Chrome not attached for browser_set_input_files");
      await ctx.browser.setInputFiles(
        String(p.ref),
        Array.isArray(p.paths) ? (p.paths as string[]) : [],
      );
      return;
    case "browser_scroll_page":
      if (!ctx.browser)
        throw new Error("Chrome not attached for browser_scroll_page");
      await ctx.browser.scrollPage(
        (p.dir as "up" | "down") ?? "down",
        typeof p.amount === "number" ? (p.amount as number) : undefined,
      );
      return;
    case "browser_scroll_element":
      if (!ctx.browser)
        throw new Error("Chrome not attached for browser_scroll_element");
      await ctx.browser.scrollElement(
        String(p.ref),
        (p.dir as "up" | "down") ?? "down",
        typeof p.amount === "number" ? (p.amount as number) : undefined,
      );
      return;
    case "browser_read":
      if (!ctx.browser) throw new Error("Chrome not attached for browser_read");
      await ctx.browser.readText(
        typeof p.ref === "string" ? (p.ref as string) : undefined,
      );
      return;
    case "wait":
      await screenLow.sleep(Number(p.ms ?? 1000));
      return;
    case "type": {
      await screenLow.typeText(String(p.text ?? ""));
      if (typeof p.thenPress === "string" && p.thenPress) {
        await screenLow.sleep(120);
        await screenLow.pressCombo(p.thenPress);
      }
      return;
    }
    case "key":
      await screenLow.pressCombo(String(p.combo));
      return;
    case "scroll": {
      const dir = String(p.direction ?? "down");
      const amount = typeof p.amount === "number" ? (p.amount as number) : 50;
      const signed = dir === "up" ? amount : -amount;
      await screenLow.scroll(signed);
      return;
    }
    case "click":
    case "double_click":
    case "triple_click":
    case "right_click": {
      const coords = await resolveCoords(step, ctx);
      const opts =
        executed.type === "double_click"
          ? { double: true }
          : executed.type === "triple_click"
            ? { triple: true }
            : executed.type === "right_click"
              ? { button: "right" as const }
              : {};
      await screenLow.click(coords.x, coords.y, opts);
      return;
    }
    case "drag": {
      const from = (p.from as { x: number; y: number }) ?? null;
      const to = (p.to as { x: number; y: number }) ?? null;
      if (!from || !to) throw new Error("drag step missing from/to coords");
      await screenLow.drag(from.x, from.y, to.x, to.y);
      return;
    }
    default:
      throw new Error(`Unsupported replay action type: ${executed.type}`);
  }
}

async function resolveCoords(
  step: RecordedStep,
  ctx: { provider: ProviderClient | null; reground: boolean },
): Promise<{ x: number; y: number }> {
  const p = step.executed.payload as Record<string, unknown>;
  const recordedX = typeof p.x === "number" ? (p.x as number) : null;
  const recordedY = typeof p.y === "number" ? (p.y as number) : null;
  if (!ctx.reground) {
    if (recordedX === null || recordedY === null) {
      throw new Error(
        "coord-based action has no recorded x/y AND reground=false. " +
          "Pass reground:true to re-ground via the vision model.",
      );
    }
    return { x: recordedX, y: recordedY };
  }
  if (!ctx.provider) {
    throw new Error("reground=true but provider is null (warmup failed)");
  }
  const intent = step.intent;
  if (!intent) {
    if (recordedX !== null && recordedY !== null) {
      return { x: recordedX, y: recordedY };
    }
    throw new Error(
      "reground=true requires step.intent OR recorded coords, neither present",
    );
  }
  const shot = await screenLow.screenshot();
  const r = await ctx.provider.ground({
    instruction: intent,
    screenshotB64: shot.png.toString("base64"),
    screen: [shot.width, shot.height],
  });
  if (r.error) {
    throw new Error(
      `reground failed for "${intent.slice(0, 60)}": ${r.error}`,
    );
  }
  return { x: r.x + shot.offsetX, y: r.y + shot.offsetY };
}

// ── Chrome connection helper ─────────────────────────────────────────

export interface ConnectedChrome {
  page: import("playwright-core").Page;
  browser: import("playwright-core").Browser;
  close: () => Promise<void>;
}

export async function connectToUserChrome(
  opts: { url?: string } = {},
): Promise<ConnectedChrome> {
  const { chromium } = await import("playwright-core");
  let cdpUrl = opts.url;
  if (!cdpUrl) {
    const probe = await createPlaywriterClient({});
    const available = await probe.available();
    if (!available) {
      throw new PonderError("BROWSER_NOT_ATTACHED", {
        message: "Playwriter relay is not ready.",
        hint:
          "Open Chrome, install the Playwriter extension (https://playwriter.dev), " +
          "and click its icon on the tab you want to control.",
      });
    }
    cdpUrl = "ws://127.0.0.1:19988/playwright";
  }
  const browser = await chromium.connectOverCDP(cdpUrl);
  const ctx = browser.contexts()[0];
  if (!ctx) {
    await browser.close().catch(() => {});
    throw new PonderError("BROWSER_NOT_ATTACHED", {
      message:
        "Connected to Playwriter relay but no Chrome context is attached.",
      hint:
        "Click the green Playwriter icon on a Chrome tab and re-run.",
    });
  }
  const pages = ctx.pages();
  const realPages = pages.filter(
    (p) => !p.url().includes("chrome-extension://") && !p.isClosed(),
  );
  const page =
    realPages.length > 0
      ? realPages[0]!
      : pages.length > 0
        ? pages[0]!
        : await ctx.newPage();
  await page.bringToFront().catch(() => {});
  return {
    page,
    browser,
    close: async () => {
      await browser.close().catch(() => {});
    },
  };
}

// ── createPonderClient — HTTP bridge client for consumers ────────────
//
// Consumers running in a SEPARATE process (anorha, custom CLIs, etc.)
// talk to a running Ponder via its localhost HTTP bridge. This client
// gives them the same surface as the in-process SDK but routed over
// fetch, with optional bearer-token auth (see `ponder grant` for
// issuing keys).

export interface PonderClientOptions {
  /** Bridge base URL. Defaults to `http://127.0.0.1:7900`. */
  url?: string;
  /** API key (Stripe-style `pndr_live_<random>`). When set, sent as
   *  `Authorization: Bearer <token>` on every request. */
  token?: string;
  /** Per-request timeout in ms. Default 30s. */
  timeoutMs?: number;
  /** Optional Ponder session name to scope requests to. */
  session?: string;
}

export interface PonderClient {
  readonly url: string;
  /** Probe `/health` — returns true when the bridge is reachable. */
  health(): Promise<boolean>;
  /** Wrap `ponder_browser_ensure`. */
  ensureAttached(opts?: {
    url?: string;
    tabHint?: string;
    launch?: "user" | "managed";
  }): Promise<{ url: string; title: string }>;
  /** Browser primitives (subset of the MCP browser_* tools). */
  browser: {
    snapshot(): Promise<{ url: string; title: string; ax: string }>;
    click(ref: string): Promise<void>;
    type(ref: string, text: string, opts?: { submit?: boolean }): Promise<void>;
    navigate(url: string): Promise<{ url: string; title: string }>;
    setInputFiles(ref: string, paths: string[]): Promise<void>;
    scroll(opts: {
      direction: "up" | "down";
      ref?: string;
      amount?: number;
    }): Promise<void>;
    read(ref?: string): Promise<string>;
  };
  /** Recipe operations. */
  recipe: {
    save(opts?: {
      task?: string;
      fromIndex?: number;
    }): Promise<{ id: string; recipePath: string; jsonPath: string }>;
    list(): Promise<
      Array<{
        id: string;
        task: string;
        steps: number;
        recipePath: string;
        jsonPath: string;
      }>
    >;
    get(id: string): Promise<RecordedRecipe | null>;
    run(id: string, opts?: { reground?: boolean }): Promise<ReplayResult>;
  };
  /** Run a free-form agent_do task on the bridge. */
  agentDo(opts: {
    task: string;
    targetApp?: string;
    maxSteps?: number;
  }): Promise<{ outcome: string; steps: number; finalUrl?: string }>;
}

/** Build a typed Ponder client speaking to a running bridge at
 *  http://127.0.0.1:7900 (override via opts.url). */
export function createPonderClient(
  opts: PonderClientOptions = {},
): PonderClient {
  const url = (opts.url ?? "http://127.0.0.1:7900").replace(/\/$/, "");
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const session = opts.session ?? "default";

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
    try {
      const res = await fetch(`${url}${path}`, {
        method,
        headers,
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      if (!res.ok) {
        const env =
          parsed && typeof parsed === "object" && "code" in parsed
            ? (parsed as { code: string; message?: string; hint?: string; docs_url?: string })
            : null;
        if (env) {
          throw new PonderError(
            env.code as never,
            {
              message: env.message ?? `HTTP ${res.status}`,
              hint: env.hint ?? "",
              docsUrl: env.docs_url,
            },
          );
        }
        throw new PonderError("INTERNAL_ERROR", {
          message: `HTTP ${res.status} from ${path}: ${text.slice(0, 200)}`,
        });
      }
      return parsed as T;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    url,
    async health(): Promise<boolean> {
      try {
        await call<unknown>("GET", "/health");
        return true;
      } catch {
        return false;
      }
    },
    async ensureAttached(o = {}): Promise<{ url: string; title: string }> {
      return call<{ url: string; title: string }>("POST", "/browser/attach", {
        session,
        ...o,
      });
    },
    browser: {
      snapshot(): Promise<{ url: string; title: string; ax: string }> {
        return call("POST", "/browser/snapshot", { session });
      },
      click(ref: string): Promise<void> {
        return call("POST", "/browser/click", { session, ref });
      },
      type(
        ref: string,
        text: string,
        o: { submit?: boolean } = {},
      ): Promise<void> {
        return call("POST", "/browser/type", {
          session,
          ref,
          text,
          ...(o.submit ? { submit: true } : {}),
        });
      },
      navigate(navUrl: string): Promise<{ url: string; title: string }> {
        return call("POST", "/browser/navigate", { session, url: navUrl });
      },
      setInputFiles(ref: string, paths: string[]): Promise<void> {
        return call("POST", "/browser/set_input_files", {
          session,
          ref,
          paths,
        });
      },
      scroll(o: {
        direction: "up" | "down";
        ref?: string;
        amount?: number;
      }): Promise<void> {
        return call("POST", "/browser/scroll", { session, ...o });
      },
      read(ref?: string): Promise<string> {
        return call<{ text: string }>("POST", "/browser/read", {
          session,
          ...(ref ? { ref } : {}),
        }).then((r) => r.text);
      },
    },
    recipe: {
      save(o: { task?: string; fromIndex?: number } = {}): Promise<{
        id: string;
        recipePath: string;
        jsonPath: string;
      }> {
        return call("POST", "/recipe/save", { session, ...o });
      },
      list(): Promise<
        Array<{
          id: string;
          task: string;
          steps: number;
          recipePath: string;
          jsonPath: string;
        }>
      > {
        return call<{
          recipes: Array<{
            id: string;
            task: string;
            steps: number;
            recipePath: string;
            jsonPath: string;
          }>;
        }>("GET", "/recipe/list").then((r) => r.recipes);
      },
      async get(id: string): Promise<RecordedRecipe | null> {
        try {
          return await call<RecordedRecipe>("GET", `/recipe/${encodeURIComponent(id)}`);
        } catch (e) {
          if (e instanceof PonderError && e.code === "RECIPE_NOT_FOUND") return null;
          throw e;
        }
      },
      run(id: string, o: { reground?: boolean } = {}): Promise<ReplayResult> {
        return call<ReplayResult>("POST", "/recipe/run", {
          session,
          id,
          ...o,
        });
      },
    },
    agentDo(o: {
      task: string;
      targetApp?: string;
      maxSteps?: number;
    }): Promise<{ outcome: string; steps: number; finalUrl?: string }> {
      return call("POST", "/agent_do", o);
    },
  };
}
