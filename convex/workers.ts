/**
 * Fleet routing for Ponder v1.1 (item 7).
 *
 * One Convex deployment can now drive multiple Ponder.app installations.
 * Each desktop registers itself as a `workers` row on boot, heartbeats every
 * 15s, and polls `claimNext` to atomically pull the next pending session.
 *
 * Atomicity uses Convex's per-document serialization: the claim does
 * read-then-patch on the candidate session, guarded by a `claimedBy ===
 * undefined` check. If two workers race, Convex retries one of them and the
 * loser sees `claimedBy !== undefined` on retry — no external lock needed.
 *
 * Backwards compat with v1: sessions with `claimedBy === undefined` are
 * eligible for any worker; the legacy `sessions:getActive` query (used by
 * pre-v1.1 desktop builds) still returns the first pending session, so a v1
 * desktop pointed at a v1.1 deployment keeps working as long as it's the
 * only client.
 */
import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";

const HEARTBEAT_TIMEOUT_MS = 45_000;

const PLATFORM = v.union(
  v.literal("darwin"),
  v.literal("win32"),
  v.literal("linux"),
);
const CAPABILITY = v.union(v.literal("desktop"), v.literal("headless"));
const STATUS = v.union(
  v.literal("idle"),
  v.literal("busy"),
  v.literal("offline"),
);

/**
 * Idempotent. Inserts a new workers row on first launch; updates hostname /
 * platform / capabilities / status if the worker is already known. Returns
 * the workers._id so the desktop can pass it to subsequent mutations.
 */
export const register = mutation({
  args: {
    workerId: v.string(),
    hostname: v.string(),
    platform: PLATFORM,
    capabilities: v.array(CAPABILITY),
    workspaceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("workers")
      .withIndex("by_workerId", (q) => q.eq("workerId", args.workerId))
      .first();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        hostname: args.hostname,
        platform: args.platform,
        capabilities: args.capabilities,
        workspaceId: args.workspaceId,
        lastHeartbeatAt: now,
        // Re-register clears any stale "offline" status so the worker is
        // immediately eligible to claim again.
        status: existing.status === "busy" ? "busy" : "idle",
      });
      return existing._id;
    }
    return await ctx.db.insert("workers", {
      workerId: args.workerId,
      hostname: args.hostname,
      platform: args.platform,
      capabilities: args.capabilities,
      workspaceId: args.workspaceId,
      registeredAt: now,
      lastHeartbeatAt: now,
      status: "idle",
    });
  },
});

/** Cheap mutation called every 15s by the desktop. */
export const heartbeat = mutation({
  args: {
    workerId: v.string(),
    status: v.optional(STATUS),
  },
  handler: async (ctx, args) => {
    const worker = await ctx.db
      .query("workers")
      .withIndex("by_workerId", (q) => q.eq("workerId", args.workerId))
      .first();
    if (!worker) return null;
    await ctx.db.patch(worker._id, {
      lastHeartbeatAt: Date.now(),
      ...(args.status ? { status: args.status } : {}),
    });
    return worker._id;
  },
});

/**
 * Atomically claim the next pending session matching the worker's runtime.
 * Returns the claimed session row, or null when the queue is empty / the
 * worker is offline / a race made the candidate unavailable.
 */
export const claimNext = mutation({
  args: {
    workerId: v.string(),
    runtime: v.optional(
      v.union(v.literal("desktop"), v.literal("headless")),
    ),
  },
  handler: async (ctx, args) => {
    const worker = await ctx.db
      .query("workers")
      .withIndex("by_workerId", (q) => q.eq("workerId", args.workerId))
      .first();
    if (!worker) return null;
    if (worker.status === "offline") return null;
    if (worker.currentSessionId) return null; // already running something

    const wantRuntime = args.runtime ?? "desktop";

    // Scan candidates ordered FIFO by createdAt. We can't compose a single
    // index match because runtime is optional (undefined = legacy desktop)
    // and targetWorkerId can be either set-to-this-worker or unset; iterate
    // the cheap by_created index and filter in JS. The queue is small in
    // practice (pending sessions clear within seconds).
    const candidates = await ctx.db
      .query("sessions")
      .withIndex("by_created")
      .order("asc")
      .filter((q) => q.eq(q.field("status"), "pending"))
      .take(50);

    for (const candidate of candidates) {
      const candidateRuntime = candidate.runtime ?? "desktop";
      if (candidateRuntime !== wantRuntime) continue;
      // Targeting hint: if set, it must match this worker.
      if (
        candidate.targetWorkerId !== undefined &&
        candidate.targetWorkerId !== args.workerId
      ) {
        continue;
      }
      // Workspace scoping (item 8): if both sides are set, they must match.
      if (
        candidate.workspaceId !== undefined &&
        worker.workspaceId !== undefined &&
        candidate.workspaceId !== worker.workspaceId
      ) {
        continue;
      }
      // Race guard: if another worker beat us between the take() above and
      // this iteration, skip.
      if (candidate.claimedBy !== undefined) continue;

      const claimedAt = Date.now();
      await ctx.db.patch(candidate._id, {
        status: "running",
        claimedBy: worker._id,
        claimedAt,
      });
      await ctx.db.patch(worker._id, {
        status: "busy",
        currentSessionId: candidate._id,
        lastHeartbeatAt: claimedAt,
      });
      return await ctx.db.get(candidate._id);
    }
    return null;
  },
});

/**
 * Worker reports a session as finished. Patches the session terminal status
 * and frees the worker back to "idle" so the next claimNext() returns the
 * subsequent pending session.
 */
export const releaseSession = mutation({
  args: {
    workerId: v.string(),
    sessionId: v.id("sessions"),
    status: v.union(
      v.literal("done"),
      v.literal("error"),
      v.literal("cancelled"),
    ),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const worker = await ctx.db
      .query("workers")
      .withIndex("by_workerId", (q) => q.eq("workerId", args.workerId))
      .first();
    if (!worker) return;

    const session = await ctx.db.get(args.sessionId);
    if (session && session.status !== "done" && session.status !== "cancelled") {
      await ctx.db.patch(args.sessionId, {
        status: args.status,
        endedAt: Date.now(),
        ...(args.error ? { error: args.error } : {}),
      });
    }

    await ctx.db.patch(worker._id, {
      status: "idle",
      currentSessionId: undefined,
      lastHeartbeatAt: Date.now(),
    });
  },
});

/** Read-only: list workers (for a future fleet dashboard). */
export const list = query({
  args: { workspaceId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (args.workspaceId !== undefined) {
      return await ctx.db
        .query("workers")
        .withIndex("by_workspace_status", (q) =>
          q.eq("workspaceId", args.workspaceId),
        )
        .collect();
    }
    return await ctx.db.query("workers").collect();
  },
});

/**
 * Cron-driven sweep: any worker whose heartbeat is older than 45s is marked
 * offline; if it was holding a session, the session is released back to
 * "pending" so another worker can pick it up. Runs every 30s via crons.ts.
 */
export const reapOfflineWorkers = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - HEARTBEAT_TIMEOUT_MS;
    const workers = await ctx.db.query("workers").collect();
    let reaped = 0;
    let released = 0;
    for (const worker of workers) {
      if (worker.status === "offline") continue;
      if (worker.lastHeartbeatAt >= cutoff) continue;
      reaped++;
      const orphan = worker.currentSessionId
        ? await ctx.db.get(worker.currentSessionId)
        : null;
      await ctx.db.patch(worker._id, {
        status: "offline",
        currentSessionId: undefined,
      });
      if (orphan && orphan.status === "running") {
        await ctx.db.patch(orphan._id, {
          status: "pending",
          claimedBy: undefined,
          claimedAt: undefined,
        });
        released++;
      }
    }
    return { reaped, released };
  },
});
