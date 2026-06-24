#!/usr/bin/env node
/**
 * `ponder` CLI — record / build / run browser+desktop recipes; grant
 * and revoke bridge API keys; one-shot setup + doctor.
 *
 *   ponder list                 # newest-first table of recipes
 *   ponder show <id>            # print the .recipe.ts (default)
 *   ponder show <id> --json     # raw manifest
 *   ponder run                  # replay the LATEST recipe
 *   ponder run <id>             # replay a specific recipe (prefix-match)
 *   ponder run <id> --reground  # re-ground OS-level clicks via vision
 *   ponder run <id> --step 12   # start at step 12
 *   ponder run <id> --dry       # print steps without executing
 *   ponder run <id> --watch     # re-run on .json edits
 *   ponder build <id>           # regenerate the .recipe.ts from .json
 *   ponder open <id>            # open the .recipe.ts in $EDITOR
 *   ponder rm <id>              # delete a recipe's files
 *   ponder where                # print the recipes directory
 *   ponder doctor               # health check
 *   ponder setup                # guided setup wizard
 *   ponder attach [--url X]     # attach a Chrome tab (vision-assisted)
 *   ponder grant <name>         # mint an API key for a bridge consumer
 *   ponder grants list          # show issued keys
 *   ponder grants revoke <name> # revoke a key
 *   ponder grants log           # tail the bridge audit log
 *
 * The single `<id>` argument accepts a partial id (prefix or substring
 * match against id OR task).
 */

import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
  RECIPES_DIR,
  listRecipes,
  loadRecipe,
  pathsFor,
  resolveRecipeId,
  latestRecipeId,
  renderRecipeScript,
  saveRecipe,
} from "../agent/recorder.js";
import {
  replayRecipe,
  connectToUserChrome,
  ensureAttached as sdkEnsureAttached,
  createPonderClient,
} from "./sdk.js";
import {
  grantKey,
  revokeKey,
  readKeys,
  readAuditTail,
  KEYS_PATH,
  AUDIT_LOG_PATH,
  type Scope,
} from "../bridge/auth.js";
import {
  startBrowserJobsConsumer,
  readBrowserJobsConfig,
  bootstrapConfig,
  isConfigured,
} from "../agent/browser-jobs/index.js";

// ── Pretty output ────────────────────────────────────────────────────

const isTty = process.stdout.isTTY && process.stderr.isTTY;
const noColor = process.env.NO_COLOR !== undefined || !isTty;
const C = noColor
  ? {
      reset: "",
      bold: "",
      dim: "",
      green: "",
      yellow: "",
      red: "",
      cyan: "",
      magenta: "",
    }
  : {
      reset: "\x1b[0m",
      bold: "\x1b[1m",
      dim: "\x1b[2m",
      green: "\x1b[32m",
      yellow: "\x1b[33m",
      red: "\x1b[31m",
      cyan: "\x1b[36m",
      magenta: "\x1b[35m",
    };

function out(s: string): void {
  process.stdout.write(s + "\n");
}
function err(s: string): void {
  process.stderr.write(s + "\n");
}
function info(s: string): void {
  err(`${C.dim}${s}${C.reset}`);
}
function header(s: string): void {
  err(`${C.bold}${s}${C.reset}`);
}

function printHelp(): void {
  err(`${C.bold}ponder${C.reset} ${C.dim}— record / build / run browser+desktop recipes${C.reset}

${C.bold}USAGE${C.reset}
  ${C.cyan}ponder <command> [options]${C.reset}

${C.bold}RECIPES${C.reset}
  ${C.cyan}list${C.reset}                Show saved recipes (newest first)
  ${C.cyan}show${C.reset} <id>           Print a recipe's .recipe.ts (default) or manifest
  ${C.cyan}run${C.reset} [id]            Replay a recipe natively, no LLM
  ${C.cyan}build${C.reset} <id>          Regenerate the .recipe.ts from .json
  ${C.cyan}open${C.reset} [id]           Open the .recipe.ts in \$EDITOR
  ${C.cyan}rm${C.reset} <id>             Delete a recipe's files
  ${C.cyan}where${C.reset}               Print the recipes directory

${C.bold}BROWSER${C.reset}
  ${C.cyan}attach${C.reset}              Attach a Chrome tab (vision-assisted)
  ${C.cyan}setup${C.reset}               Guided setup wizard
  ${C.cyan}doctor${C.reset}              Health check

${C.bold}DISPATCH${C.reset}
  ${C.cyan}consume${C.reset}             Run jobs dispatched from the phone (subscribes to the
                      browser-jobs queue, executes each via Ponder)
  ${C.cyan}breaker-reset${C.reset}       How to clear a tripped FB account-safety breaker

${C.bold}BRIDGE AUTH${C.reset}
  ${C.cyan}grant${C.reset} <name>        Mint an API key for a consumer
  ${C.cyan}grants list${C.reset}         Show issued keys
  ${C.cyan}grants revoke${C.reset} <name> Revoke a key
  ${C.cyan}grants log${C.reset}          Tail the bridge audit log

${C.bold}RUN FLAGS${C.reset}
  --reground          Re-ground OS-level coordinate clicks via vision
  --step N            Start at step N (1-based)
  --max-steps N       Stop after N steps
  --step-delay-ms N   Pause between steps (default 400)
  --dry               Print steps without executing
  --watch             Re-run on .json or .recipe.ts edit

${C.dim}Recipes live under: ${RECIPES_DIR}${C.reset}
${C.dim}Keys live under:    ${KEYS_PATH}${C.reset}`);
}

// ── Argv parsing ─────────────────────────────────────────────────────

interface ParsedArgs {
  positional: string[];
  flags: Set<string>;
  options: Map<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Set<string>();
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > -1) {
      options.set(a.slice(2, eq), a.slice(eq + 1));
      continue;
    }
    const valueless = new Set([
      "json",
      "spec",
      "recipe",
      "session",
      "reground",
      "dry",
      "watch",
      "verbose",
      "help",
      "force",
    ]);
    const next = argv[i + 1];
    if (!valueless.has(a.slice(2)) && next !== undefined && !next.startsWith("--")) {
      options.set(a.slice(2), next);
      i++;
    } else {
      flags.add(a.slice(2));
    }
  }
  return { positional, flags, options };
}

async function resolveOrLatest(
  positional: string[],
): Promise<string | { error: string }> {
  if (positional.length === 0) {
    const latest = await latestRecipeId();
    if (!latest) {
      return {
        error: `No recipes recorded yet. Drive the MCP or run agent_do once to record one.`,
      };
    }
    info(`(no id given → using latest: ${latest})`);
    return latest;
  }
  const query = positional[0]!;
  const resolved = await resolveRecipeId(query);
  if (!resolved) {
    return { error: `No recipe matches "${query}". Try \`ponder list\`.` };
  }
  if (resolved.ambiguous) {
    return {
      error:
        `"${query}" is ambiguous (${resolved.ids.length} matches):\n` +
        resolved.ids.map((id) => `  • ${id}`).join("\n") +
        `\n\nUse a more specific prefix.`,
    };
  }
  if (resolved.id !== query) info(`(${query} → ${resolved.id})`);
  return resolved.id;
}

// ── Recipe commands ──────────────────────────────────────────────────

async function cmdList(args: ParsedArgs): Promise<number> {
  const entries = await listRecipes();
  const contains = args.options.get("contains");
  const filtered = contains
    ? entries.filter((e) => e.task.toLowerCase().includes(contains.toLowerCase()))
    : entries;
  const limitStr = args.options.get("limit");
  const limit = limitStr ? Math.max(1, parseInt(limitStr, 10)) : 25;
  const shown = filtered.slice(0, limit);

  if (args.flags.has("json")) {
    out(JSON.stringify(shown, null, 2));
    return 0;
  }
  if (shown.length === 0) {
    err(
      contains
        ? `${C.yellow}No recipes match "${contains}".${C.reset} ${C.dim}(${entries.length} total in ${RECIPES_DIR})${C.reset}`
        : `${C.yellow}No recipes recorded yet.${C.reset} ${C.dim}Drive the MCP (browser_*, agent_do) and call ponder_recipe_save — recipes land in ${RECIPES_DIR}.${C.reset}`,
    );
    return entries.length === 0 ? 0 : 1;
  }
  for (const e of shown) {
    const dur =
      e.durationMs !== undefined ? ` ${(e.durationMs / 1000).toFixed(1)}s` : "";
    const outcomeColor =
      e.outcome === "done"
        ? C.green
        : e.outcome === "error"
          ? C.red
          : C.yellow;
    const outcome = e.outcome ? ` ${outcomeColor}${e.outcome}${C.reset}` : "";
    out(
      `${C.bold}${e.id}${C.reset}${outcome}${C.dim}${dur}  ${e.steps} step${e.steps === 1 ? "" : "s"}${C.reset}`,
    );
    out(`  ${e.task.slice(0, 100)}${e.task.length > 100 ? "…" : ""}`);
    out(`  ${C.dim}${e.startedAt}${C.reset}`);
  }
  if (filtered.length > shown.length) {
    err("");
    info(`…and ${filtered.length - shown.length} more (raise --limit to see them).`);
  }
  return 0;
}

async function cmdShow(args: ParsedArgs): Promise<number> {
  const idOrErr = await resolveOrLatest(args.positional);
  if (typeof idOrErr === "object") {
    err(`${C.red}${idOrErr.error}${C.reset}`);
    return 1;
  }
  const id = idOrErr;
  const recipe = await loadRecipe(id);
  if (!recipe) {
    err(`${C.red}recipe "${id}" not found${C.reset}`);
    return 1;
  }
  if (args.flags.has("json")) {
    out(JSON.stringify(recipe, null, 2));
    return 0;
  }
  const { recipePath } = pathsFor(id);
  const onDisk = await fsp.readFile(recipePath, "utf-8").catch(() => null);
  out(onDisk?.trimEnd() ?? renderRecipeScript(recipe).trimEnd());
  return 0;
}

async function cmdOpen(args: ParsedArgs): Promise<number> {
  const idOrErr = await resolveOrLatest(args.positional);
  if (typeof idOrErr === "object") {
    err(`${C.red}${idOrErr.error}${C.reset}`);
    return 1;
  }
  const id = idOrErr;
  const { recipePath } = pathsFor(id);
  try {
    await fsp.access(recipePath);
  } catch {
    const r = await loadRecipe(id);
    if (!r) {
      err(`${C.red}recipe "${id}" not found${C.reset}`);
      return 1;
    }
    await fsp.writeFile(recipePath, renderRecipeScript(r), "utf-8");
  }
  const editor =
    process.env.PONDER_EDITOR ??
    process.env.VISUAL ??
    process.env.EDITOR ??
    (process.platform === "darwin" ? "open" : "vi");
  info(`opening ${recipePath} in ${editor}`);
  return new Promise((resolve) => {
    const child = spawn(editor, [recipePath], {
      stdio: "inherit",
      shell: false,
    });
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", (e) => {
      err(`${C.red}failed to launch ${editor}: ${e.message}${C.reset}`);
      resolve(127);
    });
  });
}

async function cmdRun(args: ParsedArgs): Promise<number> {
  const idOrErr = await resolveOrLatest(args.positional);
  if (typeof idOrErr === "object") {
    err(`${C.red}${idOrErr.error}${C.reset}`);
    return 1;
  }
  const id = idOrErr;
  if (args.flags.has("watch")) {
    return runWatch(id, args);
  }
  return runOnce(id, args);
}

async function runOnce(id: string, args: ParsedArgs): Promise<number> {
  const recipe = await loadRecipe(id);
  if (!recipe) {
    err(`${C.red}recipe "${id}" not found${C.reset}`);
    return 1;
  }
  const reground = args.flags.has("reground");
  const startStep = args.options.has("step")
    ? Math.max(1, parseInt(args.options.get("step")!, 10)) - 1
    : 0;
  const maxSteps = args.options.has("max-steps")
    ? Math.max(1, parseInt(args.options.get("max-steps")!, 10))
    : undefined;
  const stepDelayMs = args.options.has("step-delay-ms")
    ? Math.max(0, parseInt(args.options.get("step-delay-ms")!, 10))
    : undefined;

  if (args.flags.has("dry")) {
    header(`Dry run — ${id}`);
    info(`task: ${recipe.task}`);
    info(
      `steps: ${recipe.steps.length}` +
        (startStep > 0 ? `, starting at ${startStep + 1}` : "") +
        (maxSteps !== undefined ? `, max ${maxSteps}` : "") +
        `, reground=${reground}`,
    );
    err("");
    for (
      let i = startStep;
      i < recipe.steps.length && (maxSteps === undefined || i < startStep + maxSteps);
      i++
    ) {
      const s = recipe.steps[i]!;
      const label = s.intent ? `"${s.intent}"` : "(no intent)";
      out(`  ${i + 1}. ${C.cyan}${s.executed.type}${C.reset} ${C.dim}${label}${C.reset}`);
    }
    return 0;
  }

  header(`Replaying ${id}`);
  info(`task: ${recipe.task.slice(0, 100)}${recipe.task.length > 100 ? "…" : ""}`);
  info(
    `steps: ${recipe.steps.length}` +
      (startStep > 0 ? `, starting at ${startStep + 1}` : "") +
      (maxSteps !== undefined ? `, max ${maxSteps}` : "") +
      `, reground=${reground}`,
  );
  err("");

  const t0 = Date.now();
  const result = await replayRecipe(recipe, {
    reground,
    ...(stepDelayMs !== undefined ? { stepDelayMs } : {}),
    ...(startStep > 0 ? { startStep } : {}),
    ...(maxSteps !== undefined ? { maxSteps } : {}),
    onStep: ({ index, step, status, error: msg, ms }) => {
      const label = step.intent
        ? `${step.intent.slice(0, 64)}`
        : step.executed.type;
      if (status === "ok") {
        err(
          `  ${C.green}✓${C.reset} ${C.dim}${(index + 1).toString().padStart(3)}.${C.reset} ${C.cyan}${step.executed.type.padEnd(22)}${C.reset} ${label} ${C.dim}(${ms}ms)${C.reset}`,
        );
      } else {
        err(
          `  ${C.red}✗${C.reset} ${C.dim}${(index + 1).toString().padStart(3)}.${C.reset} ${C.cyan}${step.executed.type.padEnd(22)}${C.reset} ${label}\n      ${C.red}${msg}${C.reset}`,
        );
      }
    },
  });
  err("");
  const totalSecs = ((Date.now() - t0) / 1000).toFixed(1);
  if (result.failed === 0) {
    err(
      `${C.green}✓ replay ok${C.reset} ${C.dim}${result.ok}/${recipe.steps.length} steps · ${totalSecs}s${C.reset}`,
    );
    return 0;
  }
  err(
    `${C.red}✗ replay halted${C.reset} ${C.dim}${result.ok}/${recipe.steps.length} ok · ${result.failed} failed · ${totalSecs}s${C.reset}`,
  );
  if (result.failureScreenshotPath) {
    err(
      `${C.dim}failure screenshot: ${result.failureScreenshotPath}${C.reset}`,
    );
  }
  info(`fix the bad step: ${pathsFor(id).recipePath} (or .json)`);
  return 1;
}

async function runWatch(id: string, args: ParsedArgs): Promise<number> {
  const { jsonPath, recipePath } = pathsFor(id);
  header(`Watching ${id} — Ctrl+C to stop`);
  info(`files: ${jsonPath}, ${recipePath}`);
  err("");
  let pending: NodeJS.Timeout | null = null;
  let running = false;
  const innerArgs: ParsedArgs = {
    positional: args.positional,
    flags: new Set([...args.flags].filter((f) => f !== "watch")),
    options: args.options,
  };
  const trigger = (reason: string) => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(async () => {
      pending = null;
      if (running) return;
      running = true;
      try {
        info(`— ${reason} — re-running ${id}`);
        await runOnce(id, innerArgs);
      } finally {
        running = false;
      }
    }, 200);
  };
  for (const p of [jsonPath, recipePath]) {
    try {
      fs.watch(p, (event) => trigger(`${path.basename(p)} ${event}`));
    } catch {
      /* file may not exist yet */
    }
  }
  await runOnce(id, innerArgs);
  return new Promise(() => {});
}

async function cmdBuild(args: ParsedArgs): Promise<number> {
  const idOrErr = await resolveOrLatest(args.positional);
  if (typeof idOrErr === "object") {
    err(`${C.red}${idOrErr.error}${C.reset}`);
    return 1;
  }
  const id = idOrErr;
  const recipe = await loadRecipe(id);
  if (!recipe) {
    err(`${C.red}recipe "${id}" not found${C.reset}`);
    return 1;
  }
  const outDir = args.options.get("out");
  const saved = await saveRecipe(recipe);
  if (!saved) {
    err(`${C.red}saveRecipe failed${C.reset}`);
    return 1;
  }
  err(`${C.green}rebuilt${C.reset} ${saved.recipePath}`);
  if (outDir) {
    await fsp.mkdir(outDir, { recursive: true });
    const dest = path.join(outDir, `${id}.recipe.ts`);
    const src = await fsp.readFile(saved.recipePath, "utf-8");
    await fsp.writeFile(dest, src, "utf-8");
    err(`${C.green}exported${C.reset} ${dest}`);
  }
  return 0;
}

async function cmdRm(args: ParsedArgs): Promise<number> {
  const idOrErr = await resolveOrLatest(args.positional);
  if (typeof idOrErr === "object") {
    err(`${C.red}${idOrErr.error}${C.reset}`);
    return 1;
  }
  const id = idOrErr;
  const { jsonPath, recipePath } = pathsFor(id);
  const dir = path.dirname(jsonPath);
  const legacy = [
    path.join(dir, `${id}.session.ts`),
    path.join(dir, `${id}.spec.ts`),
    path.join(dir, `${id}.run.ts`),
    path.join(dir, `${id}.last-failure.png`),
  ];
  let removed = 0;
  for (const p of [jsonPath, recipePath, ...legacy]) {
    try {
      await fsp.unlink(p);
      removed++;
    } catch {
      /* missing — fine */
    }
  }
  if (removed === 0) {
    err(`${C.yellow}no files for "${id}" — already gone${C.reset}`);
    return 0;
  }
  err(`${C.green}removed ${removed} file(s) for ${id}${C.reset}`);
  return 0;
}

// ── doctor / setup — Ink-rendered ─────────────────────────────────────
//
// The setup wizard and doctor screen are React components rendered
// through Ink (gemini-cli-flavored). The CLI dispatcher below renders
// them and waits for `useApp().exit()` to fire before returning the
// process exit code. Keeps the CLI scripting in one file while the
// presentation lives in src/cli/ui/.

async function cmdDoctor(): Promise<number> {
  // Lazy-import so non-doctor commands don't pay the React + Ink load.
  const React = (await import("react")).default;
  const { render } = await import("ink");
  const { Doctor } = await import("./ui/Doctor.js");
  const app = render(React.createElement(Doctor));
  await app.waitUntilExit();
  return 0;
}

async function cmdSetup(): Promise<number> {
  const React = (await import("react")).default;
  const { render } = await import("ink");
  const { Setup } = await import("./ui/Setup.js");
  const app = render(React.createElement(Setup));
  await app.waitUntilExit();
  return 0;
}

// ── attach ──────────────────────────────────────────────────────────

async function cmdAttach(args: ParsedArgs): Promise<number> {
  const url = args.options.get("url");
  const tabHint = args.options.get("tab");
  try {
    const result = await sdkEnsureAttached({
      ...(url ? { url } : {}),
      ...(tabHint ? { tabHint } : {}),
    });
    err(`${C.green}✓ attached${C.reset} ${result.url}`);
    err(`${C.dim}  title: ${result.title}${C.reset}`);
    return 0;
  } catch (e) {
    err(`${C.red}✗ attach failed:${C.reset} ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

// ── grant / grants ───────────────────────────────────────────────────

async function cmdGrant(args: ParsedArgs): Promise<number> {
  const name = args.positional[0];
  if (!name) {
    err(`${C.red}usage:${C.reset} ponder grant <name> [--scopes browser:*,recipe:*]`);
    return 2;
  }
  const scopesRaw = args.options.get("scopes");
  const scopes: Scope[] = scopesRaw
    ? scopesRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : ["*"];
  const notes = args.options.get("notes");
  const record = await grantKey({
    name,
    scopes,
    ...(notes ? { notes } : {}),
  });
  err(`${C.green}✓ granted${C.reset} consumer "${C.bold}${name}${C.reset}" (scopes: ${scopes.join(", ")}):`);
  err("");
  out(record.key);
  err("");
  err(
    `${C.yellow}Copy the key above NOW.${C.reset} ${C.dim}It's only shown once — ponder never echoes it again.${C.reset}`,
  );
  err(`${C.dim}revoke later with:${C.reset} ponder grants revoke ${name}`);
  return 0;
}

async function cmdGrants(args: ParsedArgs): Promise<number> {
  const sub = args.positional[0];
  switch (sub) {
    case "list":
    case undefined: {
      const keys = await readKeys();
      if (keys.length === 0) {
        err(`${C.yellow}No keys issued.${C.reset} ${C.dim}Use \`ponder grant <name>\` to mint one.${C.reset}`);
        return 0;
      }
      header("Active keys:");
      err("");
      for (const k of keys) {
        const suffix = k.key.slice(-6);
        const last = k.lastUsedAt ?? "never";
        err(
          `  ${C.bold}${k.name}${C.reset}  ${C.dim}…${suffix}${C.reset}  scopes=[${k.scopes.join(", ")}]  lastUsed=${last}`,
        );
      }
      return 0;
    }
    case "revoke": {
      const name = args.positional[1];
      if (!name) {
        err(`${C.red}usage:${C.reset} ponder grants revoke <name>`);
        return 2;
      }
      const ok = await revokeKey(name);
      if (!ok) {
        err(`${C.yellow}no key for "${name}" — nothing revoked${C.reset}`);
        return 1;
      }
      err(`${C.green}✓ revoked${C.reset} ${name}`);
      return 0;
    }
    case "log": {
      const tail = args.options.has("tail")
        ? Math.max(1, parseInt(args.options.get("tail")!, 10))
        : 25;
      const consumer = args.options.get("consumer");
      const rows = await readAuditTail({
        tail,
        ...(consumer ? { consumer } : {}),
      });
      if (rows.length === 0) {
        err(`${C.yellow}empty audit log${C.reset} ${C.dim}(${AUDIT_LOG_PATH})${C.reset}`);
        return 0;
      }
      for (const r of rows.reverse()) {
        out(
          `${C.dim}${r.ts}${C.reset}  ${C.bold}${r.consumer}${C.reset}  ${r.method} ${r.path}  ${r.status}  ${C.dim}${r.durationMs}ms${C.reset}`,
        );
      }
      return 0;
    }
    default:
      err(`${C.red}unknown grants subcommand: ${sub}${C.reset}`);
      printHelp();
      return 2;
  }
}

// ── Dispatcher ───────────────────────────────────────────────────────

// ── consume: run the browser-jobs dispatch consumer ─────────────────
// Subscribes to the sssync-bknd Convex `browserJobs` queue and executes each
// job through the Ponder engine (local Electron bridge). Long-running: stays
// up until Ctrl-C. This is the desktop side of "send a job from the phone".
async function cmdConsume(): Promise<number> {
  let config = readBrowserJobsConfig();
  if (!isConfigured(config)) config = await bootstrapConfig(config);
  if (!isConfigured(config)) {
    err(`${C.red}browser-jobs consumer is not configured.${C.reset}`);
    err(
      `${C.dim}Set PONDER_BROWSER_JOBS_CONVEX_URL + PONDER_BROWSER_JOBS_USER_ID,\n` +
        `or PONDER_BROWSER_JOBS_SYNC_BASE_URL + PONDER_BROWSER_JOBS_SYNC_TOKEN to bootstrap from the backend.${C.reset}`,
    );
    return 2;
  }

  out(`${C.bold}ponder consume${C.reset} ${C.dim}— waiting for dispatched jobs (Ctrl-C to stop)${C.reset}`);
  const consumer = await startBrowserJobsConsumer({
    config,
    events: { log: (msg) => out(`${C.dim}[browser-jobs]${C.reset} ${msg}`) },
  });
  const s = consumer.status();
  out(
    `${C.cyan}worker=${s.workerId}${C.reset} user=${s.userId} ` +
      `bridge=:${config.bridgePort} reconcile=${s.backendSyncConfigured ? "on" : "off"}`,
  );
  // FB account-safety (writes only): pacing + caps + breaker threshold.
  out(
    `${C.dim}safety: write-jitter ${config.writeMinGapMs}–${config.writeMaxGapMs}ms · ` +
      `caps ${config.writeHourlyCap}/h ${config.writeDailyCap}/24h · ` +
      `breaker after ${config.frictionBreakConsecutiveFails} consecutive write fails · ` +
      `read-jitter ${config.readJitterMaxMs}ms${C.reset}`,
  );
  out(
    `${C.dim}breaker: ${s.breakerTripped ? `${C.red}TRIPPED${C.reset}${C.dim}` : "ok"}` +
      `${s.breakerReason ? ` (${s.breakerReason})` : ""} · ` +
      `writes ${s.writesLastHour}/h ${s.writesLastDay}/24h${C.reset}`,
  );
  out(
    `${C.dim}(reset a tripped breaker: Ctrl-C + restart, or relaunch with ` +
      `PONDER_FRICTION_BREAKER_RESET=1)${C.reset}`,
  );
  if (!s.backendSyncConfigured) {
    err(
      `${C.dim}(no sync token — jobs run + complete in Convex but won't reconcile back to the agent thread)${C.reset}`,
    );
  }

  // Keep the process alive until interrupted.
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      out(`\n${C.dim}stopping consumer…${C.reset}`);
      try {
        consumer.stop();
      } catch {
        /* ignore */
      }
      resolve();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
  return 0;
}

// ── breaker-reset: explain how to clear the FB account-safety breaker ───
// The circuit breaker lives IN-MEMORY on the long-lived `consume` process, so
// a separate CLI invocation can't reach it. The realistic resets are (a) Ctrl-C
// the consumer and restart (clears in-memory state), or (b) relaunch it with
// PONDER_FRICTION_BREAKER_RESET=1 for one run. In-process callers (Electron)
// can call consumer.resetBreaker() directly.
function cmdBreakerReset(): number {
  out(`${C.bold}reset the FB account-safety circuit breaker${C.reset}`);
  out("");
  out(`${C.dim}The breaker pauses Facebook WRITE jobs after repeated failures or a`);
  out(`friction signal (checkpoint/captcha/restriction). Reads keep running.${C.reset}`);
  out("");
  out(`${C.cyan}1.${C.reset} Check Facebook manually first — confirm the account is healthy.`);
  out(`${C.cyan}2.${C.reset} Reset by EITHER:`);
  out(`     ${C.dim}• Ctrl-C the running ${C.reset}${C.cyan}ponder consume${C.reset}${C.dim} and start it again, OR${C.reset}`);
  out(`     ${C.dim}• relaunch it once with ${C.reset}PONDER_FRICTION_BREAKER_RESET=1 ponder consume`);
  out(`${C.dim}(In-app/Electron: call consumer.resetBreaker().)${C.reset}`);
  return 0;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = parseArgs(argv.slice(1));

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    printHelp();
    process.exit(0);
  }
  try {
    switch (cmd) {
      case "list":
      case "ls":
        process.exit(await cmdList(rest));
        return;
      case "show":
      case "cat":
        process.exit(await cmdShow(rest));
        return;
      case "open":
      case "edit":
        process.exit(await cmdOpen(rest));
        return;
      case "run":
      case "replay":
        process.exit(await cmdRun(rest));
        return;
      case "build":
      case "regen":
        process.exit(await cmdBuild(rest));
        return;
      case "rm":
      case "delete":
        process.exit(await cmdRm(rest));
        return;
      case "doctor":
      case "check":
        process.exit(await cmdDoctor());
        return;
      case "setup":
        process.exit(await cmdSetup());
        return;
      case "attach":
        process.exit(await cmdAttach(rest));
        return;
      case "grant":
        process.exit(await cmdGrant(rest));
        return;
      case "grants":
        process.exit(await cmdGrants(rest));
        return;
      case "where":
        out(RECIPES_DIR);
        process.exit(0);
        return;
      case "consume":
        process.exit(await cmdConsume());
        return;
      case "breaker-reset":
        process.exit(cmdBreakerReset());
        return;
      default:
        err(`${C.red}unknown command: ${cmd}${C.reset}`);
        printHelp();
        process.exit(2);
    }
  } catch (e) {
    err(`${C.red}error:${C.reset} ${e instanceof Error ? e.message : String(e)}`);
    if (process.env.PONDER_DEBUG) {
      err(`${C.dim}${e instanceof Error ? e.stack : ""}${C.reset}`);
    }
    process.exit(1);
  }
}

void main();
