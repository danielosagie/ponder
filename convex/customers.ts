import { v } from "convex/values";
import {
  mutation,
  query,
  internalMutation,
} from "./_generated/server";
import {
  requireCustomer,
  hostedQuotaForPlan,
  actionQuotaForPlan,
} from "./_helpers";

/**
 * JIT customer provisioning. Called by the dashboard on first load — if
 * no `customers` row exists for the authenticated org, we create one with
 * the free tier defaults. Webhook-driven creation (Clerk org.created) is
 * deferred to Week 2; for now this covers the same case more reliably
 * (no webhook delivery dependency).
 *
 * Returns the customer record (existing or newly created). Idempotent.
 */
export const ensureExists = mutation({
  args: {},
  returns: v.object({
    _id: v.id("customers"),
    clerkOrgId: v.string(),
    planTier: v.union(
      v.literal("free"),
      v.literal("pro"),
      v.literal("enterprise"),
    ),
    hostedQuota: v.number(),
    actionQuotaMonthly: v.optional(v.number()),
    createdAt: v.number(),
  }),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("not authenticated");
    }
    const orgId = identity.org_id;
    if (typeof orgId !== "string" || orgId.length === 0) {
      throw new Error(
        "missing org_id claim — check Clerk JWT template includes org_id",
      );
    }
    const existing = await ctx.db
      .query("customers")
      .withIndex("by_clerkOrg", (q) => q.eq("clerkOrgId", orgId))
      .first();
    if (existing) {
      return {
        _id: existing._id,
        clerkOrgId: existing.clerkOrgId,
        planTier: existing.planTier,
        hostedQuota: existing.hostedQuota,
        actionQuotaMonthly: existing.actionQuotaMonthly,
        createdAt: existing.createdAt,
      };
    }
    const email =
      typeof identity.email === "string" ? identity.email : "unknown@example";
    const now = Date.now();
    const planTier = "free" as const;
    const id = await ctx.db.insert("customers", {
      clerkOrgId: orgId,
      email,
      planTier,
      hostedQuota: hostedQuotaForPlan(planTier),
      actionQuotaMonthly: actionQuotaForPlan(planTier),
      createdAt: now,
    });
    const inserted = await ctx.db.get(id);
    if (!inserted) {
      // shouldn't happen — we just inserted in the same transaction
      throw new Error("failed to read back inserted customer");
    }
    return {
      _id: inserted._id,
      clerkOrgId: inserted.clerkOrgId,
      planTier: inserted.planTier,
      hostedQuota: inserted.hostedQuota,
      actionQuotaMonthly: inserted.actionQuotaMonthly,
      createdAt: inserted.createdAt,
    };
  },
});

/**
 * Returns the authenticated org's customer record. Used by the dashboard
 * to show plan tier, quotas, billing status. Throws if the customer row
 * doesn't exist — the dashboard should always call ensureExists first.
 */
export const getMe = query({
  args: {},
  returns: v.object({
    _id: v.id("customers"),
    clerkOrgId: v.string(),
    email: v.string(),
    planTier: v.union(
      v.literal("free"),
      v.literal("pro"),
      v.literal("enterprise"),
    ),
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    hostedQuota: v.number(),
    actionQuotaMonthly: v.optional(v.number()),
    createdAt: v.number(),
  }),
  handler: async (ctx) => {
    const customer = await requireCustomer(ctx);
    return {
      _id: customer._id,
      clerkOrgId: customer.clerkOrgId,
      email: customer.email,
      planTier: customer.planTier,
      stripeCustomerId: customer.stripeCustomerId,
      stripeSubscriptionId: customer.stripeSubscriptionId,
      hostedQuota: customer.hostedQuota,
      actionQuotaMonthly: customer.actionQuotaMonthly,
      createdAt: customer.createdAt,
    };
  },
});

/**
 * Plan-change handler. Called by the Stripe webhook (Week 4) when a
 * subscription is created, updated, or canceled. Internal-only — the
 * dashboard never mutates plan tier directly; Stripe is the source of
 * truth.
 *
 * Updates planTier + recomputed quotas atomically. If the new quota is
 * lower than current hosted-worker count, the caller (Stripe webhook
 * handler) is responsible for destroying excess workers — we don't do
 * that here because it'd cross the mutation/action boundary.
 */
export const updatePlan = internalMutation({
  args: {
    customerId: v.id("customers"),
    planTier: v.union(
      v.literal("free"),
      v.literal("pro"),
      v.literal("enterprise"),
    ),
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const customer = await ctx.db.get(args.customerId);
    if (!customer) throw new Error("customer not found");
    await ctx.db.patch(args.customerId, {
      planTier: args.planTier,
      hostedQuota: hostedQuotaForPlan(args.planTier),
      actionQuotaMonthly: actionQuotaForPlan(args.planTier),
      ...(args.stripeCustomerId !== undefined && {
        stripeCustomerId: args.stripeCustomerId,
      }),
      ...(args.stripeSubscriptionId !== undefined && {
        stripeSubscriptionId: args.stripeSubscriptionId,
      }),
    });
    return null;
  },
});
