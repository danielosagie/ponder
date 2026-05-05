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
  }).index("by_created", ["createdAt"]),

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
});
