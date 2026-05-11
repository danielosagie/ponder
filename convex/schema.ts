import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  sessions: defineTable({
    prompt: v.string(),
    createdAt: v.number(),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("done"),
      v.literal("error"),
      v.literal("cancelled"),
    ),
    provider: v.union(
      v.literal("remote"),
      v.literal("local"),
      v.literal("hcompany"),
    ),
    endedAt: v.optional(v.number()),
    error: v.optional(v.string()),
    // Where this session is meant to run. "desktop" is the default and the
    // legacy behavior — a Ponder.app on the customer's Mac picks it up.
    // "headless" means the SDK consumer is running the loop themselves in a
    // Node process via `ponder/server`'s serveHeadless(); the desktop fleet
    // (item 7) filters these out so they're not double-claimed.
    // Optional for forward-compat: undefined = treated as "desktop".
    runtime: v.optional(
      v.union(v.literal("desktop"), v.literal("headless")),
    ),
    // ---- v1.1 fleet fields (item 7) ----
    // Set when a worker calls workers.claimNext and atomically transitions
    // status pending → running. Optional so v1 sessions (no claim semantics)
    // and SDK-dispatched sessions (un-targeted, claimed-by-anyone) round-trip
    // through the schema unchanged.
    claimedBy: v.optional(v.id("workers")),
    claimedAt: v.optional(v.number()),
    // Set the next phase (item 8) once Convex Auth scopes per-workspace.
    // Self-host deployments leave this undefined; Ponder Cloud workspaces
    // populate it on every dispatch via withWorkspace().
    workspaceId: v.optional(v.string()),
    // Optional dispatch hint from the SDK: if set, only the matching worker
    // will claim this session (round-robin within a single dev's fleet —
    // e.g. "always run customer X's tasks on customer X's Mac").
    targetWorkerId: v.optional(v.string()),
    // ---- v1.2 Cloud auth (Week 1) ----
    // Set on every Ponder Cloud dispatch (via requireCustomer); left
    // undefined on self-host deployments where there's no `customers` table.
    // Every public Cloud query/mutation filters by this so customers never
    // see another customer's data.
    customerId: v.optional(v.id("customers")),
  })
    .index("by_created", ["createdAt"])
    // Drives the claimNext query. Worker filters by (workspaceId, status,
    // runtime) and orders by createdAt for FIFO drain.
    .index("by_status_runtime", [
      "workspaceId",
      "status",
      "runtime",
      "createdAt",
    ])
    // v1.2 Cloud: customer-scoped listings ("show me my sessions"). Ordered
    // by createdAt for dashboard reverse-chronological scroll.
    .index("by_customer", ["customerId", "createdAt"]),

  steps: defineTable({
    sessionId: v.id("sessions"),
    index: v.number(),
    kind: v.union(
      v.literal("thought"),
      v.literal("ground"),
      v.literal("action"),
      v.literal("screenshot"),
      v.literal("error"),
      v.literal("status"),
      // Final user-facing answer produced by the extractor at end-of-run.
      // Distinct from "thought" (planner reasoning) and "status" (transient
      // progress). Persisted so the History view can show what the agent
      // actually answered the user, not just the action transcript.
      v.literal("result"),
    ),
    text: v.optional(v.string()),
    coords: v.optional(v.object({ x: v.number(), y: v.number() })),
    action: v.optional(
      v.object({
        type: v.string(),
        payload: v.any(),
      }),
    ),
    screenshotId: v.optional(v.id("_storage")),
    createdAt: v.number(),
  }).index("by_session", ["sessionId", "index"]),

  // ---- v1.1 fleet (item 7) ----
  // One row per Ponder.app instance pointed at this deployment. The desktop
  // generates a UUID on first launch and persists it under app.getPath
  // ("userData")/worker.json so re-launches reuse the same row.
  workers: defineTable({
    workerId: v.string(),
    hostname: v.string(),
    platform: v.union(
      v.literal("darwin"),
      v.literal("win32"),
      v.literal("linux"),
    ),
    capabilities: v.array(
      v.union(v.literal("desktop"), v.literal("headless")),
    ),
    workspaceId: v.optional(v.string()), // forward-compat for item 8
    registeredAt: v.number(),
    lastHeartbeatAt: v.number(),
    status: v.union(
      v.literal("idle"),
      v.literal("busy"),
      v.literal("offline"),
    ),
    currentSessionId: v.optional(v.id("sessions")),
    // ---- v1.2 Cloud auth (Week 1) ----
    // For BYO workers on Ponder Cloud: set when the worker registers under
    // a Cloud `apiKey`. For self-host deployments and hosted workers
    // (which we spawn directly via the IWorkerHost interface), this is
    // also populated by the spawner. Undefined only on self-host.
    customerId: v.optional(v.id("customers")),
  })
    .index("by_workerId", ["workerId"])
    .index("by_workspace_status", [
      "workspaceId",
      "status",
      "lastHeartbeatAt",
    ])
    // v1.2 Cloud: list-my-workers query for the dashboard.
    .index("by_customer", ["customerId"]),

  // ---- v1.2 Cloud auth (Week 1) ----
  // One row per Ponder Cloud tenant. Self-host deployments leave this
  // table empty and queries fall through to the un-scoped legacy path.
  // The clerkOrgId is the source of truth — multiple Clerk users may
  // share an org and therefore a `customers` row.
  customers: defineTable({
    clerkOrgId: v.string(),
    email: v.string(), // billing contact
    planTier: v.union(
      v.literal("free"),
      v.literal("pro"),
      v.literal("enterprise"),
    ),
    // Stripe linkage (populated by §5's webhook handler in Week 4).
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    // Max concurrent hosted workers this customer can spawn. Computed
    // from planTier at sign-up + plan-change webhook; cached here so
    // the spawn endpoint doesn't have to re-derive on every call.
    hostedQuota: v.number(),
    // Hard quota for free-tier action enforcement; null = unlimited
    // (Pro overage; Enterprise volume-tiered separately).
    actionQuotaMonthly: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_clerkOrg", ["clerkOrgId"]),

  // ---- v1.2 Cloud auth (Week 1) ----
  // SDK auth keys. Distinct from Clerk JWTs: Clerk is for dashboard
  // sessions, apiKeys are for `new PonderClient({ apiKey })`. Stored
  // as SHA-256 hashes — the plaintext key is shown to the user exactly
  // once at creation time. Prefix (first 8 chars + last 4) is kept for
  // display in the dashboard ("pk_live_abcd…wxyz").
  apiKeys: defineTable({
    customerId: v.id("customers"),
    hashedKey: v.string(),
    displayPrefix: v.string(),
    name: v.string(), // user-given label, e.g. "production server"
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
  })
    .index("by_customer", ["customerId"])
    .index("by_hashedKey", ["hashedKey"]),
});
