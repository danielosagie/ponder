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
    try {
      this.client?.close?.();
    } catch {
      /* ignore */
    }
    this.client = null;
    this.running = false;
  }

  status() {
    return {
      running: this.running,
      convexURL: this.config.convexURL,
      userId: this.config.userId,
      workerId: this.config.workerId,
      pendingCount: this.pendingCount,
      inFlight: this.inFlight.size,
      backendSyncConfigured: Boolean(this.config.syncBaseURL && this.config.syncToken),
      lastError: this.lastError,
    };
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
    this.log(`claim ${job._id} type=${job.type} platform=${job.platform}`);
    try {
      await this.client.mutation("browserJobs:startJob", {
        jobId: job._id,
        workerId: this.config.workerId,
        workerType: this.workerType,
      });

      const outcome = await this.executor.execute(job);
      if (!outcome.success) {
        throw Object.assign(new Error(outcome.error || "Browser job failed"), {
          requiresHuman: outcome.requiresHuman === true,
          artifacts: outcome.artifacts || [],
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
      await this.reconcileWithBackend(job);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const requiresHuman =
        (error as { requiresHuman?: boolean })?.requiresHuman === true ||
        /consent|required|captcha|login|pair|approval|human/i.test(message);
      const artifacts = Array.isArray((error as { artifacts?: unknown[] })?.artifacts)
        ? (error as { artifacts?: unknown[] }).artifacts
        : [];

      this.lastError = message;
      this.log(`fail ${job._id}: ${message}${requiresHuman ? " (requires human)" : ""}`);
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
