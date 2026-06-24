/**
 * Head-to-head: our engine driving a NO-EXTENSION Chrome, two brain modes.
 *
 *   Mode A "split"      — Gemini-flash plans + Holo 3.1 grounds (composite, today's default)
 *   Mode B "holo-e2e"   — Holo 3.1 does BOTH plan + ground (the HoloTab/Surfer-H approach)
 *
 * Same task, same Chrome (launched by us with --remote-debugging-port + a
 * dedicated Anorha profile — no extension, no gesture). Measures wall-clock,
 * step count, grounding calls, and outcome.
 *
 * Run:  node_modules/.bin/tsx bench/headtohead.ts ["task..."] [--mode=split|holo-e2e|both]
 */
import { config as loadEnv } from "dotenv";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
loadEnv({ path: path.join(__dirname, "..", ".env") });

const PROFILE = path.join(os.homedir(), ".anorha", "bench-profile");
const PORT = 9333;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TASK =
  process.argv.find((a) => !a.startsWith("--") && a.includes(" ")) ??
  "Go to news.ycombinator.com and tell me the exact title of the #1 story.";
const MODE = (process.argv.find((a) => a.startsWith("--mode="))?.split("=")[1] ?? "both") as
  | "split"
  | "holo-e2e"
  | "both";

function log(s: string): void {
  process.stdout.write(s + "\n");
}

async function waitForPort(port: number, ms = 15000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function launchChrome(startUrl: string): ChildProcess {
  fs.mkdirSync(PROFILE, { recursive: true });
  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    "--new-window",
    startUrl,
  ];
  const cp = spawn(CHROME, args, { stdio: "ignore", detached: false });
  return cp;
}

interface RunMetrics {
  mode: string;
  outcome: string;
  ms: number;
  steps: number;
  grounds: number;
  actions: string[];
  answer: string | null;
  error: string | null;
}

async function runMode(mode: "split" | "holo-e2e", task: string): Promise<RunMetrics> {
  // Toggle the planner: split => keep composite (Gemini plans); holo-e2e =>
  // PONDER_PLANNER=off so Holo 3.1 plans AND grounds.
  if (mode === "holo-e2e") process.env.PONDER_PLANNER = "off";
  else delete process.env.PONDER_PLANNER;

  const { makeProvider } = await import("../src/agent/factory");
  const { runTask } = await import("../src/agent/loop");
  const { createPlaywriterClient } = await import("../src/agent/browser/playwriter");

  const provider = makeProvider("hcompany");
  log(`\n▶ Mode "${mode}" — provider=${provider.name}`);
  try {
    await provider.warm();
  } catch (e) {
    log(`  (warm warning: ${e instanceof Error ? e.message : String(e)})`);
  }

  const browser = await createPlaywriterClient({ cdpUrl: `http://127.0.0.1:${PORT}` });
  let ok = false;
  for (let i = 0; i < 5 && !ok; i++) {
    ok = await browser.available();
    if (!ok) await new Promise((r) => setTimeout(r, 800));
  }
  log(`  browser.available() = ${ok}`);
  if (!ok) {
    return {
      mode, outcome: "no-browser", ms: 0, steps: 0, grounds: 0,
      actions: [], answer: null, error: "browser never became available",
    };
  }

  const m: RunMetrics = {
    mode,
    outcome: "error",
    ms: 0,
    steps: 0,
    grounds: 0,
    actions: [],
    answer: null,
    error: null,
  };
  const t0 = Date.now();
  const deadline = t0 + 120_000;
  const events = {
    onThought: () => {},
    onGround: (_c: { x: number; y: number }) => {
      m.grounds++;
    },
    onAction: (a: { type: string; payload: Record<string, unknown> }) => {
      m.steps++;
      m.actions.push(a.type);
    },
    onScreenshot: () => {},
    onError: (msg: string) => {
      m.error = msg;
    },
    onStatus: () => {},
    onResult: (text: string) => {
      m.answer = text;
    },
  };

  try {
    const outcome = await runTask({
      task,
      provider,
      events,
      browser,
      router: null,
      shouldCancel: () => Date.now() > deadline,
    } as never);
    m.outcome = String(outcome);
  } catch (e) {
    m.error = e instanceof Error ? e.message : String(e);
  }
  m.ms = Date.now() - t0;
  await browser.close().catch(() => {});
  log(
    `  → ${m.outcome} in ${(m.ms / 1000).toFixed(1)}s · ${m.steps} steps · ${m.grounds} grounds`,
  );
  if (m.answer) log(`  answer: ${m.answer.slice(0, 200)}`);
  if (m.error) log(`  error: ${m.error.slice(0, 200)}`);
  return m;
}

async function main(): Promise<void> {
  log("── Head-to-head: no-extension Chrome, brain modes ──");
  log(`task: ${TASK}`);
  const cp = launchChrome("https://example.com");
  const up = await waitForPort(PORT);
  log(`chrome --remote-debugging-port=${PORT} ready: ${up}`);
  if (!up) {
    log("Chrome CDP endpoint never came up — aborting.");
    cp.kill();
    process.exit(1);
  }

  const modes: Array<"split" | "holo-e2e"> =
    MODE === "both" ? ["split", "holo-e2e"] : [MODE];
  const results: RunMetrics[] = [];
  for (const mode of modes) {
    results.push(await runMode(mode, TASK));
  }

  log("\n── RESULTS ──");
  log("mode       outcome    time     steps  grounds  answer");
  for (const r of results) {
    log(
      `${r.mode.padEnd(10)} ${r.outcome.padEnd(10)} ${(r.ms / 1000).toFixed(1).padStart(5)}s   ${String(r.steps).padStart(4)}   ${String(r.grounds).padStart(5)}    ${(r.answer ?? r.error ?? "").slice(0, 60)}`,
    );
  }

  cp.kill();
  process.exit(0);
}

main().catch((e) => {
  log(`FATAL: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
