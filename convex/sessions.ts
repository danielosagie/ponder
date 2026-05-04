import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const create = mutation({
  args: {
    prompt: v.string(),
    provider: v.union(
      v.literal("remote"),
      v.literal("local"),
      v.literal("hcompany"),
    ),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("sessions", {
      prompt: args.prompt,
      provider: args.provider,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

export const setStatus = mutation({
  args: {
    sessionId: v.id("sessions"),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("done"),
      v.literal("error"),
      v.literal("cancelled"),
    ),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = { status: args.status };
    if (args.status === "done" || args.status === "error" || args.status === "cancelled") {
      patch.endedAt = Date.now();
    }
    if (args.error) patch.error = args.error;
    await ctx.db.patch(args.sessionId, patch);
  },
});

export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("sessions")
      .withIndex("by_created")
      .order("desc")
      .take(args.limit ?? 50);
  },
});

export const get = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => ctx.db.get(args.sessionId),
});

export const getActive = query({
  args: {},
  handler: async (ctx) => {
    const running = await ctx.db
      .query("sessions")
      .withIndex("by_created")
      .order("desc")
      .filter((q) =>
        q.or(q.eq(q.field("status"), "running"), q.eq(q.field("status"), "pending")),
      )
      .first();
    return running;
  },
});
