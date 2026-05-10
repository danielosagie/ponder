#!/usr/bin/env node
/**
 * End-to-end smoke test for the v1.1 fleet bridge.
 *
 * Simulates the full SDK→desktop→SDK round-trip without an actual Ponder.app:
 *   1. Register a fake desktop worker via workers.register
 *   2. Dispatch a task via PonderClient
 *   3. Subscribe to step events
 *   4. Claim the session (as the fake worker)
 *   5. Append a "result" step (mimics what the extractor does)
 *   6. Release the session as "done"
 *   7. PonderClient.getResult returns the right result + status
 *
 * Run AFTER `npx convex deploy` against the same deployment:
 *   VITE_CONVEX_URL=https://your-deployment.convex.cloud \
 *   node scripts/smoke-fleet.mjs
 *
 * Exits non-zero on any assertion failure. Logs each step so you can see
 * exactly where the round-trip broke if it does.
 */
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { randomUUID } from "node:crypto";

const CONVEX_URL = process.env.VITE_CONVEX_URL;
if (!CONVEX_URL) {
  console.error("set VITE_CONVEX_URL");
  process.exit(1);
}

// Pretend to be the SDK consumer (their server).
const { PonderClient } = await import("../dist/index.js");
const client = new PonderClient({ convexUrl: CONVEX_URL });

// Pretend to be a desktop fleet worker.
const fleetClient = new ConvexHttpClient(CONVEX_URL);
const workerId = `smoke-${randomUUID().slice(0, 8)}`;

let failed = false;
const assert = (cond, label, detail = "") => {
  if (!cond) {
    failed = true;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
};

console.log("ponder smoke-fleet");
console.log();

// Step 1: register fake worker
console.log("[1] register fake worker");
await fleetClient.mutation(anyApi.workers.register, {
  workerId,
  hostname: "smoke-test",
  platform: "linux",
  capabilities: ["desktop"],
});
console.log(`    registered ${workerId}`);

// Step 2: dispatch
console.log("[2] dispatch via PonderClient");
const { sessionId } = await client.dispatch(
  `smoke task ${randomUUID().slice(0, 6)}`,
  { provider: "hcompany" },
);
console.log(`    session ${sessionId}`);

// Step 3: subscribe (fire-and-forget, just to exercise the subscription path)
const stepLog = [];
const unsub = client.subscribe(sessionId, (step) => {
  stepLog.push(`${step.kind}: ${step.text ?? ""}`);
});

// Step 4: claim as the fake worker
console.log("[3] claim as fake worker");
const claimed = await fleetClient.mutation(anyApi.workers.claimNext, {
  workerId,
  runtime: "desktop",
});
assert(claimed != null, "claimNext returned a session");
assert(
  claimed && String(claimed._id) === sessionId,
  "claimed session matches dispatched session",
  claimed ? `got ${claimed._id}` : "got null",
);

// Step 5: simulate a result step (what the extractor would write)
console.log("[4] append result step (simulating extractor)");
const expectedResult = "the answer is 42";
await fleetClient.mutation(anyApi.steps.append, {
  sessionId,
  kind: "result",
  text: expectedResult,
});

// Step 6: release as done
console.log("[5] release session as done");
await fleetClient.mutation(anyApi.workers.releaseSession, {
  workerId,
  sessionId,
  status: "done",
});

// Step 7: SDK reads back the result
console.log("[6] PonderClient.getResult round-trip");
const final = await client.getResult(sessionId);
assert(final.status === "done", "session status is done", `got "${final.status}"`);
assert(
  final.result === expectedResult,
  "result text matches",
  `got "${final.result}"`,
);

// Cleanup
await client.close();
unsub();
await fleetClient.mutation(anyApi.workers.goOffline, { workerId });

console.log();
console.log(`subscribed step events received: ${stepLog.length}`);
for (const s of stepLog.slice(0, 10)) console.log(`  · ${s}`);

console.log();
if (failed) {
  console.error("FAIL");
  process.exit(2);
} else {
  console.log("PASS");
}
