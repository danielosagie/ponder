/**
 * BrowserJobsConsumer — the holo3-agent (Ponder) desktop consumer of the
 * sssync-bknd Convex `browserJobs` queue.
 *
 * Flow per job (mirrors the proven anorha-local consumer, executor swapped
 * for Ponder):
 *   subscribe browserJobs:getRetryable({userId})  →  for each new job:
 *     startJob  →  executor.execute(job)  →  completeJob | failJob  →  reconcile
 *
 * Convex functions are addressed by string (public, no auth token — same as
 * the anorha-local consumer), so the Convex client is loosely typed.
 */

import { ConvexClient } from "convex/browser";
import type { BrowserJobsConfig } from "./config.js";
import type { BrowserJob, BrowserJobExecutionResult } from "./ponder-executor.js";
import {
  isWriteJob,
  frictionForWriteResult,
  BRIDGE_NOT_REACHABLE_MARKER,
} from "./ponder-executor.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export interface JobExecutor {
  execute(job: BrowserJob): Promise<BrowserJobExecutionResult>;
}

export interface ConsumerEvents {
  log?: (msg: string) => void;
}

export class BrowserJobsConsumer {
  private readonly config: BrowserJobsConfig;
  private readonly executor: JobExecutor;
  private readonly workerType = "holo3_ponder";
  private readonly log: (msg: string) => void;

  // Loosely typed: Convex's typed API expects FunctionReference objects, but
  // we address deployed functions by string name (the queue lives in another
  // repo's Convex deployment). The anorha-local consumer does the same.
  private client: any = null;
  private unsubscribe: (() => void) | null = null;
  private running = false;
  private pendingCount = 0;
  private lastError: string | null = null;

  private processingQueue: Promise<void> = Promise.resolve();
  private readonly inFlight = new Set<string>();
  private readonly scheduled = new Set<string>();

  // ── FB account-safety state (in-memory; v1 — clears on restart) ────────
  // Rolling write timestamps (ms), pruned to the 24h window on each access;
  // 1h and 24h counts are derived by filtering. consecutiveWriteFails drives
  // the breaker alongside friction-phrase detection. breakerTripped pauses
  // ALL future writes (reads continue) until an explicit reset. The *Alerted
  // flags throttle the loud one-time logs so we don't spam every deferral.
  private writeTimestamps: number[] = [];
  private consecutiveWriteFails = 0;
  private breakerTripped = false;
  private breakerReason: string | null = null;
  private cappedAlerted = false;
  private breakerAlerted = false;

  // ── Cap-defer liveness (GAP 3) ─────────────────────────────────────────
  // A cap-deferred write leaves the job UNTOUCHED in Convex 'pending'. The
  // getRetryable subscription only re-fires on a result-set CHANGE, so a job
  // that was deferred is NOT re-pulled when the rolling window later clears.
  // To make deferred writes actually resume, we arm a lightweight periodic
  // tick (config.deferRecheckMs; 0 disables) the FIRST time we cap-defer; the
  // tick re-polls getRetryable and re-runs handleJobs over the current pending
  // set. cappedDeferPending tracks whether any write is currently parked on a
  // cap so the tick can self-disarm once nothing is waiting. The tick NEVER
  // runs while the breaker is tripped (those defers are intentional perma-
  // blocks until an explicit reset — see processJob's breaker gate).
  private cappedDeferPending = false;
  private deferRecheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: BrowserJobsConfig, executor: JobExecutor, events?: ConsumerEvents) {
    this.config = config;
    this.executor = executor;
    this.log = events?.log ?? ((msg) => console.log(`[browser-jobs] ${msg}`));
  }

  start(): void {
    if (!this.config.convexURL || !this.config.userId) {
      throw new Error(
        "browser-jobs consumer not configured: need convexURL + userId (env or bootstrap).",
      );
    }
    if (this.unsubscribe) return; // already started

    // Feature D escape hatch: clear any tripped breaker / counters on launch
    // when the operator sets PONDER_FRICTION_BREAKER_RESET=1 for one run.
    if (String(process.env.PONDER_FRICTION_BREAKER_RESET || "").trim() === "1") {
      this.resetBreaker();
    }

    this.client = new ConvexClient(this.config.convexURL);
    this.running = true;
    this.log(
      `subscribed to browserJobs for user=${this.config.userId} worker=${this.config.workerId} via ${this.config.convexURL}`,
    );
    this.unsubscribe = this.client.onUpdate(
      "browserJobs:getRetryable",
      { userId: this.config.userId },
      (jobs: BrowserJob[]) => {
        void this.handleJobs(Array.isArray(jobs) ? jobs : []);
      },
      (err: unknown) => {
        this.lastError = err instanceof Error ? err.message : String(err);
        this.log(`subscription error: ${this.lastError}`);
      },
    );
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.stopDeferRecheck();
    try {
      this.client?.close?.();
    } catch {
      /* ignore */
    }
    this.client = null;
    this.running = false;
  }

  status() {
    const now = Date.now();
    const recent = this.writeTimestamps.filter((t) => now - t < DAY_MS);
    const writesLastHour = recent.filter((t) => now - t < HOUR_MS).length;
    const writesLastDay = recent.length;
    return {
      running: this.running,
      convexURL: this.config.convexURL,
      userId: this.config.userId,
      workerId: this.config.workerId,
      pendingCount: this.pendingCount,
      inFlight: this.inFlight.size,
      backendSyncConfigured: Boolean(this.config.syncBaseURL && this.config.syncToken),
      lastError: this.lastError,
      // FB account-safety surfacing (CLI / Electron).
      breakerTripped: this.breakerTripped,
      breakerReason: this.breakerReason,
      writesLastHour,
      writesLastDay,
      hourlyCap: this.config.writeHourlyCap,
      dailyCap: this.config.writeDailyCap,
    };
  }

  /**
   * Feature D — explicit breaker reset. Clears the tripped breaker, its reason,
   * the consecutive-fail counter, and the one-time alert throttles. Wire to a
   * CLI subcommand / Electron control. (Restarting the consumer also clears
   * this in-memory state — see the field comment.)
   */
  resetBreaker(): void {
    this.breakerTripped = false;
    this.breakerReason = null;
    this.consecutiveWriteFails = 0;
    this.cappedAlerted = false;
    this.breakerAlerted = false;
    this.log("[safety] breaker reset — write jobs will resume");
    // GAP C: a RUNTIME reset while writes are cap-parked must re-arm the defer
    // tick — recheckDeferred() disarms whenever the breaker is tripped, so any
    // in-flight tick stopped when the breaker went up. If writes are still
    // parked on a cap, re-arm so they actually resume (startDeferRecheck is
    // idempotent and a no-op when deferRecheckMs<=0).
    if (this.cappedDeferPending) this.startDeferRecheck();
  }

  // ── Cap-defer liveness (GAP 3) ──────────────────────────────────────────
  /** Arm the periodic re-check tick (idempotent). Called the first time a write
   *  is cap-deferred. No-op when disabled (deferRecheckMs<=0) or already armed.
   *  The tick re-polls getRetryable and re-runs handleJobs so deferred writes
   *  resume once back under the rolling cap. It self-disarms when nothing is
   *  parked on a cap, and skips entirely while the breaker is tripped. */
  private startDeferRecheck(): void {
    if (this.deferRecheckTimer) return;
    const interval = this.config.deferRecheckMs;
    if (!Number.isFinite(interval) || interval <= 0) return; // disabled
    this.deferRecheckTimer = setInterval(() => {
      void this.recheckDeferred();
    }, interval);
    // Don't keep the process alive solely for this timer (Node only).
    (this.deferRecheckTimer as { unref?: () => void })?.unref?.();
  }

  /** Disarm the re-check tick (idempotent). Called from stop() and when there's
   *  nothing left parked on a cap. */
  private stopDeferRecheck(): void {
    if (this.deferRecheckTimer) {
      clearInterval(this.deferRecheckTimer);
      this.deferRecheckTimer = null;
    }
  }

  /** One tick: if a cap-deferred write is waiting and we're not breaker-tripped,
   *  re-poll getRetryable once and re-run the handler over the current pending
   *  set so under-cap writes resume. Disarms when there's nothing to resume
   *  (no parked write) or the breaker is now tripped (intentional perma-block).
   *  Best-effort and non-busy: a single one-shot query per tick, never a loop. */
  private async recheckDeferred(): Promise<void> {
    // Nothing parked, or breaker now blocks all writes → disarm and stop ticking.
    if (!this.cappedDeferPending || this.breakerTripped || !this.running || !this.client) {
      this.stopDeferRecheck();
      return;
    }
    // If we're already under the caps again, optimistically clear the parked
    // flag; handleJobs below will re-defer (and re-arm) if still over.
    const { hour, day } = this.writeCounts();
    if (hour < this.config.writeHourlyCap && day < this.config.writeDailyCap) {
      this.cappedDeferPending = false;
    }
    try {
      const jobs = (await this.client.query("browserJobs:getRetryable", {
        userId: this.config.userId,
      })) as BrowserJob[] | null;
      await this.handleJobs(Array.isArray(jobs) ? jobs : []);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.log(`[safety] defer re-check error: ${this.lastError}`);
    }
  }

  /** Prune the rolling write log to the 24h window and return {hour, day}. */
  private writeCounts(now = Date.now()): { hour: number; day: number } {
    this.writeTimestamps = this.writeTimestamps.filter((t) => now - t < DAY_MS);
    const hour = this.writeTimestamps.filter((t) => now - t < HOUR_MS).length;
    return { hour, day: this.writeTimestamps.length };
  }

  /** Trip the circuit breaker once, with a LOUD one-time alert. Reads continue;
   *  future writes are blocked at the defer gate until an explicit reset. */
  private tripBreaker(reason: string): void {
    if (!this.breakerTripped) {
      this.breakerTripped = true;
      this.breakerReason = reason;
    }
    if (!this.breakerAlerted) {
      this.breakerAlerted = true;
      this.log(
        `[safety] ⚠ CIRCUIT BREAKER TRIPPED — ${reason}. ` +
          "PAUSING all Facebook write jobs (reads still run). " +
          "Open Facebook and check your account manually, then reset " +
          "(restart the consumer, run the reset, or set PONDER_FRICTION_BREAKER_RESET=1).",
      );
    }
  }

  private async handleJobs(jobs: BrowserJob[]): Promise<void> {
    this.pendingCount = jobs.length;
    const sorted = [...jobs].sort(
      (a, b) => Number(a?.queuedAt || 0) - Number(b?.queuedAt || 0),
    );
    for (const job of sorted) {
      if (!job?._id || this.inFlight.has(job._id) || this.scheduled.has(job._id)) continue;
      this.scheduled.add(job._id);
      // Serialize: the desktop drives ONE Chrome session, so jobs must not
      // run concurrently (matches the anorha-local + agent_do mutex model).
      this.processingQueue = this.processingQueue
        .catch(() => undefined)
        .then(async () => {
          this.inFlight.add(job._id);
          try {
            await this.processJob(job);
          } finally {
            this.inFlight.delete(job._id);
            this.scheduled.delete(job._id);
          }
        });
    }
  }

  private async processJob(job: BrowserJob): Promise<void> {
    const isWrite = isWriteJob(job);

    // ── DEFER GATE (Features B + C enforcement) ─────────────────────────
    // MUST run before startJob: startJob (sssync-bknd browserJobs.ts:178) does
    // attemptCount+1 and failJob (browserJobs.ts:223-230) dead-letters once
    // attemptCount>=maxAttempts(=3) with a 5–60s backoff. Deferring via failJob
    // would BURN attempts and permanently fail the job after 3 windows. RETURN
    // here leaves the job UNTOUCHED in Convex 'pending' — attemptCount is not
    // incremented. DO NOT move startJob above this gate. Reads bypass entirely.
    if (isWrite) {
      // (1) Breaker open → block every future write, do not start/fail/execute.
      if (this.breakerTripped) {
        this.log(
          `[safety] defer ${job._id} (${job.type}) — breaker tripped` +
            `${this.breakerReason ? `: ${this.breakerReason}` : ""}. Left pending.`,
        );
        return;
      }
      // (2) Rolling velocity caps → defer (leave pending, do NOT block-sleep).
      const { hour, day } = this.writeCounts();
      const overHour = hour >= this.config.writeHourlyCap;
      const overDay = day >= this.config.writeDailyCap;
      if (overHour || overDay) {
        if (!this.cappedAlerted) {
          this.cappedAlerted = true;
          const which = overHour
            ? `hourly cap (${hour}/${this.config.writeHourlyCap} in 1h)`
            : `daily cap (${day}/${this.config.writeDailyCap} in 24h)`;
          this.log(
            `[safety] ⚠ write velocity ${which} reached — DEFERRING further ` +
              "Facebook write jobs (left pending). The getRetryable subscription " +
              "only re-fires on a result-set change, so deferred writes are resumed " +
              "by a periodic re-check tick once the rolling window clears. " +
              "Reads are unaffected.",
          );
        }
        this.log(`[safety] defer ${job._id} (${job.type}) — over write cap. Left pending.`);
        // GAP 3: a cap-deferred write would otherwise stall forever (the sub
        // won't re-fire for an unchanged job). Mark it parked and arm the
        // periodic re-check so it resumes when the window rolls.
        this.cappedDeferPending = true;
        this.startDeferRecheck();
        return;
      }
      // Back under the caps → allow the next cap alert to fire again later and
      // mark nothing parked (the re-check tick self-disarms on its next pass).
      this.cappedAlerted = false;
      this.cappedDeferPending = false;
    }

    // ── Feature A: human-like jitter BEFORE the job runs ────────────────
    // Writes: randomized [writeMinGapMs, writeMaxGapMs] pause (seconds-scale).
    // Reads: none, or a tiny [0, readJitterMaxMs] if configured (default 0).
    if (isWrite) {
      const lo = Math.max(0, this.config.writeMinGapMs);
      const hi = Math.max(lo, this.config.writeMaxGapMs);
      const delay = lo + Math.floor(Math.random() * (hi - lo + 1));
      if (delay > 0) {
        this.log(`[safety] pacing ${job._id} (${job.type}) — pausing ${delay}ms before write`);
        await sleep(delay);
      }
    } else if (this.config.readJitterMaxMs > 0) {
      await sleep(Math.floor(Math.random() * (this.config.readJitterMaxMs + 1)));
    }

    this.log(`claim ${job._id} type=${job.type} platform=${job.platform}`);
    let didAttemptExecute = false;
    try {
      await this.client.mutation("browserJobs:startJob", {
        jobId: job._id,
        workerId: this.config.workerId,
        workerType: this.workerType,
      });

      didAttemptExecute = true;
      const outcome = await this.executor.execute(job);

      // Feature B record: count a write toward the velocity cap when the
      // executor actually reached Facebook (success OR a real FB-side failure).
      // GAP B fix: a BRIDGE_NOT_REACHABLE result (Ponder app closed / laptop
      // shut) means FB NEVER saw the attempt, so it must NOT burn cap budget —
      // same guard the fail-streak uses below. Done right after execute returns
      // so a failed-but-actually-attempted write still counts. Reads never count.
      const bridgeDown =
        !outcome.success && (outcome.error || "").includes(BRIDGE_NOT_REACHABLE_MARKER);
      if (isWrite && !bridgeDown) this.writeTimestamps.push(Date.now());

      if (!outcome.success) {
        throw Object.assign(new Error(outcome.error || "Browser job failed"), {
          requiresHuman: outcome.requiresHuman === true,
          artifacts: outcome.artifacts || [],
          result: outcome.result,
        });
      }

      await this.client.mutation("browserJobs:completeJob", {
        jobId: job._id,
        result: outcome.result || {},
        artifacts: outcome.artifacts || [],
        requiresHuman: outcome.requiresHuman === true,
        workerId: this.config.workerId,
      });
      this.log(`done ${job._id}`);

      // Feature C on a CLEAN success: FB friction can ride a nominally-ok
      // payload (e.g. a "we limit how often…" banner over a 200), so scan the
      // result text and trip the breaker even though the job "succeeded".
      if (isWrite) {
        // GAP A (round-3): non-mutating friction attribution. Builds a plain-text
        // haystack from the outcome's string leaves + error, detects a friction
        // phrase, then suppresses it only if the WHOLE phrase is present in the
        // user's own goal/payload (so a benign "Captcha Solver" title can't
        // trip, while a genuine on-page "unusual activity" ban — even when the
        // user's title is the single word "activity" — still trips).
        const friction = frictionForWriteResult(outcome, job);
        if (friction) {
          this.tripBreaker(`Facebook friction signal on a successful write: "${friction}"`);
        } else {
          this.consecutiveWriteFails = 0; // a clean write resets the fail streak
        }
      }
      await this.reconcileWithBackend(job);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const requiresHuman =
        (error as { requiresHuman?: boolean })?.requiresHuman === true ||
        /consent|required|captcha|login|pair|approval|human/i.test(message);
      const artifacts = Array.isArray((error as { artifacts?: unknown[] })?.artifacts)
        ? (error as { artifacts?: unknown[] }).artifacts
        : [];

      // ── Feature C: failure handling (WRITES only) ─────────────────────
      if (isWrite) {
        // GUARD: a "bridge not reachable" result is INFRA (closed laptop / app
        // not open), NOT FB friction — it must not trip the breaker or count
        // toward the consecutive-fail streak.
        const isBridgeDown = message.includes(BRIDGE_NOT_REACHABLE_MARKER);
        if (!isBridgeDown) {
          // GAP A (round-3): non-mutating friction attribution over a synthesized
          // failure outcome (the thrown error carries the original executor
          // result on `.result`). A benign user-supplied title/description in the
          // error/result transcript can't perma-trip the breaker, while genuine
          // on-page FB friction still does.
          const friction = frictionForWriteResult(
            {
              success: false,
              error: message,
              result: (error as { result?: Record<string, unknown> })?.result,
            },
            job,
          );
          if (friction) {
            this.tripBreaker(`Facebook friction signal on a failed write: "${friction}"`);
          }
          this.consecutiveWriteFails += 1;
          if (this.consecutiveWriteFails >= this.config.frictionBreakConsecutiveFails) {
            this.tripBreaker(
              `${this.consecutiveWriteFails} consecutive Facebook write failures`,
            );
          }
        }
      }

      this.lastError = message;
      this.log(`fail ${job._id}: ${message}${requiresHuman ? " (requires human)" : ""}`);
      // Still report THIS job's real failure (the breaker only blocks FUTURE
      // writes). didAttemptExecute is informational for the count decision above.
      void didAttemptExecute;
      await this.client.mutation("browserJobs:failJob", {
        jobId: job._id,
        errorMessage: message,
        requiresHuman,
        artifacts,
        workerId: this.config.workerId,
      });
      await this.reconcileWithBackend(job);
    }
  }

  private async reconcileWithBackend(job: BrowserJob): Promise<void> {
    if (!this.config.syncBaseURL || !this.config.syncToken || !job.agentSessionId) return;
    try {
      const res = await fetch(
        `${this.config.syncBaseURL.replace(/\/+$/, "")}/api/agent/sessions/${encodeURIComponent(
          job.agentSessionId,
        )}/browser-jobs/${encodeURIComponent(job._id)}/reconcile`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.syncToken}`,
            "Content-Type": "application/json",
          },
        },
      );
      if (!res.ok) {
        this.log(`reconcile ${job._id} failed (${res.status})`);
      }
    } catch (error) {
      this.log(
        `reconcile ${job._id} error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
