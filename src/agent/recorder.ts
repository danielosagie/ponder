/**
 * Ponder recipe recorder — captures every browser+desktop action into a
 * structured manifest AND a copy-pasteable Playwright script.
 *
 * A **recipe** is Ponder's name for a recording. ("session" is a
 * Playwriter execution-sandbox term, kept out of this layer to avoid
 * the collision with anorha's `generate_recipe` / `run_recipe`
 * vocabulary; auto-migration of the legacy `~/.ponder/sessions/` and
 * `~/.holo3-agent/sessions/` dirs runs once on first read/write.)
 *
 * Two integration points:
 *
 *   • **Process-wide trace buffer** (the new path): every MCP tool that
 *     mutates the browser or desktop appends to a single rolling buffer
 *     via `recordAction({ type, payload, intent?, refLabel? })`. The
 *     `ponder_recipe_save` MCP tool snapshots the buffer (or a slice)
 *     into a saved recipe, so direct `browser_click` / `browser_type`
 *     / `screen_*` invocations are recorded the same as `agent_do`'s
 *     internal events. This is what makes Ponder feel like a black-box
 *     recorder regardless of which tool kicked off the work.
 *
 *   • **Per-flow RecipeRecorder** (the legacy path): `agent_do` creates
 *     a `RecipeRecorder` and threads it through `runTask` so it can
 *     observe history entries + AX snapshots alongside actions. The
 *     recorder ALSO forwards each event into the trace buffer, so the
 *     two paths stay in sync.
 *
 * Bridge path: the Electron Holo3 app's `:7900/agent_do` returns a
 * `transcript: string[]`; `recordFromBridgeTranscript()` parses those
 * lines back into a RecordedRecipe shape so downstream replay/codegen
 * tooling doesn't care which path produced it.
 *
 * Storage layout: `~/.ponder/recipes/<ISO-timestamp>-<task-slug>.{json,recipe.ts}`
 * — picked up by `ponder_recipe_list` / `ponder_recipe_show` /
 * `ponder_recipe_replay` MCP tools.
 *
 * Backwards-compatible public surface: the legacy `createSessionRecorder`,
 * `saveSession`, `loadSession`, etc. names are re-exported as aliases
 * pointing at the recipe-named functions, so existing call sites keep
 * compiling during the rename rollout.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import type { BrowserSnapshot } from "./browser/types";

// ── Shape ────────────────────────────────────────────────────────────

export interface RecordedStep {
  /** Milliseconds since the recipe started. Sorts chronologically. */
  t: number;
  /**
   * Raw natural-language action the brain emitted, e.g.
   *   "click on the Open button in the file picker"
   *   "browser.click e12"
   *   "type \"bulbasaur\""
   * Pulled from onHistory. Used as a code comment in the generated
   * Playwright script so the user sees the intent next to the
   * mechanical call.
   */
  intent?: string;
  /**
   * Structured action emitted by executeAction. One of the types in
   * src/agent/loop.ts → executeAction (browser_click, browser_type,
   * browser_navigate, browser_scroll_page, browser_set_input_files,
   * click, double_click, triple_click, right_click, drag, type, key,
   * scroll, wait).
   */
  executed: {
    type: string;
    payload: Record<string, unknown>;
  };
  /** Tab URL at the time of the step (snapshot URL if a browser
   *  snapshot was captured for this step). Best-effort. */
  url?: string;
  /**
   * For ref-based browser actions: the resolved role + name from the
   * AX snapshot at the time the action was emitted. Makes the
   * Playwright script reusable — raw `eN` refs are per-snapshot, but
   * page.getByRole('button', { name: 'Search' }) survives reloads.
   */
  refLabel?: { role: string; name: string };
  /** Optional consumer name for trace entries written through the HTTP
   *  bridge. Lets `ponder_recipe_save` filter or group by who drove
   *  the call (anorha vs the user, etc.). Trace-buffer-only field. */
  consumer?: string;
}

export interface RecordedRecipe {
  /** Original task text. */
  task: string;
  /** ISO timestamp when the recipe started. */
  startedAt: string;
  /** Wall-clock duration in ms. */
  durationMs?: number;
  /** Terminal outcome. */
  outcome?: "done" | "cancelled" | "exhausted" | "infeasible" | "error";
  /** Best-effort error string when outcome="error". */
  error?: string;
  /** Provider that ran the loop, for the script-header preamble. */
  provider?: string;
  /** Surface declared by the caller (file-picker, finder, …). */
  surface?: string;
  /** Every recorded step in chronological order. */
  steps: RecordedStep[];
}

/** Backwards-compatible alias kept so existing imports of
 *  `RecordedSession` continue to compile during the recipe rollout. */
export type RecordedSession = RecordedRecipe;

// ── Process-wide trace buffer ────────────────────────────────────────
//
// Every browser_* / screen_* MCP tool — and every `agent_do` event —
// flows through `recordAction`. The buffer is unbounded but trimmed at
// a soft cap (TRACE_SOFT_CAP) so a long-running session can't OOM.
// `ponder_recipe_save` snapshots the buffer into a saved recipe.
//
// A small event emitter lets the Electron tray / future UI subscribe
// to live trace events.

const TRACE_SOFT_CAP = 10_000;
const traceBuffer: RecordedStep[] = [];
let traceStartedAt = Date.now();
let traceTask = "ponder-trace";
let traceProvider: string | undefined;
let traceSurface: string | undefined;
const traceEvents = new EventEmitter();
traceEvents.setMaxListeners(50);

export interface TraceEntry {
  type: string;
  payload: Record<string, unknown>;
  intent?: string;
  refLabel?: { role: string; name: string };
  url?: string;
  consumer?: string;
  /**
   * Absolute epoch ms at which the action ACTUALLY executed. Defaults
   * to Date.now(). Pass it when recording after-the-fact (the bridge
   * transcript mirror) so steps keep their real inter-step deltas —
   * recorded-pacing replay reads them; a synchronous mirror loop would
   * otherwise collapse every gap to ~0.
   */
  atEpochMs?: number;
}

/**
 * Append an action to the process-wide trace buffer.
 *
 * Every MCP browser_* / screen_* handler should call this once it has
 * confirmed the underlying action succeeded. Best-effort — never
 * throws (a failed append must not break a tool call). Returns the
 * appended step so callers can pull `t` if they want it.
 */
export function recordAction(entry: TraceEntry): RecordedStep {
  const step: RecordedStep = {
    t: Math.max(0, (entry.atEpochMs ?? Date.now()) - traceStartedAt),
    executed: {
      type: entry.type,
      payload: { ...entry.payload },
    },
  };
  if (entry.intent) step.intent = entry.intent;
  if (entry.refLabel) step.refLabel = entry.refLabel;
  if (entry.url) step.url = entry.url;
  if (entry.consumer) step.consumer = entry.consumer;
  traceBuffer.push(step);
  if (traceBuffer.length > TRACE_SOFT_CAP) {
    traceBuffer.splice(0, traceBuffer.length - TRACE_SOFT_CAP);
  }
  try {
    traceEvents.emit("step", step);
  } catch {
    /* swallow — emitter failures must not break a tool call */
  }
  return step;
}

/** Snapshot the trace buffer (optionally from a starting index). */
export function snapshotTrace(fromIndex?: number): RecordedStep[] {
  const start = Math.max(0, fromIndex ?? 0);
  return traceBuffer.slice(start).map((s) => ({
    ...s,
    executed: { ...s.executed, payload: { ...s.executed.payload } },
  }));
}

/** Current length of the trace buffer. Useful for callers that want
 *  to mark a "fromIndex" before kicking off a flow. */
export function traceLength(): number {
  return traceBuffer.length;
}

/** Reset the trace buffer + start a new logical recording window. */
export function startNewTrace(opts: {
  task?: string;
  provider?: string;
  surface?: string;
} = {}): void {
  traceBuffer.length = 0;
  traceStartedAt = Date.now();
  traceTask = opts.task ?? "ponder-trace";
  if (opts.provider !== undefined) traceProvider = opts.provider;
  if (opts.surface !== undefined) traceSurface = opts.surface;
}

/** Read-only view of the current trace metadata. */
export function getTraceMeta(): {
  task: string;
  startedAt: string;
  provider?: string;
  surface?: string;
  length: number;
} {
  return {
    task: traceTask,
    startedAt: new Date(traceStartedAt).toISOString(),
    ...(traceProvider ? { provider: traceProvider } : {}),
    ...(traceSurface ? { surface: traceSurface } : {}),
    length: traceBuffer.length,
  };
}

/** Subscribe to live trace events. */
export function onTraceStep(
  listener: (step: RecordedStep) => void,
): () => void {
  traceEvents.on("step", listener);
  return () => traceEvents.off("step", listener);
}

/** Build a RecordedRecipe from a slice of the trace buffer. */
export function buildRecipeFromTrace(opts: {
  task?: string;
  fromIndex?: number;
  provider?: string;
  surface?: string;
  outcome?: "done" | "cancelled" | "exhausted" | "infeasible" | "error";
  error?: string;
}): RecordedRecipe {
  const steps = snapshotTrace(opts.fromIndex);
  const startTs =
    steps.length > 0
      ? new Date(traceStartedAt + steps[0]!.t).toISOString()
      : new Date(traceStartedAt).toISOString();
  return {
    task: opts.task ?? traceTask,
    startedAt: startTs,
    durationMs:
      steps.length > 0 ? steps[steps.length - 1]!.t - (steps[0]?.t ?? 0) : 0,
    steps,
    ...(opts.outcome ? { outcome: opts.outcome } : {}),
    ...(opts.error ? { error: opts.error } : {}),
    ...(opts.provider ?? traceProvider
      ? { provider: opts.provider ?? traceProvider }
      : {}),
    ...(opts.surface ?? traceSurface
      ? { surface: opts.surface ?? traceSurface }
      : {}),
  };
}

// ── Per-flow RecipeRecorder ─────────────────────────────────────────
//
// Used by `agent_do` so it can observe history + AX snapshots alongside
// the structured actions. Every action this recorder consumes is ALSO
// forwarded into the process-wide trace buffer, so a single flow ends
// up in both places (the per-flow recipe save + the rolling trace).

export interface RecipeRecorder {
  /** Append an action emitted via AgentEvents.onAction. */
  onAction(action: { type: string; payload: Record<string, unknown> }): void;
  /** Track the natural-language history line for the NEXT onAction. */
  onHistory(actionText: string): void;
  /** Latch the most recent browser snapshot for url/refLabel resolution. */
  onBrowserSnapshot(snap: BrowserSnapshot): void;
  /** Finalize: stamp outcome + duration. */
  setOutcome(
    outcome: "done" | "cancelled" | "exhausted" | "infeasible" | "error",
    error?: string,
  ): void;
  /** The raw recipe record. */
  getRecipe(): RecordedRecipe;
  /** Render the editable, runnable `.recipe.ts` source. */
  toRecipeScript(): string;
  /** Backwards-compatible alias for `getRecipe()`. */
  getSession(): RecordedRecipe;
  /** Backwards-compatible alias for `toRecipeScript()`. */
  toSessionScript(): string;
}

/** Backwards-compatible alias used by callers that still import
 *  `SessionRecorder`. */
export type SessionRecorder = RecipeRecorder;

interface RecorderInit {
  task: string;
  provider?: string;
  surface?: string;
}

export function createRecipeRecorder(init: RecorderInit): RecipeRecorder {
  const startedAtMs = Date.now();
  const recipe: RecordedRecipe = {
    task: init.task,
    startedAt: new Date(startedAtMs).toISOString(),
    steps: [],
    ...(init.provider ? { provider: init.provider } : {}),
    ...(init.surface ? { surface: init.surface } : {}),
  };
  let pendingIntent: string | undefined;
  let lastSnapshot: BrowserSnapshot | undefined;
  /** Map from refId (e.g. "e12") → its AX-line label ({role, name}). */
  let refIndex = new Map<string, { role: string; name: string }>();

  return {
    onHistory(actionText: string): void {
      pendingIntent = actionText;
    },
    onBrowserSnapshot(snap: BrowserSnapshot): void {
      lastSnapshot = snap;
      refIndex = parseAxRefs(snap.ax);
    },
    onAction(action): void {
      const ref = typeof action.payload?.ref === "string"
        ? (action.payload.ref as string)
        : undefined;
      const refLabel = ref ? refIndex.get(ref) : undefined;
      const step: RecordedStep = {
        t: Date.now() - startedAtMs,
        executed: { type: action.type, payload: { ...action.payload } },
      };
      if (pendingIntent) step.intent = pendingIntent;
      if (lastSnapshot?.url) step.url = lastSnapshot.url;
      if (refLabel) step.refLabel = refLabel;
      recipe.steps.push(step);
      // Forward into the process-wide trace buffer so direct MCP
      // browser_* calls and agent_do events live in the same rolling
      // buffer that `ponder_recipe_save` snapshots.
      recordAction({
        type: action.type,
        payload: action.payload,
        ...(pendingIntent ? { intent: pendingIntent } : {}),
        ...(refLabel ? { refLabel } : {}),
        ...(lastSnapshot?.url ? { url: lastSnapshot.url } : {}),
      });
      pendingIntent = undefined;
    },
    setOutcome(outcome, error): void {
      recipe.outcome = outcome;
      recipe.durationMs = Date.now() - startedAtMs;
      if (error) recipe.error = error;
    },
    getRecipe(): RecordedRecipe {
      return recipe;
    },
    toRecipeScript(): string {
      return renderRecipeScript(recipe);
    },
    getSession(): RecordedRecipe {
      return recipe;
    },
    toSessionScript(): string {
      return renderRecipeScript(recipe);
    },
  };
}

/** Backwards-compatible alias for callers still using `createSessionRecorder`. */
export const createSessionRecorder = createRecipeRecorder;

// ── Bridge transcript → RecordedRecipe ───────────────────────────────

/**
 * Reconstruct a RecordedRecipe from the Electron bridge's
 * `transcript: string[]` (each line `[t=X.Ys] kind: payload-or-text`).
 *
 * The bridge doesn't currently expose onHistory / onBrowserSnapshot
 * separately. Intent and refLabel are best-effort.
 */
export function recordFromBridgeTranscript(
  task: string,
  transcript: string[],
  opts: {
    outcome?: "done" | "cancelled" | "exhausted" | "infeasible" | "error";
    durationMs?: number;
    finalUrl?: string;
    provider?: string;
    surface?: string;
    error?: string;
  } = {},
): RecordedRecipe {
  const recipe: RecordedRecipe = {
    task,
    startedAt: new Date().toISOString(),
    steps: [],
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.surface ? { surface: opts.surface } : {}),
  };
  let pendingIntent: string | undefined;
  let pendingUrl: string | undefined = opts.finalUrl;
  for (const line of transcript) {
    const m = line.match(/^\[t=(\d+(?:\.\d+)?)s\]\s+(\w+):\s*(.*)$/);
    if (!m) continue;
    const t = Math.round(parseFloat(m[1]!) * 1000);
    const kind = m[2]!;
    const rest = m[3]!;
    if (kind === "thought") {
      pendingIntent = rest;
      continue;
    }
    if (kind !== "action") continue;
    const am = rest.match(/^(\w+)\s*(\{.*)?$/);
    if (!am) continue;
    const type = am[1]!;
    let payload: Record<string, unknown> = {};
    if (am[2]) {
      try {
        payload = JSON.parse(am[2]) as Record<string, unknown>;
      } catch {
        payload = { _truncated: true };
      }
    }
    const step: RecordedStep = { t, executed: { type, payload } };
    if (pendingIntent) {
      step.intent = pendingIntent;
      pendingIntent = undefined;
    }
    if (pendingUrl) step.url = pendingUrl;
    if (type === "browser_navigate" && typeof payload.url === "string") {
      pendingUrl = payload.url;
    }
    recipe.steps.push(step);
  }
  if (opts.outcome) recipe.outcome = opts.outcome;
  if (opts.durationMs !== undefined) recipe.durationMs = opts.durationMs;
  if (opts.error) recipe.error = opts.error;
  return recipe;
}

/**
 * Build a recipe from a persisted Convex session's steps (History → "Save as
 * automation"). Convex steps don't carry refLabels (only the live recorder
 * captures role+name), so the resulting recipe replays by url + raw action;
 * reground:true still re-grounds via vision. Lower fidelity than saving the
 * last *live* run, but lets any past run become a replayable automation.
 */
export function recipeFromConvexSteps(
  task: string,
  steps: Array<{
    kind: string;
    text?: string;
    action?: { type: string; payload?: unknown };
    coords?: { x: number; y: number };
    createdAt?: number;
  }>,
  opts: { provider?: string; outcome?: RecordedRecipe["outcome"]; durationMs?: number } = {},
): RecordedRecipe {
  const recipe: RecordedRecipe = {
    task,
    startedAt: new Date().toISOString(),
    steps: [],
    ...(opts.provider ? { provider: opts.provider } : {}),
  };
  const t0 = steps.length && steps[0]?.createdAt ? steps[0].createdAt! : 0;
  let pendingIntent: string | undefined;
  let pendingUrl: string | undefined;
  for (const s of steps) {
    if (s.kind === "thought") {
      if (s.text) pendingIntent = s.text;
      continue;
    }
    if (s.kind !== "action" || !s.action) continue;
    const type = s.action.type;
    const payload = (s.action.payload ?? {}) as Record<string, unknown>;
    const t = s.createdAt && t0 ? Math.max(0, s.createdAt - t0) : 0;
    const step: RecordedStep = { t, executed: { type, payload } };
    if (pendingIntent) {
      step.intent = pendingIntent;
      pendingIntent = undefined;
    }
    if (pendingUrl) step.url = pendingUrl;
    if (type === "browser_navigate" && typeof payload.url === "string") {
      pendingUrl = payload.url;
    }
    recipe.steps.push(step);
  }
  if (opts.outcome) recipe.outcome = opts.outcome;
  if (opts.durationMs !== undefined) recipe.durationMs = opts.durationMs;
  return recipe;
}

// ── Recipe codegen (raw Playwright in run() body) ────────────────────
//
// The recipe file is just `defineRecipe({ task, run })` — a thin shell.
// The body inside `run({ page, screen })` is RAW Playwright that drops
// into any Playwright project. No Ponder-specific wrappers inside
// (other than `screen.*` for OS-level work that Playwright doesn't
// cover). That matches the Playwriter skill's selector style and is
// the most portable artifact we can produce.

/**
 * Render the editable, runnable `.recipe.ts` file for a recipe.
 */
export function renderRecipeScript(recipe: RecordedRecipe): string {
  const header = renderHeader(recipe);
  const body = recipe.steps.map((step) => renderStep(step)).join("\n");
  const usesScreen = recipe.steps.some((s) =>
    /^(click|double_click|triple_click|right_click|drag|wait|type|key|scroll)$/.test(
      s.executed.type,
    ),
  );
  const runArgs = usesScreen ? "{ page, screen }" : "{ page }";
  return `${header}
//
// Edit this file freely — it's the one place to refine the recording.
// The .json sibling is regenerated from these steps on \`ponder build\`.
//
//   ponder run     ${makeRecipeId(recipe)}    # replay this recipe
//   ponder open    ${makeRecipeId(recipe)}    # edit in \$EDITOR
//   npx tsx        <this-file>                # run directly (no CLI)
//
// Chrome bridge: Playwriter (https://playwriter.dev). The Ponder SDK
// connects to your REAL Chrome — same cookies, same logins, same
// extensions — so recorded selectors keep working.

import { defineRecipe } from "ponder";

export default defineRecipe({
  task: ${json(oneLine(recipe.task))},
  async run(${runArgs}) {
${indent(body, 4)}
  },
});
`;
}

/** Backwards-compatible alias for callers still using `renderSessionScript`. */
export const renderSessionScript = renderRecipeScript;

function renderHeader(recipe: RecordedRecipe): string {
  const lines: string[] = [];
  lines.push("/**");
  lines.push(" * Ponder recipe — generated by recording.");
  lines.push(" *");
  lines.push(` * Task:     ${oneLine(recipe.task)}`);
  lines.push(` * Started:  ${recipe.startedAt}`);
  if (recipe.outcome) {
    lines.push(
      ` * Outcome:  ${recipe.outcome}${
        recipe.error ? ` — ${oneLine(recipe.error)}` : ""
      }`,
    );
  }
  if (recipe.durationMs !== undefined) {
    lines.push(` * Duration: ${(recipe.durationMs / 1000).toFixed(1)}s`);
  }
  if (recipe.provider) lines.push(` * Provider: ${recipe.provider}`);
  if (recipe.surface) lines.push(` * Surface:  ${recipe.surface}`);
  lines.push(` * Steps:    ${recipe.steps.length}`);
  lines.push(" *");
  lines.push(" * The body of run() is raw Playwright — copy any of it");
  lines.push(" * straight into a Playwright project or test suite.");
  lines.push(" *   • In-page actions use page.getByRole({ role, name })");
  lines.push(" *     when the snapshot resolved the element.");
  lines.push(" *   • OS-level actions call screen.* helpers — they");
  lines.push(" *     re-ground via the vision model against a fresh");
  lines.push(" *     screenshot, so they survive across runs.");
  lines.push(" */");
  return lines.join("\n");
}

function renderStep(step: RecordedStep): string {
  const { executed } = step;
  const p = executed.payload;
  const intentComment = step.intent
    ? `// ${oneLine(step.intent)}`
    : `// ${executed.type}`;
  const tComment = `  // (+${(step.t / 1000).toFixed(1)}s)`;
  const lead = intentComment + tComment;

  switch (executed.type) {
    case "browser_navigate":
      return `${lead}\nawait page.goto(${json(p.url)});`;
    case "browser_click":
      return `${lead}\n${renderRefAction(step, "click")}`;
    case "browser_type": {
      const lines: string[] = [lead];
      lines.push(renderRefAction(step, "fill", String(p.text ?? "")));
      if (p.submit) {
        lines.push(renderRefAction(step, "press", "Enter"));
      }
      return lines.join("\n");
    }
    case "browser_set_input_files":
      return `${lead}\n${renderRefAction(step, "setInputFiles", p.paths)}`;
    case "browser_scroll_page": {
      const dir = String(p.dir ?? "down");
      const amount = typeof p.amount === "number" ? p.amount : 800;
      const dy = dir === "up" ? -amount : amount;
      return `${lead}\nawait page.mouse.wheel(0, ${dy});`;
    }
    case "browser_scroll_element": {
      const dir = String(p.dir ?? "down");
      const amount = typeof p.amount === "number" ? p.amount : 600;
      const dy = dir === "up" ? -amount : amount;
      const sel = refSelector(step);
      return `${lead}\nawait page.locator(${json(sel)}).hover();\nawait page.mouse.wheel(0, ${dy});`;
    }
    case "browser_read": {
      const target = step.executed.payload.ref
        ? `await page.locator(${json(refSelector(step))}).innerText()`
        : `await page.locator("body").innerText()`;
      return `${lead}\nconst _read_${step.t} = ${target};`;
    }
    case "scroll": {
      const dir = String(p.direction ?? "down");
      const amount = typeof p.amount === "number" ? p.amount : 50;
      return `${lead}\nawait screen.scroll(${json(dir)}, ${amount});`;
    }
    case "wait":
      return `${lead}\nawait page.waitForTimeout(${Number(p.ms ?? 1000)});`;
    case "open_app":
      return `${lead}\nawait screen.openApp(${json(p.app)});`;
    case "note":
      // Planner working memory — replay no-op, kept for readability.
      return `${lead}\n// note: ${oneLine(String(p.text ?? ""))}`;
    case "hover":
      return `${lead}\nawait screen.hover(${Number(p.x ?? 0)}, ${Number(p.y ?? 0)});`;
    case "type":
      return (
        `${lead}\nawait screen.type(${json(p.text)}${
          p.thenPress ? `, { thenPress: ${json(p.thenPress)} }` : ""
        });`
      );
    case "key":
      return `${lead}\nawait screen.key(${json(p.combo)});`;
    case "click":
    case "double_click":
    case "triple_click":
    case "right_click": {
      const mode =
        executed.type === "double_click"
          ? "double"
          : executed.type === "triple_click"
            ? "triple"
            : executed.type === "right_click"
              ? "right"
              : "single";
      const target = step.intent ? json(oneLine(step.intent)) : "undefined";
      const fallback =
        typeof p.x === "number" && typeof p.y === "number"
          ? `, { fallback: { x: ${p.x}, y: ${p.y} } }`
          : "";
      const modeArg = mode === "single" ? "" : `, { mode: ${json(mode)} }`;
      const opts =
        modeArg && fallback
          ? `, { mode: ${json(mode)}, fallback: { x: ${p.x}, y: ${p.y} } }`
          : (modeArg || fallback);
      return `${lead}\nawait screen.click(${target}${opts});`;
    }
    case "drag": {
      const from = (p.from as { x: number; y: number }) ?? null;
      const to = (p.to as { x: number; y: number }) ?? null;
      return `${lead}\nawait screen.drag({ from: { x: ${from?.x ?? 0}, y: ${from?.y ?? 0} }, to: { x: ${to?.x ?? 0}, y: ${to?.y ?? 0} } });`;
    }
    default:
      return (
        `${lead}\n// Unsupported action type for codegen: ${executed.type}\n` +
        `// Payload: ${json(p)}`
      );
  }
}

/**
 * Render `await page.<getter>.<method>(args)` for a ref-based action.
 * Uses role+name when refLabel is present; falls back to a stale-but-
 * usable `[data-holo-ref="eN"]` selector otherwise.
 */
function renderRefAction(
  step: RecordedStep,
  method: "click" | "fill" | "press" | "setInputFiles",
  arg?: unknown,
): string {
  const refLabel = step.refLabel;
  const ref = step.executed.payload.ref as string | undefined;
  const argLiteral = arg === undefined ? "" : json(arg);
  if (refLabel) {
    const role = mapAxRoleToPlaywright(refLabel.role);
    const name = refLabel.name.trim();
    if (role && name) {
      return `await page.getByRole(${json(role)}, { name: ${json(truncateName(name))} }).${method}(${argLiteral});`;
    }
    if (name) {
      return `await page.getByText(${json(truncateName(name))}).${method}(${argLiteral});`;
    }
  }
  const sel = ref ? `[data-holo-ref="${ref}"]` : "/* ref missing */";
  return (
    `await page.locator(${json(sel)}).${method}(${argLiteral});  // FALLBACK: ` +
    `${ref ?? "?"} (no role+name captured — selector only resolves while Holo3 has just snapshotted)`
  );
}

function refSelector(step: RecordedStep): string {
  if (step.refLabel) {
    const role = mapAxRoleToPlaywright(step.refLabel.role);
    const name = step.refLabel.name.trim();
    if (role && name) {
      return `role=${role}[name=${JSON.stringify(truncateName(name))}]`;
    }
  }
  const ref = step.executed.payload.ref as string | undefined;
  return ref ? `[data-holo-ref="${ref}"]` : "body";
}

function mapAxRoleToPlaywright(role: string): string | null {
  switch (role) {
    case "button":
    case "link":
    case "checkbox":
    case "radio":
    case "menuitem":
    case "tab":
    case "combobox":
    case "option":
    case "switch":
    case "searchbox":
    case "textbox":
      return role;
    case "file-input":
      return "button";
    case "a":
      return "link";
    case "img":
      return "img";
    default:
      return null;
  }
}

// ── AX parsing helpers ───────────────────────────────────────────────

/** Exported for replay-time self-healing ref resolution (cli/sdk.ts):
 *  a stale [eN] ref is re-resolved against a fresh snapshot by matching
 *  the recorded role+name label. */
export function parseAxRefs(
  ax: string,
): Map<string, { role: string; name: string }> {
  const out = new Map<string, { role: string; name: string }>();
  for (const line of ax.split("\n")) {
    const m = line.match(/^\[(e\d+)\]\s+(\S+)(?:\s+"([^"]*)")?/);
    if (!m) continue;
    out.set(m[1]!, { role: m[2]!, name: m[3] ?? "" });
  }
  return out;
}

// ── Formatting helpers ───────────────────────────────────────────────

function json(v: unknown): string {
  return JSON.stringify(v);
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function indent(s: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return s
    .split("\n")
    .map((line) => (line ? pad + line : line))
    .join("\n");
}

function truncateName(name: string): string {
  if (name.length <= 80) return name;
  return name.slice(0, 80);
}

// ── Disk storage ─────────────────────────────────────────────────────

/**
 * Where recipe artifacts live. Canonical location is `~/.ponder/recipes/`.
 *
 * Migration: the first read/write after upgrade renames
 *   ~/.holo3-agent/sessions/   →   ~/.ponder/recipes/    (legacy holo3 era)
 *   ~/.ponder/sessions/        →   ~/.ponder/recipes/    (pre-rename era)
 * Idempotent: only runs when the new dir is empty / missing.
 */
export const RECIPES_DIR = path.join(os.homedir(), ".ponder", "recipes");
const LEGACY_SESSIONS_PONDER = path.join(
  os.homedir(),
  ".ponder",
  "sessions",
);
const LEGACY_SESSIONS_HOLO3 = path.join(
  os.homedir(),
  ".holo3-agent",
  "sessions",
);

/** Backwards-compatible alias for callers that imported `SESSIONS_DIR`. */
export const SESSIONS_DIR = RECIPES_DIR;

let _migrated = false;
function migrateLegacyDir(): void {
  if (_migrated) return;
  _migrated = true;
  // If the new dir already exists with content, leave everything alone.
  try {
    const entries = fs.readdirSync(RECIPES_DIR);
    if (entries.length > 0) return;
  } catch {
    /* new dir missing — fine */
  }
  // Try the .ponder/sessions/ → .ponder/recipes/ rename first (pre-rename
  // era). If that doesn't exist, fall through to the .holo3-agent/sessions/
  // legacy.
  for (const legacy of [LEGACY_SESSIONS_PONDER, LEGACY_SESSIONS_HOLO3]) {
    try {
      const stat = fs.statSync(legacy);
      if (!stat.isDirectory()) continue;
      fs.mkdirSync(path.dirname(RECIPES_DIR), { recursive: true });
      fs.renameSync(legacy, RECIPES_DIR);
      try {
        process.stderr.write(
          `[ponder] migrated recordings: ${legacy} → ${RECIPES_DIR}\n`,
        );
      } catch {
        /* ignore */
      }
      return;
    } catch {
      /* legacy dir missing — try next */
    }
  }
}

export interface SavedRecipePaths {
  /** Synthetic recipe id derived from the ISO timestamp + task slug. */
  id: string;
  /** Source-of-truth JSON manifest. */
  jsonPath: string;
  /** Editable, runnable .recipe.ts using `defineRecipe({...})`. */
  recipePath: string;
  /** Backwards-compatible alias for `recipePath`. */
  sessionPath: string;
}

/** Backwards-compatible alias for callers that imported `SavedSessionPaths`. */
export type SavedSessionPaths = SavedRecipePaths;

/**
 * Persist a recipe to disk. Writes TWO files per recipe:
 *   • <id>.json       — manifest (replay engine + codegen consume this)
 *   • <id>.recipe.ts  — editable defineRecipe({...}) wrapper around raw
 *                       Playwright body.
 *
 * Failures are non-fatal: caller gets null and proceeds.
 */
export async function saveRecipe(
  source: RecipeRecorder | RecordedRecipe,
): Promise<SavedRecipePaths | null> {
  const recipe: RecordedRecipe =
    "getRecipe" in source ? source.getRecipe() : source;
  migrateLegacyDir();
  try {
    await fsp.mkdir(RECIPES_DIR, { recursive: true });
    const id = makeRecipeId(recipe);
    const jsonPath = path.join(RECIPES_DIR, `${id}.json`);
    const recipePath = path.join(RECIPES_DIR, `${id}.recipe.ts`);
    await fsp.writeFile(jsonPath, JSON.stringify(recipe, null, 2), "utf-8");
    await fsp.writeFile(recipePath, renderRecipeScript(recipe), "utf-8");
    return { id, jsonPath, recipePath, sessionPath: recipePath };
  } catch {
    return null;
  }
}

/** Backwards-compatible alias for callers that still call `saveSession`. */
export const saveSession = saveRecipe;

function makeRecipeId(recipe: RecordedRecipe): string {
  const iso = recipe.startedAt.replace(/[:.]/g, "-").replace("T", "_").slice(
    0,
    19,
  );
  const slug = recipe.task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "task";
  return `${iso}-${slug}`;
}

/** Per-recipe listing entry. Metadata only — no `steps`. */
export interface RecipeListEntry {
  id: string;
  jsonPath: string;
  recipePath: string;
  /** Backwards-compatible alias for `recipePath`. */
  sessionPath: string;
  task: string;
  startedAt: string;
  outcome?: string;
  steps: number;
  durationMs?: number;
}

/** Backwards-compatible alias for callers that imported `SessionListEntry`. */
export type SessionListEntry = RecipeListEntry;

export async function listRecipes(): Promise<RecipeListEntry[]> {
  migrateLegacyDir();
  let files: string[];
  try {
    files = await fsp.readdir(RECIPES_DIR);
  } catch {
    return [];
  }
  const entries: RecipeListEntry[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const id = f.slice(0, -".json".length);
    const jsonPath = path.join(RECIPES_DIR, f);
    const recipePath = path.join(RECIPES_DIR, `${id}.recipe.ts`);
    try {
      const raw = await fsp.readFile(jsonPath, "utf-8");
      const recipe = JSON.parse(raw) as RecordedRecipe;
      entries.push({
        id,
        jsonPath,
        recipePath,
        sessionPath: recipePath,
        task: recipe.task,
        startedAt: recipe.startedAt,
        ...(recipe.outcome ? { outcome: recipe.outcome } : {}),
        steps: recipe.steps.length,
        ...(recipe.durationMs !== undefined
          ? { durationMs: recipe.durationMs }
          : {}),
      });
    } catch {
      /* skip malformed files silently */
    }
  }
  entries.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return entries;
}

/** Backwards-compatible alias. */
export const listSessions = listRecipes;

/** Load a recipe by id. Returns null when missing / malformed. */
export async function loadRecipe(id: string): Promise<RecordedRecipe | null> {
  migrateLegacyDir();
  const jsonPath = path.join(RECIPES_DIR, `${id}.json`);
  try {
    const raw = await fsp.readFile(jsonPath, "utf-8");
    return JSON.parse(raw) as RecordedRecipe;
  } catch {
    return null;
  }
}

/** Backwards-compatible alias. */
export const loadSession = loadRecipe;

/**
 * Find a saved recipe whose task EXACTLY matches (normalized: trimmed,
 * lowercased, whitespace-collapsed) the given task. The Run flow uses this to
 * auto-replay a recorded automation instead of re-running the agent. Returns
 * the most recent matching recipe that has steps and didn't end in error, or
 * null. EXACT match keeps it predictable — a fuzzy match could replay the
 * wrong flow for a slightly different request.
 */
export async function findRecipeByTask(
  task: string,
): Promise<{ id: string; recipe: RecordedRecipe } | null> {
  const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");
  const want = norm(task);
  if (!want) return null;
  const entries = await listRecipes(); // sorted most-recent-first
  for (const e of entries) {
    if (e.steps <= 0 || e.outcome === "error") continue;
    if (norm(e.task) !== want) continue;
    const recipe = await loadRecipe(e.id);
    if (recipe && recipe.steps.length > 0) return { id: e.id, recipe };
  }
  return null;
}

/**
 * Resolve a possibly-partial id to a full id. Same rules as before:
 * exact > id-substring > task-substring; null when none/ambiguous.
 */
export async function resolveRecipeId(
  query: string,
): Promise<{ id: string; ambiguous: false } | { ids: string[]; ambiguous: true } | null> {
  const all = await listRecipes();
  if (all.length === 0) return null;
  const exact = all.find((e) => e.id === query);
  if (exact) return { id: exact.id, ambiguous: false };
  const lower = query.toLowerCase();
  const idMatches = all.filter((e) => e.id.toLowerCase().includes(lower));
  if (idMatches.length === 1) return { id: idMatches[0]!.id, ambiguous: false };
  if (idMatches.length > 1) return { ids: idMatches.map((e) => e.id), ambiguous: true };
  const taskMatches = all.filter((e) => e.task.toLowerCase().includes(lower));
  if (taskMatches.length === 1) return { id: taskMatches[0]!.id, ambiguous: false };
  if (taskMatches.length > 1) return { ids: taskMatches.map((e) => e.id), ambiguous: true };
  return null;
}

/** Backwards-compatible alias. */
export const resolveSessionId = resolveRecipeId;

export async function latestRecipeId(): Promise<string | null> {
  const all = await listRecipes();
  return all[0]?.id ?? null;
}

/** Backwards-compatible alias. */
export const latestSessionId = latestRecipeId;

/** Path helpers exported so MCP tools / CLI can echo "saved to ...". */
export function pathsFor(id: string): {
  jsonPath: string;
  recipePath: string;
  sessionPath: string;
} {
  const recipePath = path.join(RECIPES_DIR, `${id}.recipe.ts`);
  return {
    jsonPath: path.join(RECIPES_DIR, `${id}.json`),
    recipePath,
    sessionPath: recipePath,
  };
}

export function recipesDirExists(): boolean {
  try {
    return fs.statSync(RECIPES_DIR).isDirectory();
  } catch {
    return false;
  }
}

/** Backwards-compatible alias. */
export const sessionsDirExists = recipesDirExists;
