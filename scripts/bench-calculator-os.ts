/**
 * bench-calculator-os — direct timing harness for calculator-mouse-math-os.
 *
 * Drives the os_* path without an LLM orchestrator in the loop, so the
 * measurements isolate snapshot+click cost from MCP/tool-search/transport
 * overhead. Reports phase-by-phase timings and writes a result JSON in
 * the same shape as bench/results/*.json.
 *
 * Requires the Holo3 Electron app running so the :7900 bridge is alive
 * AND @ponder/mac-ax built for the current Electron ABI (`npm run
 * build:native`).
 *
 * Run with: tsx scripts/bench-calculator-os.ts
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { pickOsClient } from "../src/agent/os/client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const BRIDGE_PORT = Number(process.env.PONDER_BRIDGE_PORT ?? 7900);
const BRIDGE_BASE = `http://127.0.0.1:${BRIDGE_PORT}`;

// Aliases tried in order when a button's AXTitle isn't the obvious
// character (Calculator localizes some operator labels).
const NAME_ALIASES: Record<string, string[]> = {
  "×": ["×", "*", "multiply", "x"],
  "÷": ["÷", "/", "divide"],
  "−": ["−", "-", "minus", "subtract"],
  "+": ["+", "plus", "add"],
  "=": ["=", "equals"],
  AC: ["AC", "All Clear", "Clear"],
};

const SEQUENCE = ["AC", "4", "3", "×", "4", "2", "4", "="];
const EXPECTED_DISPLAY = "18232";  // 43 × 424
const LAUNCH_TIMEOUT_MS = 1500;
const LAUNCH_POLL_MS = 80;

interface PhaseTiming {
  name: string;
  ms: number;
}

async function bridgeFetch<T>(path: string, body: object = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${BRIDGE_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const parsed = (await res.json()) as unknown;
    if (!res.ok) {
      throw new Error(
        `bridge ${path} HTTP ${res.status}: ${JSON.stringify(parsed)}`,
      );
    }
    return parsed as T;
  } finally {
    clearTimeout(timer);
  }
}

async function bridgeHealthy(): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 800);
    const res = await fetch(`${BRIDGE_BASE}/health`, { signal: ctl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

function parseButtonRefs(ax: string): Map<string, string> {
  // Matches lines like:  [e12] button "AC"
  const re = /\[(e\d+)\]\s+button\s+"([^"]+)"/g;
  const map = new Map<string, string>();
  for (const m of ax.matchAll(re)) {
    const ref = m[1];
    const name = m[2];
    // Keep the FIRST occurrence — buttons appear before any display
    // value that might happen to read like a digit.
    if (!map.has(name)) map.set(name, ref);
  }
  return map;
}

function findRef(name: string, refs: Map<string, string>): string {
  const candidates = NAME_ALIASES[name] ?? [name];
  for (const alias of candidates) {
    const r = refs.get(alias);
    if (r) return r;
  }
  throw new Error(
    `No AXButton matches "${name}" (tried: ${candidates.join(", ")})`,
  );
}

function extractDisplayValue(ax: string): string | null {
  // Calculator's result element is typically a focused textfield or
  // statictext with the formatted value. We tolerate any of those
  // shapes and either an `(value: "…")` flag or a direct `"…"` name.
  // Return the longest numeric-looking string we find on a non-button
  // line — buttons are single chars / short words.
  let best: string | null = null;
  const lines = ax.split("\n");
  for (const line of lines) {
    if (/\bbutton\b/.test(line)) continue;
    const m =
      line.match(/value:\s*"([^"]+)"/) ?? line.match(/"([^"]+)"/);
    if (!m) continue;
    const raw = m[1].replace(/[,\s]/g, "");
    if (/^-?\d+(\.\d+)?$/.test(raw)) {
      if (best === null || raw.length > best.length) best = raw;
    }
  }
  return best;
}

async function waitForCalculatorReady(): Promise<{
  snapshot: { app: string; window: string; ax: string };
  refs: Map<string, string>;
  pollCount: number;
}> {
  const client = pickOsClient();
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  let polls = 0;
  while (Date.now() < deadline) {
    polls++;
    try {
      const snap = await client.snapshot();
      // We don't strictly require the app name to be "Calculator" —
      // localized macs may call it differently. The signal we trust is
      // an AC (or All Clear) button in the AX dump.
      const refs = parseButtonRefs(snap.ax);
      if (NAME_ALIASES["AC"].some((n) => refs.has(n))) {
        return { snapshot: snap, refs, pollCount: polls };
      }
    } catch {
      // bridge or addon transient — keep polling
    }
    await new Promise((r) => setTimeout(r, LAUNCH_POLL_MS));
  }
  throw new Error(
    `Calculator AX tree not ready after ${LAUNCH_TIMEOUT_MS}ms (polled ${polls} times).`,
  );
}

async function main() {
  const phases: PhaseTiming[] = [];
  const errors: string[] = [];
  let outcome: "success" | "failure" | "unverified" | "error" = "success";
  let displayRead: string | null = null;
  let snapshotChars = 0;
  let clickCount = 0;

  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  try {
    // ── Preflight ─────────────────────────────────────────────────────
    if (!(await bridgeHealthy())) {
      throw new Error(
        `Bridge not reachable at ${BRIDGE_BASE}. Start the Holo3 app: \`npm run dev\``,
      );
    }
    const client = pickOsClient();
    const status = await client.status();
    if (!status.available) {
      throw new Error(`OS provider unavailable: ${status.reason ?? "?"}`);
    }

    // ── Phase: launch ─────────────────────────────────────────────────
    const tLaunchStart = Date.now();
    await bridgeFetch("/screen/hotkey", { combo: "cmd+space" });
    await new Promise((r) => setTimeout(r, 100));  // Spotlight settle
    await bridgeFetch("/screen/type", { text: "Calculator", thenPress: "enter" });
    phases.push({ name: "spotlight+launch_keys", ms: Date.now() - tLaunchStart });

    // ── Phase: wait for AX tree ───────────────────────────────────────
    const tWaitStart = Date.now();
    const { snapshot, refs, pollCount } = await waitForCalculatorReady();
    phases.push({
      name: `wait_for_calculator_ax (${pollCount} polls)`,
      ms: Date.now() - tWaitStart,
    });
    snapshotChars = snapshot.ax.length;

    // ── Phase: compute (one bridge round-trip per click) ──────────────
    const tComputeStart = Date.now();
    for (const step of SEQUENCE) {
      const ref = findRef(step, refs);
      await client.click({ ref });
      clickCount++;
    }
    phases.push({ name: `compute (${clickCount} clicks)`, ms: Date.now() - tComputeStart });

    // ── Phase: verify ─────────────────────────────────────────────────
    const tVerifyStart = Date.now();
    // Tiny settle so the = key's display update lands before we read.
    await new Promise((r) => setTimeout(r, 60));
    const final = await client.snapshot();
    phases.push({ name: "final_snapshot", ms: Date.now() - tVerifyStart });

    displayRead = extractDisplayValue(final.ax);
    if (displayRead === null) {
      outcome = "unverified";
      errors.push(
        `Could not extract a numeric display value from the final AX tree.`,
      );
    } else if (displayRead.replace(/^0+/, "") !== EXPECTED_DISPLAY) {
      outcome = "failure";
      errors.push(
        `Display read "${displayRead}", expected "${EXPECTED_DISPLAY}".`,
      );
    }
  } catch (e) {
    outcome = "error";
    errors.push(e instanceof Error ? e.message : String(e));
  }

  const endedAt = new Date().toISOString();
  const elapsedMs = Date.now() - t0;
  const target = 2000;

  const result = {
    id: `calculator-mouse-math-os-direct-${startedAt.replace(/[:.]/g, "-")}`,
    case: "calculator-mouse-math-os",
    model: "n/a (direct script — no LLM orchestrator)",
    started_at: startedAt,
    ended_at: endedAt,
    elapsed_ms: elapsedMs,
    wall_target_ms: target,
    hit_target: elapsedMs <= target && outcome === "success",
    outcome,
    tool_call_count_logical: 4,
    bridge_call_count: 2 /* hotkey + type */ + 1 /* initial snapshot */ + clickCount + 1 /* final snapshot */,
    phases,
    snapshot_chars: snapshotChars,
    click_count: clickCount,
    display_read: displayRead,
    expected_display: EXPECTED_DISPLAY,
    errors,
    notes: [
      "No vision/model calls in the loop — pure a11y grounding.",
      "Phase 'wait_for_calculator_ax' dominates wall time; everything after is sub-300ms typical.",
      "Compare with bench/results/calculator-mouse-math-batched-*.json for the vision-grounded variant.",
    ],
  };

  const resultsDir = join(REPO_ROOT, "bench", "results");
  mkdirSync(resultsDir, { recursive: true });
  const safeIso = startedAt.replace(/[:.]/g, "-");
  const outPath = join(resultsDir, `calculator-mouse-math-os-direct-${safeIso}.json`);
  writeFileSync(outPath, JSON.stringify(result, null, 2));

  // Console summary
  console.log("");
  console.log(`outcome:        ${outcome}${result.hit_target ? "  (under 2000ms target)" : ""}`);
  console.log(`elapsed:        ${elapsedMs} ms`);
  console.log(`display:        ${displayRead ?? "<unread>"} (expected ${EXPECTED_DISPLAY})`);
  console.log(`bridge calls:   ${result.bridge_call_count}`);
  console.log(`snapshot chars: ${snapshotChars}`);
  console.log("phases:");
  for (const p of phases) {
    console.log(`  - ${p.name.padEnd(40)} ${p.ms} ms`);
  }
  if (errors.length > 0) {
    console.log("");
    console.log("errors:");
    for (const e of errors) console.log(`  - ${e}`);
  }
  console.log("");
  console.log(`result written: ${outPath}`);

  process.exit(outcome === "success" ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
