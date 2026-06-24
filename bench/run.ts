#!/usr/bin/env tsx
/**
 * Ponder bench harness — run a single case end-to-end.
 *
 *   npx tsx bench/run.ts <case-id> [--dry-run] [--no-setup] [--targetApp X]
 *
 * Reads `bench/cases/<case-id>.md`, parses YAML frontmatter + extracts
 * the verbatim task prompt, the setup bash block, and the scoring bash
 * block. Then:
 *
 *   1. Preflight: GET http://127.0.0.1:7900/version. Warn (don't bail)
 *      if the SHA doesn't match `git rev-parse --short=12 HEAD`.
 *   2. Setup: run the case's bash block. stdout/stderr captured but
 *      non-zero exit does NOT abort — some setup scripts intentionally
 *      have failable probes (e.g. `osascript ... && echo X || echo Y`).
 *   3. Dispatch: POST /agent_do with `{ task, targetApp? }`. Long
 *      timeout (15 min) — let agent_do's own anti-loop guards decide
 *      when to bail.
 *   4. Score: run the case's scoring bash block with env vars OUTCOME,
 *      RUN_START_ISO, RUN_END_ISO set. Parse stdout for a line starting
 *      with "PASS" or "FAIL".
 *   5. Write result JSON to `bench/results/<case-id>-<iso>.json`.
 *
 * Authority order (from the t4 pilot, 2026-05-11):
 *   deterministic_score > strict_verifier > agent_outcome
 *
 * Both signals are recorded; deterministic_score is the headline.
 *
 * Usage flags:
 *   --dry-run     Parse the case + run setup + score (skip agent call).
 *                 For verifying a case .md is wired correctly before
 *                 burning model time.
 *   --no-setup    Skip the setup block. Use when you've already
 *                 manually established state.
 *   --targetApp X Override / inject targetApp (frontmatter doesn't
 *                 always specify it; the agent loop auto-detects).
 */

import { execFileSync, execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const BRIDGE_BASE = process.env.PONDER_BRIDGE_BASE ?? "http://127.0.0.1:7900";
const REPO_ROOT = resolve(__dirname, "..");
const CASES_DIR = join(REPO_ROOT, "bench", "cases");
const RESULTS_DIR = join(REPO_ROOT, "bench", "results");

// ── arg parsing ──────────────────────────────────────────────────────

interface Args {
  caseId: string;
  dryRun: boolean;
  noSetup: boolean;
  targetAppOverride?: string;
  maxStepsOverride?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    caseId: "",
    dryRun: false,
    noSetup: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--no-setup") args.noSetup = true;
    else if (a === "--targetApp") args.targetAppOverride = argv[++i];
    else if (a === "--maxSteps") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 5 || n > 200) {
        console.error(`--maxSteps must be 5..200; got ${argv[i]}`);
        process.exit(2);
      }
      args.maxStepsOverride = Math.floor(n);
    } else if (a.startsWith("--")) {
      console.error(`Unknown flag: ${a}`);
      process.exit(2);
    } else if (!args.caseId) args.caseId = a.replace(/\.md$/, "");
    else {
      console.error(`Unexpected positional arg: ${a}`);
      process.exit(2);
    }
  }
  if (!args.caseId) {
    console.error(
      "Usage: tsx bench/run.ts <case-id> [--dry-run] [--no-setup] [--targetApp X] [--maxSteps N]",
    );
    process.exit(2);
  }
  return args;
}

// ── case .md parsing ─────────────────────────────────────────────────

interface CaseFrontmatter {
  task_id?: string;
  tier?: string;
  axes?: string[];
  expected_actions?: number;
  infeasible?: boolean;
  targetApp?: string;
  // Long-horizon cases override the loop's default MAX_STEPS (50).
  // The harness passes this to the bridge's /agent_do POST body; the
  // bridge clamps to [5, 200]. Use sparingly — bigger budgets mean
  // longer wall times when the agent loops.
  max_steps?: number;
  // Declared-multi-step case (NEXT-WORK Item 2): the harness passes
  // decompose:true so the loop one-shot-decomposes and verify-advances.
  // Inert unless the bridge process has PONDER_DECOMPOSE on.
  multistep?: boolean;
}

interface ParsedCase {
  frontmatter: CaseFrontmatter;
  taskPrompt: string;
  setupBash: string | null;
  scoringBash: string | null;
  raw: string;
}

/**
 * Tiny YAML-frontmatter parser. Handles the subset our case files use:
 * `key: value` (string|number|bool), `key:` followed by `  - item`
 * lines (string arrays). Not a general YAML parser; throws on anything
 * fancier so we catch surprises early instead of silently misparsing.
 */
function parseFrontmatter(raw: string): {
  frontmatter: CaseFrontmatter;
  body: string;
} {
  if (!raw.startsWith("---\n")) return { frontmatter: {}, body: raw };
  const end = raw.indexOf("\n---\n", 4);
  if (end < 0) return { frontmatter: {}, body: raw };
  const fmText = raw.slice(4, end);
  const body = raw.slice(end + 5);
  const fm: Record<string, unknown> = {};
  const lines = fmText.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.startsWith("#")) {
      i++;
      continue;
    }
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!m) {
      throw new Error(`frontmatter: unparseable line ${i + 1}: ${line}`);
    }
    const [, key, valueRaw] = m;
    const value = valueRaw.trim();
    if (value === "") {
      // array follows
      const arr: string[] = [];
      i++;
      while (i < lines.length && /^\s+-\s+/.test(lines[i])) {
        arr.push(lines[i].replace(/^\s+-\s+/, "").trim());
        i++;
      }
      fm[key] = arr;
      continue;
    }
    if (value === "true" || value === "false") fm[key] = value === "true";
    else if (/^-?\d+$/.test(value)) fm[key] = Number(value);
    else fm[key] = value.replace(/^"(.*)"$/, "$1");
    i++;
  }
  return { frontmatter: fm as CaseFrontmatter, body };
}

/**
 * Extract the verbatim task prompt. Convention: the case has a header
 * matching `## Task` (possibly with parenthetical suffix), and the
 * prompt itself is given as `> ` blockquote lines immediately after.
 * Joins blockquote lines with single spaces (preserves the prompt as
 * one paragraph regardless of MD line-wrap).
 */
function extractTaskPrompt(body: string): string {
  const headerRe = /^##\s+Task\b[^\n]*$/m;
  const m = headerRe.exec(body);
  if (!m) throw new Error("case .md: missing `## Task` section");
  const after = body.slice(m.index + m[0].length);
  const lines = after.split("\n");
  const out: string[] = [];
  let started = false;
  for (const line of lines) {
    if (line.startsWith(">")) {
      out.push(line.replace(/^>\s?/, "").trim());
      started = true;
    } else if (started && line.trim() === "") {
      // blank line inside blockquote → keep collecting
      continue;
    } else if (started) {
      break;
    }
    // unstarted non-blockquote lines: keep scanning
  }
  if (out.length === 0) {
    throw new Error(
      "case .md: `## Task` section has no `> ` blockquote prompt",
    );
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Extract the FIRST ```sh or ```bash code block inside a given `## X`
 * section. Returns null if the section exists but has no code block
 * (which means "no setup needed" / "no automated scoring").
 */
function extractFirstBashBlock(body: string, headerRe: RegExp): string | null {
  const m = headerRe.exec(body);
  if (!m) return null;
  // limit search to text BEFORE the next `## ` header
  const after = body.slice(m.index + m[0].length);
  const nextHeader = /^##\s+/m.exec(after);
  const section = nextHeader ? after.slice(0, nextHeader.index) : after;
  const fence = /```(?:sh|bash)\n([\s\S]*?)\n```/m.exec(section);
  return fence ? fence[1] : null;
}

function parseCase(caseId: string): ParsedCase {
  const path = join(CASES_DIR, `${caseId}.md`);
  if (!existsSync(path)) {
    throw new Error(`case not found: ${path}`);
  }
  const raw = readFileSync(path, "utf8");
  const { frontmatter, body } = parseFrontmatter(raw);
  const taskPrompt = extractTaskPrompt(body);
  const setupBash = extractFirstBashBlock(body, /^##\s+Setup\b[^\n]*$/m);
  const scoringBash = extractFirstBashBlock(body, /^##\s+Scoring\b[^\n]*$/m);
  return { frontmatter, taskPrompt, setupBash, scoringBash, raw };
}

// ── bridge interaction ───────────────────────────────────────────────

interface BridgeVersion {
  commit?: string;
  commitShort?: string;
  dirty?: boolean;
  builtAt?: string;
  error?: string;
}

async function fetchBridgeVersion(): Promise<BridgeVersion | null> {
  try {
    const res = await fetch(`${BRIDGE_BASE}/version`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    return (await res.json()) as BridgeVersion;
  } catch {
    return null;
  }
}

interface AgentDoResult {
  outcome?: string;
  steps?: number;
  durationMs?: number;
  text?: string;
  history?: unknown[];
  verifier?: { state?: string; reason?: string };
  error?: string;
  [k: string]: unknown;
}

async function callAgentDo(
  task: string,
  targetApp: string | undefined,
  maxSteps: number | undefined,
  timeoutMs: number,
  decompose?: boolean,
): Promise<{ ok: boolean; body: AgentDoResult; httpStatus: number }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BRIDGE_BASE}/agent_do`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task,
        targetApp,
        maxSteps,
        ...(decompose ? { decompose: true } : {}),
      }),
      signal: ctrl.signal,
    });
    const body = (await res.json()) as AgentDoResult;
    return { ok: res.ok, body, httpStatus: res.status };
  } finally {
    clearTimeout(t);
  }
}

// ── bash execution helpers ───────────────────────────────────────────

interface BashRun {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a bash script. Captures stdout and stderr separately. Does NOT
 * throw on non-zero exit — many setup scripts have intentional probes.
 * The caller decides what a non-zero means.
 */
function runBash(script: string, env: Record<string, string>): BashRun {
  // We use execSync via `bash -c <script>` rather than execFileSync
  // because case scripts use shell features (pipes, heredocs, &&).
  // Hard timeout: 60s for setup, scoring should be faster but we share
  // this helper.
  try {
    const stdout = execSync(script, {
      shell: "/bin/bash",
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (e: unknown) {
    const err = e as {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      status?: number;
    };
    return {
      stdout:
        typeof err.stdout === "string"
          ? err.stdout
          : err.stdout
            ? err.stdout.toString("utf8")
            : "",
      stderr:
        typeof err.stderr === "string"
          ? err.stderr
          : err.stderr
            ? err.stderr.toString("utf8")
            : String(e),
      exitCode: err.status ?? 1,
    };
  }
}

/**
 * Parse a scoring script's stdout for a PASS/FAIL verdict.
 *
 * Convention: the LAST line that starts with "PASS" or "FAIL" wins.
 * (Last-line wins because some scoring scripts have intermediate echos
 * like "FILE_PRESENT" or diagnostic prints before the verdict.)
 *
 * Returns:
 *   "PASS"     — last verdict line started with PASS
 *   "FAIL"     — last verdict line started with FAIL (any suffix is OK)
 *   "UNKNOWN"  — no PASS/FAIL line found; treat as scoring-broken, not
 *                a substantive failure
 */
function parseScoringVerdict(stdout: string): {
  verdict: "PASS" | "FAIL" | "UNKNOWN";
  reasonLine: string;
} {
  const lines = stdout.split("\n");
  let lastVerdict: string | null = null;
  for (const line of lines) {
    const t = line.trim();
    if (/^PASS\b/.test(t) || /^FAIL\b/.test(t)) lastVerdict = t;
  }
  if (!lastVerdict) return { verdict: "UNKNOWN", reasonLine: "" };
  return {
    verdict: lastVerdict.startsWith("PASS") ? "PASS" : "FAIL",
    reasonLine: lastVerdict,
  };
}

// ── main ─────────────────────────────────────────────────────────────

function isoNow(): string {
  return new Date().toISOString();
}
function isoForFilename(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z");
}
function gitShortSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const caseId = args.caseId;
  console.log(`▶ bench/run.ts case=${caseId} dryRun=${args.dryRun}`);

  const c = parseCase(caseId);
  console.log(
    `  parsed: tier=${c.frontmatter.tier ?? "?"} infeasible=${
      c.frontmatter.infeasible ?? false
    } expected_actions=${c.frontmatter.expected_actions ?? "?"}`,
  );
  console.log(`  task: ${c.taskPrompt.slice(0, 120)}${c.taskPrompt.length > 120 ? "…" : ""}`);
  console.log(
    `  setup: ${c.setupBash ? `${c.setupBash.split("\n").length} lines` : "(none)"}`,
  );
  console.log(
    `  scoring: ${c.scoringBash ? `${c.scoringBash.split("\n").length} lines` : "(none)"}`,
  );

  const startedAt = isoNow();
  const localSha = gitShortSha();
  const bridgeVer = await fetchBridgeVersion();
  console.log(
    `  bridge: ${
      bridgeVer
        ? `commit=${bridgeVer.commitShort}${bridgeVer.dirty ? "-dirty" : ""}`
        : "OFFLINE"
    } | repo HEAD=${localSha}`,
  );
  let staleBridge = false;
  if (bridgeVer && bridgeVer.commit && !bridgeVer.commit.startsWith(localSha)) {
    console.warn(
      `  ⚠ bridge SHA (${bridgeVer.commitShort}) differs from repo HEAD (${localSha}). ` +
        "Run `bash scripts/kill-stale-mcp.sh` and restart Electron if you need fresh code.",
    );
    staleBridge = true;
  }
  if (!bridgeVer) {
    console.warn(
      "  ⚠ bridge /version probe failed. agent_do call will likely 404. Continue anyway (dry-run still possible).",
    );
  }

  // ── setup ─────────────────────────────────────────────────────────
  const RUN_START_ISO = startedAt;
  let setupResult: BashRun | null = null;
  if (c.setupBash && !args.noSetup) {
    console.log("▶ running setup …");
    setupResult = runBash(c.setupBash, { RUN_START_ISO });
    if (setupResult.exitCode !== 0) {
      console.warn(
        `  ⚠ setup exit=${setupResult.exitCode}. stderr: ${setupResult.stderr.slice(0, 200)}`,
      );
    } else {
      console.log(`  ✓ setup ok (stdout: ${setupResult.stdout.trim().slice(0, 80)})`);
    }
  } else if (args.noSetup) {
    console.log("  (skipping setup — --no-setup)");
  } else {
    console.log("  (no setup block in case .md)");
  }

  // ── agent call ────────────────────────────────────────────────────
  let agentResult: AgentDoResult | null = null;
  let agentOutcome = "skipped";
  let agentDurationMs = 0;
  const targetApp = args.targetAppOverride ?? c.frontmatter.targetApp;
  const maxSteps = args.maxStepsOverride ?? c.frontmatter.max_steps;
  // Long-horizon cases need a longer HTTP timeout. Heuristic: budget
  // ~30s per step plus 60s headroom for warmup/save dialogs.
  const httpTimeoutMs = ((maxSteps ?? 50) * 30 + 60) * 1000;
  if (!args.dryRun) {
    console.log(
      `▶ POST ${BRIDGE_BASE}/agent_do  targetApp=${targetApp ?? "(auto)"}  maxSteps=${
        maxSteps ?? "(default 50)"
      }  http-timeout=${(httpTimeoutMs / 1000).toFixed(0)}s`,
    );
    const t0 = Date.now();
    try {
      const { ok, body, httpStatus } = await callAgentDo(
        c.taskPrompt,
        targetApp,
        maxSteps,
        httpTimeoutMs,
        c.frontmatter.multistep === true,
      );
      agentDurationMs = Date.now() - t0;
      agentResult = body;
      agentOutcome = (body.outcome as string | undefined) ?? "unknown";
      console.log(
        `  ← http=${httpStatus} ok=${ok} outcome=${agentOutcome} steps=${
          body.steps ?? "?"
        } durationMs=${agentDurationMs}`,
      );
      if (body.verifier) {
        console.log(
          `  verifier: state=${body.verifier.state} reason=${(body.verifier.reason ?? "").slice(0, 200)}`,
        );
      }
    } catch (e) {
      agentDurationMs = Date.now() - t0;
      agentOutcome = "error";
      agentResult = {
        outcome: "error",
        error: e instanceof Error ? e.message : String(e),
      };
      console.error(`  ✗ agent_do call failed: ${agentResult.error}`);
    }
  } else {
    console.log("▶ --dry-run: skipping agent_do call");
  }

  const endedAt = isoNow();

  // ── scoring ───────────────────────────────────────────────────────
  let scoringRun: BashRun | null = null;
  let verdict: "PASS" | "FAIL" | "UNKNOWN" = "UNKNOWN";
  let verdictLine = "";
  if (c.scoringBash) {
    console.log("▶ running scoring …");
    scoringRun = runBash(c.scoringBash, {
      RUN_START_ISO,
      RUN_END_ISO: endedAt,
      OUTCOME: agentOutcome,
    });
    const parsed = parseScoringVerdict(scoringRun.stdout);
    verdict = parsed.verdict;
    verdictLine = parsed.reasonLine;
    console.log(`  scoring verdict: ${verdict}${verdictLine ? ` — ${verdictLine}` : ""}`);
    if (verdict === "UNKNOWN") {
      console.warn(
        "  ⚠ scoring stdout contained no PASS/FAIL line. Stdout (last 400 chars):",
      );
      console.warn("  " + scoringRun.stdout.slice(-400));
    }
  } else {
    console.log("  (no scoring block in case .md — verdict UNKNOWN)");
  }

  // ── write result JSON ─────────────────────────────────────────────
  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  const resultFilename = `${caseId}-${isoForFilename()}.json`;
  const resultPath = join(RESULTS_DIR, resultFilename);
  const elapsedMs =
    new Date(endedAt).getTime() - new Date(startedAt).getTime();

  const result = {
    id: `${caseId}-${startedAt}`,
    case: caseId,
    tier: c.frontmatter.tier ?? null,
    axes: c.frontmatter.axes ?? [],
    started_at: startedAt,
    ended_at: endedAt,
    elapsed_ms: elapsedMs,
    repo_head_short: localSha,
    bridge_version: bridgeVer,
    stale_bridge_warning: staleBridge,
    dry_run: args.dryRun,
    targetApp: targetApp ?? null,
    max_steps: maxSteps ?? null,
    task_prompt: c.taskPrompt,
    setup: setupResult
      ? {
          exit_code: setupResult.exitCode,
          stdout: setupResult.stdout,
          stderr: setupResult.stderr,
        }
      : null,
    agent: {
      called: !args.dryRun,
      outcome: agentOutcome,
      duration_ms: agentDurationMs,
      steps: agentResult?.steps ?? null,
      response: agentResult,
    },
    scoring: scoringRun
      ? {
          verdict,
          verdict_line: verdictLine,
          exit_code: scoringRun.exitCode,
          stdout: scoringRun.stdout,
          stderr: scoringRun.stderr,
        }
      : null,
    // Authority order: deterministic_score is the headline.
    deterministic_score: verdict,
    agent_self_reported_outcome: agentOutcome,
    disagreement:
      verdict !== "UNKNOWN" &&
      ((verdict === "PASS" && agentOutcome !== "done") ||
        (verdict === "FAIL" && agentOutcome === "done")),
  };

  // Strip the embedded base64 final screenshot to a sidecar PNG.
  // Without this the result JSON balloons to 1+ MB and becomes
  // un-Readable by tools with file-size limits. The sidecar is
  // referenced from the JSON via path + sha256.
  const resp = result.agent.response;
  if (
    resp &&
    typeof resp === "object" &&
    typeof (resp as { finalScreenshotBase64?: unknown })
      .finalScreenshotBase64 === "string"
  ) {
    const b64 = (resp as { finalScreenshotBase64: string })
      .finalScreenshotBase64;
    try {
      const png = Buffer.from(b64, "base64");
      const sidecarName = resultFilename.replace(/\.json$/, "-final.png");
      const sidecarPath = join(RESULTS_DIR, sidecarName);
      writeFileSync(sidecarPath, png);
      delete (resp as { finalScreenshotBase64?: string })
        .finalScreenshotBase64;
      (resp as Record<string, unknown>).finalScreenshotSidecarPath =
        sidecarName;
      (resp as Record<string, unknown>).finalScreenshotSidecarSha256 =
        createHash("sha256").update(png).digest("hex").slice(0, 16);
      console.log(
        `  📷 stripped ${png.length}b screenshot → ${sidecarName}`,
      );
    } catch (e) {
      console.warn(
        `  ⚠ failed to strip screenshot: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n");
  console.log(`▶ wrote ${resultPath}`);
  console.log("");
  console.log(`  HEADLINE: ${verdict}  (agent_outcome=${agentOutcome})`);
  if (result.disagreement) {
    console.log(
      "  ⚠ DISAGREEMENT: deterministic and agent disagree. State is authoritative.",
    );
  }

  // Exit code: 0 if PASS, 1 if FAIL, 2 if UNKNOWN. Lets CI / shell
  // loops over the suite aggregate cleanly.
  process.exit(verdict === "PASS" ? 0 : verdict === "FAIL" ? 1 : 2);
}

main().catch((e) => {
  console.error("bench/run.ts crashed:", e);
  process.exit(3);
});
