import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

/**
 * Resolve the authenticated Clerk identity to a `customers` row. Throws if
 * the caller isn't authenticated (no JWT) or if the org's customer row
 * doesn't exist yet — callers from the dashboard should hit
 * `customers.ensureExists` on first load to populate.
 *
 * Why the Clerk org and not the user? Ponder is per-org by design: usage
 * limits, hosted-worker quota, Stripe subscription, and audit trail all
 * roll up to the org. A single Clerk user can belong to multiple orgs and
 * switch between them via `<OrganizationSwitcher/>`.
 *
 * The `org_id` claim is a custom claim we configure in the Clerk JWT
 * template (see docs/CLERK_SETUP.md). Without it, the JWT is rejected
 * here — there's no fallback to the user's personal context, because
 * billing and resource ownership must be unambiguous.
 */
export async function requireCustomer(
  ctx: QueryCtx | MutationCtx,
): Promise<Doc<"customers">> {
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
  const customer = await ctx.db
    .query("customers")
    .withIndex("by_clerkOrg", (q) => q.eq("clerkOrgId", orgId))
    .first();
  if (!customer) {
    throw new Error(
      "customer not found — call customers.ensureExists from the dashboard first",
    );
  }
  return customer;
}

/**
 * Like `requireCustomer` but returns null if unauthenticated instead of
 * throwing. Used by functions that should work in BOTH the self-host
 * un-scoped path (no auth) AND the Cloud scoped path (auth) — they branch
 * on the result and either filter by customerId or not.
 */
export async function optionalCustomer(
  ctx: QueryCtx | MutationCtx,
): Promise<Doc<"customers"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  const orgId = identity.org_id;
  if (typeof orgId !== "string" || orgId.length === 0) return null;
  return await ctx.db
    .query("customers")
    .withIndex("by_clerkOrg", (q) => q.eq("clerkOrgId", orgId))
    .first();
}

/**
 * Default plan-tier → hostedQuota mapping. Centralized here so the Stripe
 * webhook (Week 4) and the JIT customer creation (Week 1) agree.
 *
 * Mirrors docs/V1.2_PLAN.md §4.5. Update this when pricing changes; do
 * NOT inline the numbers at call sites.
 */
export function hostedQuotaForPlan(
  tier: Doc<"customers">["planTier"],
): number {
  switch (tier) {
    case "free":
      return 0;
    case "pro":
      return 2;
    case "enterprise":
      // Real Enterprise quotas are set per-deal in the Stripe webhook
      // handler; this is a safe default before negotiation.
      return 10;
  }
}

/**
 * Default plan-tier → monthly action quota. `undefined` = no hard cap
 * (overage billing kicks in via Stripe metered events). Free hits the
 * hard cap and dispatches are rejected once exceeded; Pro and Enterprise
 * never hit a hard cap.
 */
export function actionQuotaForPlan(
  tier: Doc<"customers">["planTier"],
): number | undefined {
  switch (tier) {
    case "free":
      return 1000;
    case "pro":
      return undefined;
    case "enterprise":
      return undefined;
  }
}
