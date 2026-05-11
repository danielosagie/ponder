import type { AuthConfig } from "convex/server";

/**
 * Convex auth providers. Read at deploy time (not runtime), so the URLs
 * live as env vars baked into the deployment via `npx convex env set`.
 *
 * The two-deployment model:
 *
 *   Self-host (any customer's own Convex project): leave CLERK_FRONTEND_API_URL
 *     unset. Providers is empty → `ctx.auth.getUserIdentity()` returns null →
 *     the legacy un-scoped Convex functions in sessions.ts / workers.ts /
 *     steps.ts work as before. Nothing changes for v1.1 self-host users.
 *
 *   Ponder Cloud (cloud.ponder.dev's shared deployment): set
 *     CLERK_FRONTEND_API_URL=https://your-clerk-instance.clerk.accounts.dev
 *     so dashboard sessions and SDK API keys can be verified. See
 *     docs/CLERK_SETUP.md for the Clerk-side configuration.
 *
 * The "convex" applicationID is the JWT template name in the Clerk dashboard;
 * its audience claim must match this string. Standard Clerk+Convex pattern.
 */
const clerkDomain = process.env.CLERK_FRONTEND_API_URL;

export default {
  providers: clerkDomain
    ? [
        {
          domain: clerkDomain,
          applicationID: "convex",
        },
      ]
    : [],
} satisfies AuthConfig;
