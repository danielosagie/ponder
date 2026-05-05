import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const append = mutation({
  args: {
    sessionId: v.id("sessions"),
    kind: v.union(
      v.literal("thought"),
      v.literal("ground"),
      v.literal("action"),
      v.literal("screenshot"),
      v.literal("error"),
      v.literal("status"),
      v.literal("result"),
    ),
    text: v.optional(v.string()),
    coords: v.optional(v.object({ x: v.number(), y: v.number() })),
    action: v.optional(v.object({ type: v.string(), payload: v.any() })),
    screenshotId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    const last = await ctx.db
      .query("steps")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .order("desc")
      .first();
    const index = last ? last.index + 1 : 0;
    return await ctx.db.insert("steps", {
      sessionId: args.sessionId,
      index,
      kind: args.kind,
      text: args.text,
      coords: args.coords,
      action: args.action,
      screenshotId: args.screenshotId,
      createdAt: Date.now(),
    });
  },
});

export const listBySession = query({
  args: {
    sessionId: v.id("sessions"),
    limit: v.optional(v.number()),
    descending: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const q = ctx.db
      .query("steps")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .order(args.descending ? "desc" : "asc");
    return args.limit ? await q.take(args.limit) : await q.collect();
  },
});

export const tail = query({
  args: { sessionId: v.id("sessions"), n: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("steps")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .order("desc")
      .take(args.n);
    return rows.reverse();
  },
});

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});

export const getStorageUrl = query({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => await ctx.storage.getUrl(args.storageId),
});
