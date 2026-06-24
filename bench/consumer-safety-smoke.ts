/**
 * Smoke: the FB account-safety WIRING inside BrowserJobsConsumer.processJob.
 *
 * This is the integration-level counterpart to friction-detector-smoke.ts
 * (which only covers the pure friction function). Here we drive the REAL
 * consumer code paths — defer gate → jitter → execute → record/scan/breaker —
 * with a MOCK executor + MOCK Convex client. NO bridge, NO Convex, NO Chrome,
 * NO Facebook. We inject the mock client onto the private `client` field and
 * flip `running` so we can call `(consumer as any).processJob(job)` directly,
 * bypassing start()/onUpdate.
 *
 * Proves the SAFETY APPLIES (not just the friction primitive):
 *   A. JITTER — writes pause >= writeMinGapMs before running; reads don't.
 *   B. CAP DEFER — at the hourly cap a write defers (executor NOT called, job
 *      left UNTOUCHED in Convex: no startJob/completeJob/failJob), no block-sleep.
 *   C. READS NOT COUNTED — reads never add to writeTimestamps, never defer.
 *   D. FRICTION BREAKER TRIPS — an on-page friction phrase (not in the payload)
 *      trips the breaker; subsequent writes are blocked; reads still run.
 *   E. BREAKER RESET — resetBreaker() lets writes run again.
 *   F. BRIDGE-DOWN EXCLUDED — BRIDGE_NOT_REACHABLE failures are infra, not
 *      friction: breaker stays down AND they don't burn cap budget.
 *   G. CONSECUTIVE-FAIL BREAKER — N generic failures in a row trip the breaker;
 *      a clean success before the Nth resets the streak.
 *
 * Run: npx tsx bench/consumer-safety-smoke.ts   →  must print PASS.
 */
import { BrowserJobsConsumer, type JobExecutor } from "../src/agent/browser-jobs/consumer";
import type { BrowserJobsConfig } from "../src/agent/browser-jobs/config";
import {
  BRIDGE_NOT_REACHABLE_MARKER,
  type BrowserJob,
  type BrowserJobExecutionResult,
} from "../src/agent/browser-jobs/ponder-executor";

let failed = false;
function check(name: string, ok: boolean): void {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${name}`);
  if (!ok) failed = true;
}

// ── Mock Convex client ──────────────────────────────────────────────────────
// processJob calls: client.mutation("browserJobs:startJob"|"completeJob"|
// "failJob", ...). recheckDeferred also calls client.query("browserJobs:
// getRetryable", ...) but the timer is disabled here (deferRecheckMs=0), and we
// call processJob directly, so query is never hit — still recorded for safety.
interface MockCall {
  fn: string;
  args: Record<string, unknown>;
}
class MockConvex {
  calls: MockCall[] = [];
  async mutation(fn: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ fn, args });
    return {};
  }
  async query(fn: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ fn, args });
    return [];
  }
  close(): void {
    /* no-op */
  }
  count(fn: string): number {
    return this.calls.filter((c) => c.fn === fn).length;
  }
}

// ── Mock executor ───────────────────────────────────────────────────────────
// Returns a controlled result and records every job it was asked to execute.
class MockExecutor implements JobExecutor {
  jobs: BrowserJob[] = [];
  next: (job: BrowserJob) => BrowserJobExecutionResult;
  constructor(next: (job: BrowserJob) => BrowserJobExecutionResult) {
    this.next = next;
  }
  async execute(job: BrowserJob): Promise<BrowserJobExecutionResult> {
    this.jobs.push(job);
    return this.next(job);
  }
  get count(): number {
    return this.jobs.length;
  }
  reset(): void {
    this.jobs = [];
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────
let jobSeq = 0;
function job(type: string, payload: Record<string, unknown> = {}): BrowserJob {
  jobSeq += 1;
  return {
    _id: `smoke-${type}-${jobSeq}`,
    userId: "smoke-user",
    orgId: "smoke-org",
    platform: "facebook_marketplace",
    type,
    payload,
  };
}

function baseConfig(overrides: Partial<BrowserJobsConfig> = {}): BrowserJobsConfig {
  return {
    convexURL: "https://smoke.convex.cloud",
    userId: "smoke-user",
    workerId: "smoke-worker",
    syncBaseURL: "",
    syncToken: "",
    bridgePort: 7900,
    // SMALL jitter so the timing assertions are fast but measurable.
    writeMinGapMs: 30,
    writeMaxGapMs: 60,
    // Generous caps by default; individual tests tighten these.
    writeHourlyCap: 100,
    writeDailyCap: 1000,
    frictionBreakConsecutiveFails: 3,
    readJitterMaxMs: 0,
    // Disable the cap-defer re-check timer so the process exits clean.
    deferRecheckMs: 0,
    ...overrides,
  };
}

/** Build a fresh consumer wired to mock client + executor, ready for direct
 *  processJob() calls (no start(), no real Convex). */
function makeConsumer(
  config: BrowserJobsConfig,
  executor: MockExecutor,
): { consumer: BrowserJobsConsumer; client: MockConvex } {
  // Silence the consumer's logs so the smoke output stays readable.
  const consumer = new BrowserJobsConsumer(config, executor, { log: () => undefined });
  const client = new MockConvex();
  (consumer as any).client = client;
  (consumer as any).running = true;
  return { consumer, client };
}

const cleanSuccess = (): BrowserJobExecutionResult => ({
  success: true,
  result: { status: "success", via: "agent", outcome: "done" },
});

async function run(): Promise<void> {
  // ── A. JITTER ─────────────────────────────────────────────────────────────
  {
    const exec = new MockExecutor(() => cleanSuccess());
    const { consumer } = makeConsumer(baseConfig(), exec);

    const tWrite0 = Date.now();
    await (consumer as any).processJob(job("create_listing", { title: "Red Bike", price: "40" }));
    const writeMs = Date.now() - tWrite0;
    check(`A1 JITTER: write paused >= writeMinGapMs (30ms) — actual ${writeMs}ms`, writeMs >= 30);

    const tRead0 = Date.now();
    await (consumer as any).processJob(job("scrape_inventory"));
    const readMs = Date.now() - tRead0;
    check(`A2 JITTER: read NOT paced (< 30ms) — actual ${readMs}ms`, readMs < 30);

    (consumer as any).stopDeferRecheck?.();
    consumer.stop();
  }

  // ── B. CAP DEFER ──────────────────────────────────────────────────────────
  {
    const exec = new MockExecutor(() => cleanSuccess());
    const { consumer, client } = makeConsumer(
      baseConfig({ writeHourlyCap: 2, writeDailyCap: 1000 }),
      exec,
    );

    await (consumer as any).processJob(job("create_listing", { title: "A" }));
    await (consumer as any).processJob(job("create_listing", { title: "B" }));
    check("B1 CAP: first 2 writes executed", exec.count === 2);
    check("B2 CAP: completeJob called twice for the 2 writes", client.count("browserJobs:completeJob") === 2);

    const startsBefore = client.count("browserJobs:startJob");
    const completesBefore = client.count("browserJobs:completeJob");
    const failsBefore = client.count("browserJobs:failJob");
    await (consumer as any).processJob(job("create_listing", { title: "C (over cap)" }));
    check("B3 CAP: 3rd write did NOT execute (count stays 2)", exec.count === 2);
    check(
      "B4 CAP: deferred write left UNTOUCHED (no new startJob/completeJob/failJob)",
      client.count("browserJobs:startJob") === startsBefore &&
        client.count("browserJobs:completeJob") === completesBefore &&
        client.count("browserJobs:failJob") === failsBefore,
    );
    check("B5 CAP: deferred write parked (cappedDeferPending)", (consumer as any).cappedDeferPending === true);
    check(
      "B6 CAP: defer returns fast (no block-sleep) — writeTimestamps still 2",
      (consumer as any).writeTimestamps.length === 2,
    );

    (consumer as any).stopDeferRecheck?.();
    consumer.stop();
  }

  // ── C. READS NOT COUNTED ──────────────────────────────────────────────────
  {
    const exec = new MockExecutor(() => cleanSuccess());
    // Tiny caps: if reads counted, they'd defer; they must not.
    const { consumer } = makeConsumer(
      baseConfig({ writeHourlyCap: 1, writeDailyCap: 1 }),
      exec,
    );

    for (let i = 0; i < 5; i++) await (consumer as any).processJob(job("scrape_inventory"));
    check("C1 READS: all 5 reads executed despite cap=1", exec.count === 5);
    check("C2 READS: writeTimestamps empty (reads never counted)", (consumer as any).writeTimestamps.length === 0);
    check("C3 READS: nothing parked on a cap", (consumer as any).cappedDeferPending === false);

    (consumer as any).stopDeferRecheck?.();
    consumer.stop();
  }

  // ── D. FRICTION BREAKER TRIPS ─────────────────────────────────────────────
  {
    // The executor returns a CLEAN success whose result text carries a REAL FB
    // friction phrase NOT present in the job payload (payload title "Red Bike").
    const exec = new MockExecutor(() => ({
      success: true,
      result: {
        status: "success",
        via: "agent",
        payload: { finalText: "Your account has been temporarily restricted" },
      },
    }));
    const { consumer } = makeConsumer(baseConfig(), exec);

    await (consumer as any).processJob(job("create_listing", { title: "Red Bike" }));
    check("D1 BREAKER: tripped after on-page friction on a successful write", (consumer as any).breakerTripped === true);

    // A subsequent write must be blocked (executor NOT called again).
    const countAfterTrip = exec.count;
    await (consumer as any).processJob(job("update_listing", { title: "Blue Bike", price: "50" }));
    check("D2 BREAKER: subsequent write BLOCKED (executor not called)", exec.count === countAfterTrip);

    // A read must STILL execute while the breaker is tripped.
    const beforeRead = exec.count;
    await (consumer as any).processJob(job("scrape_inventory"));
    check("D3 BREAKER: read still executes while breaker tripped", exec.count === beforeRead + 1);

    (consumer as any).stopDeferRecheck?.();
    consumer.stop();
  }

  // ── E. BREAKER RESET ──────────────────────────────────────────────────────
  {
    const exec = new MockExecutor(() => ({
      success: true,
      result: { payload: { finalText: "We limit how often you can post" } },
    }));
    const { consumer } = makeConsumer(baseConfig(), exec);

    await (consumer as any).processJob(job("create_listing", { title: "Red Bike" }));
    check("E1 RESET: breaker tripped (precondition)", (consumer as any).breakerTripped === true);

    // After reset, swap the executor to a clean success and confirm a write runs.
    exec.next = () => cleanSuccess();
    consumer.resetBreaker();
    check("E2 RESET: breakerTripped false after resetBreaker()", (consumer as any).breakerTripped === false);

    const before = exec.count;
    await (consumer as any).processJob(job("create_listing", { title: "Green Bike" }));
    check("E3 RESET: a write executes again after reset", exec.count === before + 1);
    check("E4 RESET: clean write did not re-trip the breaker", (consumer as any).breakerTripped === false);

    (consumer as any).stopDeferRecheck?.();
    consumer.stop();
  }

  // ── F. BRIDGE-DOWN EXCLUDED ───────────────────────────────────────────────
  {
    const exec = new MockExecutor(() => ({
      success: false,
      requiresHuman: true,
      error: `${BRIDGE_NOT_REACHABLE_MARKER} at http://127.0.0.1:7900. Open the Ponder desktop app.`,
    }));
    const { consumer } = makeConsumer(baseConfig(), exec);

    for (let i = 0; i < 4; i++) await (consumer as any).processJob(job("create_listing", { title: "Bike" }));
    check("F1 BRIDGE-DOWN: breaker NOT tripped on 4 bridge-down failures (infra, not friction)", (consumer as any).breakerTripped === false);
    check("F2 BRIDGE-DOWN: writeTimestamps empty (bridge-down does NOT burn cap)", (consumer as any).writeTimestamps.length === 0);
    check("F3 BRIDGE-DOWN: consecutiveWriteFails not incremented", (consumer as any).consecutiveWriteFails === 0);
    // The executor WAS reached each time (bridge-down is detected post-execute).
    check("F4 BRIDGE-DOWN: executor was still invoked 4x (failure reported per job)", exec.count === 4);

    (consumer as any).stopDeferRecheck?.();
    consumer.stop();
  }

  // ── G. CONSECUTIVE-FAIL BREAKER ───────────────────────────────────────────
  // Generic failure: NOT bridge-down, NOT a friction phrase. Must trip on the
  // Nth (frictionBreakConsecutiveFails=3); a clean success resets the streak.
  const genericFail = (): BrowserJobExecutionResult => ({
    success: false,
    error: "Ponder bridge 500: internal error while filling the form",
  });
  {
    // G-part 1: 3 generic failures in a row → trips on the 3rd.
    const exec = new MockExecutor(() => genericFail());
    const { consumer } = makeConsumer(baseConfig({ frictionBreakConsecutiveFails: 3 }), exec);

    await (consumer as any).processJob(job("create_listing", { title: "Bike 1" }));
    check("G1 STREAK: not tripped after 1 generic failure", (consumer as any).breakerTripped === false);
    await (consumer as any).processJob(job("create_listing", { title: "Bike 2" }));
    check("G2 STREAK: not tripped after 2 generic failures", (consumer as any).breakerTripped === false);
    await (consumer as any).processJob(job("create_listing", { title: "Bike 3" }));
    check("G3 STREAK: TRIPPED after 3rd consecutive generic failure", (consumer as any).breakerTripped === true);

    (consumer as any).stopDeferRecheck?.();
    consumer.stop();
  }
  {
    // G-part 2: fail, fail, SUCCESS (resets streak), fail, fail → NOT tripped
    // (only 2 in the new streak), then a 3rd consecutive fail → tripped.
    let mode: "fail" | "ok" = "fail";
    const exec = new MockExecutor(() => (mode === "fail" ? genericFail() : cleanSuccess()));
    const { consumer } = makeConsumer(baseConfig({ frictionBreakConsecutiveFails: 3 }), exec);

    mode = "fail";
    await (consumer as any).processJob(job("create_listing", { title: "F1" }));
    await (consumer as any).processJob(job("create_listing", { title: "F2" }));
    check("G4 RESET-STREAK: streak=2 before the success", (consumer as any).consecutiveWriteFails === 2);

    mode = "ok";
    await (consumer as any).processJob(job("create_listing", { title: "OK" }));
    check("G5 RESET-STREAK: clean success reset the streak to 0", (consumer as any).consecutiveWriteFails === 0);
    check("G6 RESET-STREAK: still not tripped after the reset", (consumer as any).breakerTripped === false);

    mode = "fail";
    await (consumer as any).processJob(job("create_listing", { title: "F3" }));
    await (consumer as any).processJob(job("create_listing", { title: "F4" }));
    check("G7 RESET-STREAK: not tripped after only 2 post-reset failures", (consumer as any).breakerTripped === false);
    await (consumer as any).processJob(job("create_listing", { title: "F5" }));
    check("G8 RESET-STREAK: TRIPPED on the 3rd consecutive post-reset failure", (consumer as any).breakerTripped === true);

    (consumer as any).stopDeferRecheck?.();
    consumer.stop();
  }

  console.log(failed ? "\n=== FAIL — consumer safety ===" : "\n=== PASS — consumer safety ===");
  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
