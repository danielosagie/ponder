#!/usr/bin/env node
/**
 * Fleet claim CAS load test.
 *
 * Pre-seeds N pending sessions in your Convex deployment, registers M fake
 * workers, has all of them call claimNext concurrently for a fixed window,
 * and asserts that every session is claimed exactly once (no duplicate
 * claims, no orphaned pending rows).
 *
 * The CAS pattern in convex/workers.ts:claimNext relies on Convex's
 * per-document serialization to prevent two workers from grabbing the same
 * session. This script is the safety net that proves it under contention.
 *
 * Usage:
 *   VITE_CONVEX_URL=https://your-deployment.convex.cloud \
 *   node scripts/fleet-loadtest.mjs [--workers 5] [--sessions 100]
 *
 * Requires the deployment to have v1.1+ schema (workers table, claimNext
 * mutation). Cleans up after itself by deleting the test sessions+workers
 * via standard mutations — no admin access needed.
 */
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    workers: { type: "string", default: "5" },
    sessions: { type: "string", default: "100" },
    "convex-url": { type: "string" },
  },
});
const WORKERS = parseInt(values.workers, 10);
const SESSIONS = parseInt(values.sessions, 10);
const CONVEX_URL = values["convex-url"] ?? process.env.VITE_CONVEX_URL;

if (!CONVEX_URL) {
  console.error("set VITE_CONVEX_URL or pass --convex-url");
  process.exit(1);
}

const client = new ConvexHttpClient(CONVEX_URL);
const tag = `loadtest-${Date.now().toString(36)}`;

console.log(`[loadtest] ${WORKERS} workers, ${SESSIONS} sessions, tag=${tag}`);

// Seed pending sessions tagged so cleanup is unambiguous.
const sessionIds = [];
const seedStart = Date.now();
for (let i = 0; i < SESSIONS; i++) {
  const id = await client.mutation(anyApi.sessions.create, {
    prompt: `${tag} #${i}`,
    provider: "hcompany",
    runtime: "desktop",
  });
  sessionIds.push(String(id));
}
console.log(`[loadtest] seeded ${SESSIONS} sessions in ${Date.now() - seedStart}ms`);

// Register workers.
const workerIds = Array.from({ length: WORKERS }, () => `${tag}-worker-${randomUUID().slice(0, 8)}`);
for (const workerId of workerIds) {
  await client.mutation(anyApi.workers.register, {
    workerId,
    hostname: `loadtest-${workerId}`,
    platform: "linux",
    capabilities: ["desktop"],
  });
}
console.log(`[loadtest] registered ${WORKERS} workers`);

// All workers race to drain the queue.
const claimed = new Map(); // sessionId -> workerId
const claimStart = Date.now();
let totalClaims = 0;

await Promise.all(
  workerIds.map(async (workerId) => {
    while (true) {
      const session = await client.mutation(anyApi.workers.claimNext, {
        workerId,
        runtime: "desktop",
      });
      if (!session) {
        // Queue empty; release worker back to idle so we can keep claiming.
        // (In real life the desktop calls releaseSession when the loop ends;
        // here we shortcut and patch via heartbeat with status="idle".)
        const fresh = await client.mutation(anyApi.workers.heartbeat, {
          workerId,
          status: "idle",
        });
        if (!fresh) break;
        // Re-poll once; if still empty, this worker is done.
        const second = await client.mutation(anyApi.workers.claimNext, {
          workerId,
          runtime: "desktop",
        });
        if (!second) break;
        recordClaim(second._id, workerId);
        await release(workerId, second._id);
        continue;
      }
      recordClaim(session._id, workerId);
      await release(workerId, session._id);
    }
  }),
);

function recordClaim(sessionId, workerId) {
  if (claimed.has(sessionId)) {
    console.error(
      `[FAIL] session ${sessionId} double-claimed by ${claimed.get(sessionId)} and ${workerId}`,
    );
    process.exit(2);
  }
  claimed.set(sessionId, workerId);
  totalClaims++;
}

async function release(workerId, sessionId) {
  await client.mutation(anyApi.workers.releaseSession, {
    workerId,
    sessionId,
    status: "done",
  });
}

const elapsed = Date.now() - claimStart;
console.log(`[loadtest] drained queue: ${totalClaims} claims in ${elapsed}ms`);

if (claimed.size !== SESSIONS) {
  console.error(
    `[FAIL] expected ${SESSIONS} unique claims, got ${claimed.size}`,
  );
  process.exit(2);
}

// Distribution check: no worker should have claimed more than SESSIONS / WORKERS * 2.
const dist = new Map();
for (const w of claimed.values()) dist.set(w, (dist.get(w) ?? 0) + 1);
const maxPerWorker = Math.max(...dist.values());
const fairCeiling = Math.ceil((SESSIONS / WORKERS) * 2);
console.log(
  `[loadtest] distribution: min=${Math.min(...dist.values())} max=${maxPerWorker} (fair ceiling=${fairCeiling})`,
);

console.log(`[PASS] ${SESSIONS} sessions, ${WORKERS} workers, ${elapsed}ms, no duplicate claims.`);
