#!/usr/bin/env tsx
/**
 * Suite aggregator — runs every bench/cases/*.md through bench/run.ts,
 * groups results by tier, and computes the single weighted ponder_score
 * defined in bench/SUITE.md.
 *
 * Why a separate file (not a flag on run.ts): run.ts is the per-case
 * contract (parse → setup → agent_do → score → one result JSON, exit
 * 0/1/2). This wraps N invocations and produces a SUITE-level report.
 * Keeping them separate means a single case is still debuggable in
 * isolation and this file never has to re-implement scoring.
 *
 * Score (bench/SUITE.md):
 *   ponder_score = 0.10*T1 + 0.20*T2 + 0.15*T3 + 0.40*T4 + 0.15*T5
 * where Tn = pass_rate within tier n (passes / cases-actually-run).
 * Tiers with zero cases contribute 0 AND are flagged as coverage gaps
 * so the number is never silently inflated by missing tiers.
 *
 * Usage:
 *   npx tsx bench/run-all.ts                 # every case, full runs
 *   npx tsx bench/run-all.ts --dry-run       # parse+setup+score, skip agent
 *   npx tsx bench/run-all.ts --only T4       # only one tier
 *   npx tsx bench/run-all.ts --cases a,b,c   # explicit subset
 *   npx tsx bench/run-all.ts --no-setup      # forward --no-setup to run.ts
 *
 * Exit code: 0 if the suite ran (regardless of pass rate), 2 if no
 * cases matched / a fatal harness error. The score is the signal, not
 * the exit code — a 0.0 score is still a successful measurement.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import * as path from "node:path";

const CASES_DIR = path.join(__dirname, "cases");
const RESULTS_DIR = path.join(__dirname, "results");
const RUN_TS = path.join(__dirname, "run.ts");

// SUITE.md weights. Keep in sync with the formula in that doc — if the
// doc changes, change here and cite the commit in the bench summary.
const TIER_WEIGHTS: Record<string, number> = {
  T1: 0.1,
  T2: 0.2,
  T3: 0.15,
  T4: 0.4,
  T5: 0.15,
};

interface Args {
  dryRun: boolean;
  noSetup: boolean;
  onlyTier?: string;
  cases?: string[];
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const a: Args = { dryRun: false, noSetup: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") a.dryRun = true;
    else if (arg === "--no-setup") a.noSetup = true;
    else if (arg === "--only") a.onlyTier = (argv[++i] ?? "").toUpperCase();
    else if (arg === "--cases")
      a.cases = (argv[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
  }
  return a;
}

/** Read just enough of a case's YAML frontmatter to learn its id +
 *  tier. Deliberately NOT a full parser — run.ts owns real parsing;
 *  this only needs two scalar fields to group the suite. */
function readCaseMeta(file: string): { id: string; tier: string } {
  const raw = readFileSync(path.join(CASES_DIR, file), "utf-8");
  let id = path.basename(file, ".md");
  let tier = "";
  if (raw.startsWith("---\n")) {
    const end = raw.indexOf("\n---", 4);
    const fm = raw.slice(4, end < 0 ? undefined : end);
    for (const line of fm.split("\n")) {
      const m = line.match(/^(task_id|id|tier)\s*:\s*(.+?)\s*$/);
      if (!m) continue;
      if (m[1] === "tier") tier = m[2]!.toUpperCase();
      else id = m[2]!;
    }
  }
  // Legacy cases (bulbasaur, calculator) have no `tier:` — infer from
  // a `tN-` id prefix; anything else is "UNTIERED" (reported but
  // excluded from the weighted score so it can't inflate it).
  if (!tier) {
    const pm = id.match(/^t([1-5])-/i);
    tier = pm ? `T${pm[1]}` : "UNTIERED";
  }
  return { id, tier };
}

interface CaseResult {
  id: string;
  tier: string;
  verdict: "PASS" | "FAIL" | "UNKNOWN" | "ERROR";
  exitCode: number;
}

function runCase(id: string, args: Args): CaseResult {
  const flags: string[] = [id];
  if (args.dryRun) flags.push("--dry-run");
  if (args.noSetup) flags.push("--no-setup");
  const r = spawnSync("npx", ["tsx", RUN_TS, ...flags], {
    stdio: "inherit",
    env: process.env,
  });
  // run.ts contract: exit 0 = PASS, 1 = FAIL, 2 = UNKNOWN (scorer
  // emitted no verdict line). A null status means the process was
  // killed / spawn failed → ERROR (not counted in pass-rate denominator
  // because it's a harness fault, not a model fault).
  const code = r.status ?? -1;
  const verdict =
    code === 0 ? "PASS" : code === 1 ? "FAIL" : code === 2 ? "UNKNOWN" : "ERROR";
  return { id, tier: "", verdict, exitCode: code };
}

function main(): number {
  const args = parseArgs();
  if (!existsSync(CASES_DIR)) {
    console.error(`no cases dir at ${CASES_DIR}`);
    return 2;
  }
  const files = readdirSync(CASES_DIR).filter((f) => f.endsWith(".md"));
  let metas = files.map((f) => readCaseMeta(f));
  if (args.onlyTier) metas = metas.filter((m) => m.tier === args.onlyTier);
  if (args.cases) metas = metas.filter((m) => args.cases!.includes(m.id));
  if (metas.length === 0) {
    console.error(
      `no cases matched (onlyTier=${args.onlyTier ?? "-"} cases=${args.cases?.join(",") ?? "-"})`,
    );
    return 2;
  }

  console.log(
    `\n=== Ponder suite — ${metas.length} case(s)${args.dryRun ? " [dry-run]" : ""} ===\n`,
  );
  const results: CaseResult[] = [];
  for (const m of metas) {
    console.log(`\n>>> [${m.tier}] ${m.id}\n`);
    const res = runCase(m.id, args);
    res.tier = m.tier;
    results.push(res);
  }

  // Per-tier pass rate. Denominator = PASS + FAIL + UNKNOWN (a scored
  // run, even if the scorer couldn't decide). ERROR (harness fault)
  // is excluded — it measures our infra, not the agent.
  const tiers = [...new Set(results.map((r) => r.tier))].sort();
  const tierStats: Record<
    string,
    { pass: number; scored: number; rate: number }
  > = {};
  for (const t of tiers) {
    const inTier = results.filter((r) => r.tier === t);
    const scored = inTier.filter((r) => r.verdict !== "ERROR").length;
    const pass = inTier.filter((r) => r.verdict === "PASS").length;
    tierStats[t] = { pass, scored, rate: scored > 0 ? pass / scored : 0 };
  }

  // Weighted score. Only the 5 official tiers count; UNTIERED is
  // reported but never folded in (it would otherwise let a legacy
  // Chrome case move the OS-suite headline number).
  let score = 0;
  const coverageGaps: string[] = [];
  for (const [tier, weight] of Object.entries(TIER_WEIGHTS)) {
    const st = tierStats[tier];
    if (!st || st.scored === 0) {
      coverageGaps.push(tier);
      continue;
    }
    score += weight * st.rate;
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("SUITE SUMMARY");
  console.log("=".repeat(60));
  for (const t of tiers) {
    const st = tierStats[t];
    const w = TIER_WEIGHTS[t];
    console.log(
      `  ${t.padEnd(9)} ${st.pass}/${st.scored} pass` +
        ` (${Math.round(st.rate * 100)}%)` +
        (w ? `  weight ${w}` : `  [not scored — outside SUITE.md tiers]`),
    );
  }
  if (coverageGaps.length) {
    console.log(
      `\n  ⚠ coverage gaps (0 cases, contributed 0 to score): ${coverageGaps.join(", ")}`,
    );
  }
  console.log(
    `\n  ponder_score = ${score.toFixed(4)}` +
      `  (max achievable now = ${(
        Object.entries(TIER_WEIGHTS)
          .filter(([t]) => tierStats[t] && tierStats[t]!.scored > 0)
          .reduce((s, [, w]) => s + w, 0)
      ).toFixed(2)} until coverage gaps are filled)`,
  );
  console.log("=".repeat(60));

  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = path.join(RESULTS_DIR, `suite-${stamp}.json`);
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        ran_at: new Date().toISOString(),
        dry_run: args.dryRun,
        ponder_score: Number(score.toFixed(4)),
        tier_weights: TIER_WEIGHTS,
        tier_stats: tierStats,
        coverage_gaps: coverageGaps,
        cases: results,
      },
      null,
      2,
    ),
    "utf-8",
  );
  console.log(`\n[suite] results: ${outPath}\n`);
  return 0;
}

process.exit(main());
