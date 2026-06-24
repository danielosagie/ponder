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
  parseAxRefs,
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
  /** Move the pointer without clicking — hover menus / tooltips. */
  hover(x: number, y: number): Promise<void>;
  /** Launch or foreground a macOS app by name (AppleScript activate). */
  openApp(name: string): Promise<void>;
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
    async hover(x, y) {
      await screenLow.hover(x, y);
    },
    async openApp(name) {
      const ok = await screenLow.raiseMacApp(name);
      if (!ok) {
        throw new PonderError("INTERNAL_ERROR", {
          message: `Could not launch/activate "${name}".`,
          hint: "Check the app name matches the .app bundle name exactly.",
        });
      }
      // Launched app needs time to draw before any follow-up grounding.
      await screenLow.sleep(2000);
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
  /** Steps whose refLabel drifted (e.g. a renamed button) and were healed
   *  + rewritten in place. >0 means the recipe was persisted via opts.persist. */
  healed?: number;
}

export interface ReplayOptions {
  reground?: boolean;
  /**
   * Fixed inter-step delay. When set, every gap is exactly this many
   * ms (legacy behavior). When unset, replay paces from the RECORDED
   * step timestamps: each gap is the original `t` delta clamped to
   * [150, 2000]ms — raised to 8000ms after launch-type actions
   * (navigate, Spotlight, submit-typing) where the recorded gap
   * genuinely covers an app/page coming up. A flat 400ms used to race
   * past those settles; raw deltas would oversleep on the recording's
   * model think time — the asymmetric clamp is the compromise.
   */
  stepDelayMs?: number;
  startStep?: number;
  maxSteps?: number;
  browser?: BrowserClient | null;
  provider?: ProviderClient | null;
  captureFailureScreenshot?: boolean;
  failureScreenshotPath?: string;
  onStep?: (event: ReplayStepEvent) => void | Promise<void>;
  shouldCancel?: () => boolean;
  /**
   * Called once after replay if any step's refLabel drifted and was healed
   * (e.g. a platform renamed a button). Receives the MUTATED recipe so the
   * caller can persist it (saveRecipe) — the recipe then self-heals
   * permanently. Omit to keep replay read-only.
   */
  persist?: (recipe: RecordedRecipe) => Promise<unknown>;
  /**
   * Per-run values substituted into the recipe at replay time. Any `{{key}}`
   * token in a typed string / navigated url is replaced with `params[key]`, and
   * a file-input path of exactly `{{key}}` expands to `params[key]` (an array of
   * paths). This is what turns a recorded create/update flow into a reusable,
   * data-driven automation — the desktop consumer passes the browser-job payload
   * here so one recipe lists ANY item, not just the one it was recorded with.
   */
  params?: Record<string, unknown>;
}

/**
 * Replay a saved recipe step-by-step.
 * Halts on first failure.
 */
export async function replayRecipe(
  recipe: RecordedRecipe,
  opts: ReplayOptions = {},
): Promise<ReplayResult> {
  // Recorded pacing by default; fixed delay when the caller sets one.
  //
  // Caveat (review 2026-06-10): recorded t-deltas include the
  // RECORDING'S model/orchestrator think time (~2-4s/step for agent_do,
  // 5-30s for LLM-driven direct calls), not just UI settle — so the
  // ceiling is kept tight (2s) for ordinary actions and raised only
  // after launch-type actions (navigate, Spotlight, submit-typing)
  // where the gap genuinely covers an app/page coming up. `wait` steps
  // already replay their own sleep, so their gap is floor-only.
  const gapFor = (i: number): number => {
    if (opts.stepDelayMs !== undefined) return opts.stepDelayMs;
    const cur = recipe.steps[i];
    const next = recipe.steps[i + 1];
    if (typeof cur?.t !== "number" || typeof next?.t !== "number") return 400;
    if (cur.executed.type === "wait") return 150;
    const payload = cur.executed.payload as Record<string, unknown>;
    const launchish =
      cur.executed.type === "browser_navigate" ||
      (cur.executed.type === "key" &&
        /cmd\+space/i.test(String(payload.combo ?? ""))) ||
      (cur.executed.type === "type" && Boolean(payload.thenPress));
    const ceiling = launchish ? 8000 : 2000;
    return Math.min(ceiling, Math.max(150, next.t - cur.t));
  };
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
  // ONE ctx for the whole replay — healedOnce must persist across steps
  // (a heal renumbers every [eN] in the DOM, so once we've healed,
  // later recorded refs are unreliable and labeled steps heal-first).
  const ctx: ReplayCtx = { browser, provider, reground: !!opts.reground, dirty: false, driftCount: 0, params: opts.params };
  for (let i = start; i < end; i++) {
    if (opts.shouldCancel?.()) break;
    const step = recipe.steps[i]!;
    const tStep = Date.now();
    try {
      await replayStep(step, ctx);
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
    const delay = gapFor(i);
    if (i < end - 1 && delay > 0) {
      await screenLow.sleep(delay);
    }
  }
  // A heal rewrote one or more refLabels (platform drift) — persist the
  // updated recipe so the next run is exact. The recipe self-heals.
  if (ctx.dirty && opts.persist) {
    try {
      await opts.persist(recipe);
    } catch (e) {
      console.warn(
        `[replay] persist after heal failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return {
    ok,
    failed,
    durationMs: Date.now() - t0,
    healed: ctx.driftCount ?? 0,
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
  /** Set after the first successful heal. Healing takes a fresh
   *  snapshot, which RENUMBERS every data-holo-ref in the DOM — from
   *  that point recorded refs are unreliable, so labeled steps resolve
   *  via their refLabel FIRST instead of trying the stale ref. */
  healedOnce?: boolean;
  /** A step's refLabel drifted (platform renamed an element) and was
   *  rewritten in place — the recipe should be persisted post-replay. */
  dirty?: boolean;
  driftCount?: number;
  /** Per-run substitution values ({{key}} in typed text / urls / file paths). */
  params?: Record<string, unknown>;
}

/** Substitute `{{key}}` tokens in a recorded string with run-time params. */
function applyParams(value: string, params?: Record<string, unknown>): string {
  if (!params) return value;
  return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k: string) => {
    const v = params[k];
    return v == null ? "" : String(v);
  });
}

/** Resolve a recorded file-input path list with run params. A path of exactly
 *  `{{key}}` expands to params[key] (an array of paths, or a single path);
 *  otherwise tokens inside each path string are substituted. Lets a recorded
 *  "upload one photo" step replay with N real photos from the job payload. */
function resolveFilePaths(raw: unknown, params?: Record<string, unknown>): string[] {
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const out: string[] = [];
  for (const item of list) {
    const s = String(item);
    const whole = s.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
    if (whole && params) {
      const v = params[whole[1]!];
      if (Array.isArray(v)) out.push(...v.map((x) => String(x)));
      else if (v != null) out.push(String(v));
      continue;
    }
    out.push(applyParams(s, params));
  }
  return out.filter(Boolean);
}

/** A self-heal match: the current [eN] ref plus the matched element's
 *  CURRENT role+name (which may differ from the recorded refLabel when a
 *  platform renamed it — that drift gets persisted back into the recipe). */
interface HealMatch {
  ref: string;
  currentLabel: { role: string; name: string };
}

/**
 * Self-healing ref resolution (Stagehand-style, 2026-06-10): recorded
 * [eN] refs are per-snapshot ephemera — on replay against a reloaded
 * page they point at nothing (or the wrong element). When a ref-based
 * action FAILS and the step carries a refLabel (role + accessible
 * name, captured at record time), take a fresh snapshot and find the
 * element that matches the durable label; retry with the current ref.
 * The recorded ref is always tried first, so an unchanged page replays
 * byte-identically to the old behavior.
 */
async function healRef(
  step: RecordedStep,
  ctx: ReplayCtx,
): Promise<HealMatch | null> {
  const label = step.refLabel;
  if (!label || !ctx.browser) return null;
  // An EMPTY accessible name (icon-only buttons, unnamed inputs) matches
  // every unnamed element of that role — healing on it would act on an
  // arbitrary element. Refuse; the caller fail-stops instead.
  const wantName = label.name.trim();
  if (!wantName) return null;
  try {
    const snap = await ctx.browser.snapshot();
    // The snapshot above RENUMBERED every data-holo-ref on the page —
    // from this moment raw recorded refs are unreliable for the rest of
    // the replay, match or no match.
    ctx.healedOnce = true;
    const refs = parseAxRefs(snap.ax);
    const want = wantName.toLowerCase();
    // Three tiers, each requiring a UNIQUE match: pages with repeated
    // controls (multiple "Delete" buttons in a list) must not heal the Nth
    // instance to the 1st. Ambiguity → null → caller fail-stops.
    //   1. exact role + name (unchanged page → byte-identical replay)
    //   2. same role, case/whitespace-insensitive name (minor drift)
    //   3. same role, CURRENT name CONTAINS the recorded name (platform
    //      rename, e.g. "Submit" → "Submit order") — the drift is captured
    //      in currentLabel and persisted back into the recipe.
    const exact: HealMatch[] = [];
    const loose: HealMatch[] = [];
    const drifted: HealMatch[] = [];
    for (const [ref, l] of refs) {
      if (l.role !== label.role) continue;
      const cur = l.name.trim();
      const curLc = cur.toLowerCase();
      const m: HealMatch = { ref, currentLabel: { role: l.role, name: cur } };
      if (l.name === label.name) exact.push(m);
      if (curLc === want) loose.push(m);
      if (cur && curLc.includes(want)) drifted.push(m);
    }
    if (exact.length === 1) return exact[0]!;
    // Multiple same-name matches normally fail-stop: a list of repeated controls
    // (several "Delete" buttons) must not heal the Nth instance to the 1st.
    // EXCEPTION — file-inputs: FB's create form exposes TWO file-inputs both
    // accessible-named "file" (photo accepts=image/* then video accepts=video/*).
    // An upload step targets the primary/photo input, which is FIRST in document
    // order (parseAxRefs preserves DOM order), so prefer it instead of fail-
    // stopping. (Ideally we'd disambiguate by the `accepts` attribute, but the
    // ax label doesn't carry it; document order is the reliable proxy here.)
    if (exact.length > 1) return label.role === "file-input" ? exact[0]! : null;
    if (loose.length === 1) return loose[0]!;
    if (loose.length > 1) return label.role === "file-input" ? loose[0]! : null;
    if (drifted.length === 1) return drifted[0]!;
  } catch {
    /* snapshot failed — nothing to heal with */
  }
  return null;
}

/**
 * Resolve a UNIQUE element ref by role + run-time name from a fresh snapshot.
 * Used for PARAMETERIZED click targets (the {{token}} branch in withHealedRef):
 * locate the option / button whose accessible name matches the substituted
 * value. Same exact → case-insensitive → contains tiering as healRef, each
 * requiring uniqueness so a list of repeated controls can't mis-resolve.
 */
async function resolveByLabel(
  ctx: ReplayCtx,
  role: string,
  wantName: string,
): Promise<string | null> {
  if (!ctx.browser || !wantName.trim()) return null;
  try {
    const snap = await ctx.browser.snapshot();
    ctx.healedOnce = true; // snapshot renumbered refs — later raw refs unreliable
    const refs = parseAxRefs(snap.ax);
    const want = wantName.trim().toLowerCase();
    const exact: string[] = [];
    const loose: string[] = [];
    const contains: string[] = [];
    for (const [ref, l] of refs) {
      if (l.role !== role) continue;
      const cur = l.name.trim();
      if (l.name === wantName) exact.push(ref);
      if (cur.toLowerCase() === want) loose.push(ref);
      if (cur && cur.toLowerCase().includes(want)) contains.push(ref);
    }
    if (exact.length === 1) return exact[0]!;
    if (exact.length > 1) return null;
    if (loose.length === 1) return loose[0]!;
    if (loose.length > 1) return null;
    if (contains.length === 1) return contains[0]!;
  } catch {
    /* snapshot failed */
  }
  return null;
}

/** Temp aria-ref the label-anchor resolver tags its match with. */
const HEAL_REF = "__holo_heal";

/**
 * LABEL-ANCHORED resolution (needs `browser.evaluate`): find the form control
 * sitting next to a visible label whose text === fieldLabel, tag it with a temp
 * data-holo-ref, and return that ref so the normal type/click path can act. This
 * is the robust fix for forms whose inputs have empty/duplicate accessible names
 * (FB's Title & Price are BOTH `textbox "text"`) — we locate by the human label
 * the way a person does. Returns the temp ref or null. The DOM heuristic checks
 * label→for, the input inside the label's container, then forward siblings.
 */
async function resolveByFieldLabel(
  ctx: ReplayCtx,
  fieldLabel: string,
): Promise<string | null> {
  if (!ctx.browser?.evaluate || !fieldLabel.trim()) return null;
  const want = JSON.stringify(fieldLabel.trim().toLowerCase());
  const tag = JSON.stringify(HEAL_REF);
  const expr = `(() => {
    const want = ${want}, TAG = ${tag};
    const CTRL = 'input,textarea,select,[contenteditable="true"],[role="combobox"],[role="textbox"],[role="spinbutton"]';
    document.querySelectorAll('[data-holo-ref="'+TAG+'"]').forEach(e => e.removeAttribute('data-holo-ref'));
    const vis = el => el && el.offsetParent !== null;
    const norm = s => (s||'').replace(/\\s+/g,' ').trim().toLowerCase();
    // 1. <label for> / aria-labelledby
    for (const lab of document.querySelectorAll('label')) {
      if (norm(lab.textContent) !== want || !vis(lab)) continue;
      let ctrl = lab.htmlFor ? document.getElementById(lab.htmlFor) : null;
      ctrl = ctrl || lab.querySelector(CTRL);
      if (ctrl && vis(ctrl)) { ctrl.setAttribute('data-holo-ref', TAG); return true; }
    }
    // 2. any element whose exact text is the label → nearest control in container or following siblings
    const labels = [...document.querySelectorAll('label,span,div,h1,h2,h3,legend')].filter(el => vis(el) && norm(el.textContent) === want);
    for (const lab of labels) {
      let scope = lab.parentElement;
      for (let up = 0; up < 3 && scope; up++, scope = scope.parentElement) {
        const c = scope.querySelector(CTRL);
        if (c && vis(c)) { c.setAttribute('data-holo-ref', TAG); return true; }
      }
      let n = lab;
      for (let i = 0; i < 6 && n; i++) {
        n = n.nextElementSibling;
        if (!n) break;
        const c = n.matches && n.matches(CTRL) ? n : (n.querySelector && n.querySelector(CTRL));
        if (c && vis(c)) { c.setAttribute('data-holo-ref', TAG); return true; }
      }
    }
    return false;
  })()`;
  try {
    const found = await ctx.browser.evaluate(expr);
    return found === true ? HEAL_REF : null;
  } catch {
    return null;
  }
}

/** Temp aria-ref the vision-heal resolver tags its located element with. */
const VISION_REF = "__holo_vision";

/**
 * Build a natural-language INTENT for the vision model from a step's type +
 * durable hints (refLabel / fieldLabel / substituted value). This is what
 * gets grounded against the browser screenshot when every deterministic
 * resolver has missed. `nameOverride` lets the parameterized branch pass the
 * substituted run-time name (e.g. "Used - Good") instead of the {{token}}.
 *
 * Exported for the bench (intent-string builder is unit-testable without
 * live vision).
 */
export function buildVisionIntent(
  step: RecordedStep,
  params?: Record<string, unknown>,
  nameOverride?: string,
): string {
  const p = step.executed.payload as Record<string, unknown>;
  const role = step.refLabel?.role ?? "";
  const name = (nameOverride ?? step.refLabel?.name ?? "").trim();
  const fieldLabel = typeof p.fieldLabel === "string" ? p.fieldLabel.trim() : "";
  const sub = (s: string): string => applyParams(s, params);
  const named = name ? sub(name) : "";
  switch (step.executed.type) {
    case "browser_type": {
      const anchor = fieldLabel || named;
      return anchor
        ? `the ${anchor} input field`
        : `the text input field`;
    }
    case "browser_click": {
      // role gives the control kind (button / link / combobox / option…),
      // name gives the visible label. Either may be absent.
      const kind = role && role !== "button" ? role : "button";
      if (named && role) return `the ${named} ${kind}`;
      if (named) return `the ${named} ${kind}`;
      if (fieldLabel) return `the ${fieldLabel} ${kind}`;
      return `the ${kind}`;
    }
    case "browser_scroll_element":
      return named ? `the ${named} area` : `the scrollable area`;
    default:
      return named || fieldLabel || `the ${role || "element"}`;
  }
}

/**
 * Convert grounded DEVICE-pixel coords to CSS px (the space elementFromPoint
 * + Playwright mouse use). Mirrors browser-driver.ts toCss(): scale =
 * imgW / window.innerWidth (≈2 on Retina, 1 on 1×). Returns null when dims
 * or scale are non-finite/zero (grounding-failed → caller fail-stops; never
 * click at 0,0). Exported for the bench (coord math is unit-testable).
 */
export function visionCoordsToCss(
  groundX: number,
  groundY: number,
  imgW: number,
  innerW: number,
): { cssX: number; cssY: number } | null {
  if (!Number.isFinite(imgW) || imgW <= 0) return null;
  if (!Number.isFinite(innerW) || innerW <= 0) return null;
  if (!Number.isFinite(groundX) || !Number.isFinite(groundY)) return null;
  const scale = imgW / innerW;
  if (!Number.isFinite(scale) || scale <= 0) return null;
  return {
    cssX: Math.round(groundX / scale),
    cssY: Math.round(groundY / scale),
  };
}

/** Shape returned by the in-page elementFromPoint tag+probe. */
interface VisionLocator {
  ok: boolean;
  role?: string;
  name?: string;
  fieldText?: string;
}

/**
 * Page-context script: given CSS-px coords, find document.elementFromPoint,
 * walk up to the nearest ACTIONABLE ancestor (button/link/input/etc.), tag it
 * with data-holo-ref=__holo_vision, and return a durable locator (role + name
 * + nearest field label). Returns { ok:false } when the point hits nothing
 * actionable (body / a non-control wrapper) so the caller fail-stops instead
 * of clicking a random container. Mirrors playwriter SNAPSHOT_SCRIPT roleOf/
 * nameOf so the persisted refLabel matches what a fresh snapshot would emit.
 */
function visionTagScript(cssX: number, cssY: number): string {
  const tag = JSON.stringify(VISION_REF);
  return `(() => {
    const TAG = ${tag}, X = ${cssX}, Y = ${cssY};
    document.querySelectorAll('[data-holo-ref="'+TAG+'"]').forEach(e => e.removeAttribute('data-holo-ref'));
    let el = document.elementFromPoint(X, Y);
    if (!el) return { ok: false };
    const ACTIONABLE = 'button,a[href],input:not([type=hidden]),textarea,select,[role="button"],[role="link"],[role="textbox"],[role="searchbox"],[role="combobox"],[role="option"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="radio"],[role="switch"],[contenteditable="true"]';
    const ctrl = el.closest(ACTIONABLE);
    if (!ctrl) return { ok: false };
    function roleOf(e) {
      const explicit = e.getAttribute('role');
      if (explicit) return explicit;
      const tg = e.tagName.toLowerCase();
      if (tg === 'a') return 'link';
      if (tg === 'button') return 'button';
      if (tg === 'input') {
        const t = (e.type || 'text').toLowerCase();
        if (t === 'file') return 'file-input';
        if (t === 'submit' || t === 'button') return 'button';
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        return 'textbox';
      }
      if (tg === 'select') return 'combobox';
      if (tg === 'textarea') return 'textbox';
      return tg;
    }
    function nameOf(e) {
      const aria = e.getAttribute('aria-label');
      if (aria) return aria.trim();
      const lb = e.getAttribute('aria-labelledby');
      if (lb) { const l = document.getElementById(lb); if (l && l.textContent) return l.textContent.trim(); }
      if (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA') {
        return (e.placeholder || e.name || '').trim();
      }
      return ((e.innerText || e.textContent || '').trim()).slice(0, 80);
    }
    // Nearest visible field label (for type steps' durable fieldLabel anchor):
    // a <label for=ctrl>, an ancestor <label>, or a preceding label-ish node.
    function fieldTextFor(c) {
      const norm = s => (s||'').replace(/\\s+/g,' ').trim();
      if (c.id) {
        const fl = document.querySelector('label[for="'+CSS.escape(c.id)+'"]');
        if (fl && fl.textContent) return norm(fl.textContent).slice(0, 80);
      }
      const wrap = c.closest('label');
      if (wrap && wrap.textContent) return norm(wrap.textContent).slice(0, 80);
      let scope = c.parentElement;
      for (let up = 0; up < 3 && scope; up++, scope = scope.parentElement) {
        const lab = scope.querySelector('label');
        if (lab && lab.textContent) { const t = norm(lab.textContent); if (t) return t.slice(0, 80); }
      }
      return '';
    }
    ctrl.setAttribute('data-holo-ref', TAG);
    return { ok: true, role: roleOf(ctrl), name: nameOf(ctrl), fieldText: fieldTextFor(ctrl) };
  })()`;
}

/**
 * FINAL self-heal tier — vision grounding against a BROWSER screenshot.
 *
 * Fires ONLY when every deterministic resolver (recorded ref → refLabel heal
 * → {{param}} → fieldLabel) has missed (the recipe-is-the-cache contract:
 * deterministic steps never pay for vision). One ground call per step, bounded
 * to ~8s. On a hit it tags the located element, runs the action through it,
 * then PERSISTS a durable locator (role+name, plus fieldLabel for type steps)
 * back into the step + flips ctx.dirty — so the NEXT playback resolves
 * deterministically with no vision. Returns true when it healed + acted, null
 * otherwise (caller fall-stops via the existing throw).
 *
 * `nameOverride` is the substituted run-time name for the parameterized
 * ({{token}}) branch, so a data-driven click target can still be vision-found.
 */
async function tryVisionHeal(
  step: RecordedStep,
  ctx: ReplayCtx,
  run: (ref: string) => Promise<void>,
  nameOverride?: string,
): Promise<boolean> {
  // (1) Gate: need a provider AND a browser that can screenshot + evaluate.
  if (!ctx.provider) return false;
  const browser = ctx.browser;
  if (!browser || !browser.screenshot || !browser.evaluate) return false;
  // (4) FILE-INPUT steps SKIP — the native OS picker can't be vision-driven;
  // the document-order healRef fix already handles FB's two file-inputs.
  if (
    step.executed.type === "browser_set_input_files" ||
    step.refLabel?.role === "file-input"
  ) {
    return false;
  }

  const intent = buildVisionIntent(step, ctx.params, nameOverride);

  try {
    const shot = await browser.screenshot();
    if (!shot || !shot.pngB64 || shot.width <= 0 || shot.height <= 0) {
      return false;
    }
    // (5) ONE ground call, bounded — api.hcompany.ai can stall 35-108s; a
    // Promise.race timeout keeps a stalled ground inside the ≤10s/step budget.
    const ac = new AbortController();
    const GROUND_TIMEOUT_MS = 8000;
    const timer = setTimeout(() => ac.abort(), GROUND_TIMEOUT_MS);
    let r: { x: number; y: number; error?: string } | null = null;
    try {
      r = await Promise.race([
        ctx.provider.ground({
          instruction: intent,
          screenshotB64: shot.pngB64,
          screen: [shot.width, shot.height],
          signal: ac.signal,
        }),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), GROUND_TIMEOUT_MS + 200),
        ),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (!r || r.error) return false;

    // (3) Scale grounded DEVICE-px coords → CSS px for elementFromPoint.
    let innerW = shot.width;
    try {
      const iw = Number(await browser.evaluate("window.innerWidth"));
      if (Number.isFinite(iw) && iw > 0) innerW = iw;
    } catch {
      /* keep device-dim fallback (scale=1) */
    }
    const css = visionCoordsToCss(r.x, r.y, shot.width, innerW);
    if (!css) return false; // (guard) bad dims/scale → never click 0,0

    // Tag the element at the grounded point + read back a durable locator.
    let loc: VisionLocator;
    try {
      loc = (await browser.evaluate(
        visionTagScript(css.cssX, css.cssY),
      )) as VisionLocator;
    } catch {
      return false;
    }
    // (2)+(3) elementFromPoint must resolve to a REAL actionable control.
    if (!loc || loc.ok !== true) return false;

    // Act through the tagged element via the SAME run callback.
    await run(VISION_REF);

    // (persist) Write a durable locator back so the next replay is
    // deterministic. Mirror persistDrift's dirty/driftCount machinery.
    const role = (loc.role ?? "").trim();
    const name = (loc.name ?? "").trim();
    if (role && name) {
      step.refLabel = { role, name };
    }
    if (step.executed.type === "browser_type") {
      const fieldText = (loc.fieldText ?? "").trim();
      if (fieldText) {
        (step.executed.payload as Record<string, unknown>).fieldLabel = fieldText;
      }
    }
    ctx.dirty = true;
    ctx.driftCount = (ctx.driftCount ?? 0) + 1;
    console.log(
      `[replay] vision-healed step (${step.executed.type}) via "${intent}" → ` +
        `${role || "?"} "${name || "?"}"; persisted durable locator`,
    );
    return true;
  } catch {
    // Any failure (screenshot, evaluate, run on the tagged ref) → fall
    // through to the caller's existing throw. Never hang, never loop.
    return false;
  }
}

async function withHealedRef(
  step: RecordedStep,
  ctx: ReplayCtx,
  run: (ref: string) => Promise<void>,
): Promise<void> {
  const p = step.executed.payload as Record<string, unknown>;
  const recorded = String(p.ref);
  // PARAMETERIZED click target: when the step's refLabel name carries a
  // {{token}}, the recorded ref points at the item we recorded against (e.g.
  // the "Used - Good" option, or "Delete listing <some title>") — useless for a
  // different run. Resolve by the SUBSTITUTED run-time name instead. This is the
  // unlock for select_option({{condition}}) / delete({{title}}) — click targets
  // become data-driven, not just typed text.
  if (step.refLabel && /\{\{/.test(step.refLabel.name) && ctx.params) {
    const wantName = applyParams(step.refLabel.name, ctx.params);
    const ref = await resolveByLabel(ctx, step.refLabel.role, wantName);
    if (ref) {
      await run(ref);
      return;
    }
    // Vision last-resort for data-driven targets: ground the SUBSTITUTED name.
    if (await tryVisionHeal(step, ctx, run, wantName)) return;
    throw new Error(
      `parameterized target not found: ${step.refLabel.role} "${wantName}" ` +
        `(template "${step.refLabel.name}"). Re-record or check the param value.`,
    );
  }
  // Persist accessible-name drift back into the step so the next replay is
  // exact and the recipe self-heals permanently (a platform renamed the
  // element; we caught it via uniqueness, now we remember the new name).
  const persistDrift = (m: HealMatch): void => {
    if (step.refLabel && m.currentLabel.name !== step.refLabel.name) {
      step.refLabel = { role: m.currentLabel.role, name: m.currentLabel.name };
      ctx.dirty = true;
      ctx.driftCount = (ctx.driftCount ?? 0) + 1;
    }
  };
  // After the first heal, recorded refs point into a RENUMBERED DOM —
  // a stale number usually still exists, bound to a different element,
  // so running it would silently act on the wrong target. Labeled steps
  // re-resolve; unlabeled/unmatched steps FAIL-STOP (the pre-heal
  // behavior for a stale ref was a loud locator timeout — keep that
  // contract rather than degrade to silent wrong-element actions).
  // Last-resort resolver: locate the control by its human field label via the
  // DOM (e.g. fill the input next to the "Price" label). Closes the gap where
  // the aria-name is empty/duplicated so refLabel healing can't disambiguate.
  const fieldLabel = typeof p.fieldLabel === "string" ? p.fieldLabel : "";
  const tryFieldLabel = async (): Promise<boolean> => {
    if (!fieldLabel) return false;
    const ref = await resolveByFieldLabel(ctx, fieldLabel);
    if (!ref) return false;
    console.log(`[replay] resolved step by field label "${fieldLabel}" → tagged ${ref}`);
    await run(ref);
    return true;
  };

  if (ctx.healedOnce) {
    const healed = await healRef(step, ctx);
    if (healed) {
      persistDrift(healed);
      await run(healed.ref);
      return;
    }
    if (await tryFieldLabel()) return;
    // FINAL tier: vision self-heal against a browser screenshot.
    if (await tryVisionHeal(step, ctx, run)) return;
    throw new Error(
      `ref ${recorded} unreliable: a prior heal renumbered the page's refs and ` +
        `this step has ${step.refLabel ? `no uniquely-matching refLabel (${step.refLabel.role} "${step.refLabel.name}")` : "no refLabel"}` +
        `${fieldLabel ? ` and no control matched field label "${fieldLabel}"` : ""}. ` +
        `Re-record the flow or hand-edit the .recipe.ts.`,
    );
  }
  try {
    await run(recorded);
  } catch (e) {
    const healed = await healRef(step, ctx);
    if (healed && healed.ref !== recorded) {
      const drift =
        step.refLabel && healed.currentLabel.name !== step.refLabel.name
          ? ` (name drifted → "${healed.currentLabel.name}", persisting)`
          : "";
      console.log(
        `[replay] ref ${recorded} stale — healed to ${healed.ref} via refLabel ` +
          `${step.refLabel!.role} "${step.refLabel!.name}"${drift}`,
      );
      persistDrift(healed);
      await run(healed.ref);
      return;
    }
    if (await tryFieldLabel()) return;
    // FINAL tier: vision self-heal against a browser screenshot.
    if (await tryVisionHeal(step, ctx, run)) return;
    throw e;
  }
}

async function replayStep(step: RecordedStep, ctx: ReplayCtx): Promise<void> {
  const { executed } = step;
  const p = executed.payload as Record<string, unknown>;
  switch (executed.type) {
    case "browser_navigate":
      if (!ctx.browser) throw new Error("Chrome not attached for browser_navigate");
      await ctx.browser.navigate(applyParams(String(p.url), ctx.params));
      return;
    case "browser_click":
      if (!ctx.browser) throw new Error("Chrome not attached for browser_click");
      await withHealedRef(step, ctx, (ref) => ctx.browser!.click(ref));
      return;
    case "browser_type":
      if (!ctx.browser) throw new Error("Chrome not attached for browser_type");
      await withHealedRef(step, ctx, (ref) =>
        ctx.browser!.type(ref, applyParams(String(p.text ?? ""), ctx.params), { submit: !!p.submit }),
      );
      return;
    case "browser_set_input_files":
      if (!ctx.browser)
        throw new Error("Chrome not attached for browser_set_input_files");
      await withHealedRef(step, ctx, (ref) =>
        ctx.browser!.setInputFiles(ref, resolveFilePaths(p.paths, ctx.params)),
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
      await withHealedRef(step, ctx, (ref) =>
        ctx.browser!.scrollElement(
          ref,
          (p.dir as "up" | "down") ?? "down",
          typeof p.amount === "number" ? (p.amount as number) : undefined,
        ),
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
    case "open_app": {
      const app = String(p.app ?? "");
      if (!app) throw new Error("open_app step missing app name");
      await screenLow.raiseMacApp(app);
      // Launched app needs draw time before the next step's grounding.
      await screenLow.sleep(2000);
      return;
    }
    case "note":
      // Planner working-memory entry — no screen effect, nothing to
      // replay. Kept in recordings for human readability.
      return;
    case "hover": {
      const hx = typeof p.x === "number" ? (p.x as number) : null;
      const hy = typeof p.y === "number" ? (p.y as number) : null;
      if (hx === null || hy === null) throw new Error("hover step missing x/y");
      await screenLow.hover(hx, hy);
      return;
    }
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
