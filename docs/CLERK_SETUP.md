# Clerk + Convex setup for Ponder Cloud

Auth for the Ponder Cloud deployment (`cloud.ponder.dev`) runs on Clerk. The dashboard uses Clerk session tokens; the SDK uses Ponder-issued API keys (independent of Clerk). Self-host deployments leave Clerk unconfigured and skip the auth path entirely — they fall through to the legacy v1.1 functions.

This runbook covers the **one-time** Clerk setup needed before deploying the Cloud Convex instance. ~15 minutes start to finish.

## 1. Create a Clerk application

1. Sign in to [dashboard.clerk.com](https://dashboard.clerk.com)
2. **Create application** → name it "Ponder Cloud"
3. Enable sign-in methods: **Email**, **Google**, **GitHub** (the dev-tools default)
4. **Continue**

## 2. Enable organizations

Ponder is per-org by design — billing, quotas, and Stripe subscription all roll up to the org, not the individual user.

1. **Organizations** in the left sidebar → **Enable Organizations**
2. Settings:
   - **Allow users to create organizations**: ON
   - **Auto-create personal organization on sign-up**: ON (so single-user orgs work out of the box)
   - **Allow users to delete organizations**: ON

## 3. Create the Convex JWT template

This is the JWT that Convex uses to authenticate dashboard requests. The template name MUST match `applicationID` in `convex/auth.config.ts` (which is `"convex"`).

1. **JWT Templates** → **+ New template** → **Convex**
2. Name: **convex** (lowercase, exact)
3. **Claims** — paste this JSON:
   ```json
   {
     "aud": "convex",
     "org_id": "{{org.id}}",
     "org_role": "{{org.role}}",
     "org_slug": "{{org.slug}}"
   }
   ```
   The `org_id` claim is what `convex/_helpers.ts → requireCustomer` reads. Without it the JWT is rejected.
4. **Lifetime**: 60s default is fine; Clerk auto-refreshes
5. **Save**

Copy the **Issuer** URL shown at the top of the template page — it looks like `https://your-app.clerk.accounts.dev`. You'll paste this into Convex's env in step 5.

## 4. Set up the Clerk webhook (deferred to Week 2)

Webhooks are how Clerk notifies our backend when an org is created/deleted, a user joins, etc. We skip this for Week 1 (the dashboard uses JIT customer creation via `customers.ensureExists`) and add it in Week 2 for cleanup events like `org.deleted`.

When we wire it up:
1. **Webhooks** → **+ Add endpoint**
2. Endpoint URL: `https://your-deployment.convex.site/clerk-webhook` (Convex HTTP actions live at `.convex.site`, not `.convex.cloud`)
3. Subscribe to: `organization.created`, `organization.deleted`, `organizationMembership.created`
4. Copy the **Signing secret** for SVIX verification

## 5. Wire Convex to Clerk

In the Cloud Convex deployment:

```bash
npx convex env set CLERK_FRONTEND_API_URL https://your-app.clerk.accounts.dev
npx convex deploy
```

The deploy picks up `auth.config.ts` and starts trusting JWTs from that issuer. Dashboard requests with `Authorization: Bearer <clerk-jwt>` now resolve `ctx.auth.getUserIdentity()` to the signed-in user.

**Self-host customers don't run this command.** Their `CLERK_FRONTEND_API_URL` stays unset → `auth.config.ts` exports `{ providers: [] }` → legacy un-scoped functions work exactly as v1.1.

## 6. Verify with a smoke test

From the dashboard codebase (Week 2):

```ts
import { ConvexReactClient } from "convex/react";
import { ClerkProvider, useAuth } from "@clerk/clerk-react";

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL);

function App() {
  const { getToken, isSignedIn } = useAuth();
  if (!isSignedIn) return <SignIn />;
  // Pass the JWT to Convex
  convex.setAuth(async () => await getToken({ template: "convex" }));
  return <Dashboard />;
}
```

Then call `customers.ensureExists` once at mount; subsequent queries scope to the authenticated org automatically.

## 7. SDK auth: API keys (independent of Clerk)

Reminder: SDK consumers don't use Clerk JWTs. They use Ponder-issued API keys (`pk_live_…`) generated in the dashboard under **Settings → API Keys**. The keys are managed in `convex/apiKeys.ts` — issued once at creation time, SHA-256 hashed in storage, verified via the HTTP action that fronts SDK dispatches (Week 2).

The SDK path:
1. Customer signs in via Clerk → opens dashboard
2. Customer clicks "Create new API key" → `apiKeys.create({ name: "production" })` returns the plaintext once
3. Customer copies the key into their server env (`PONDER_API_KEY=pk_live_…`)
4. Their server calls `new PonderClient({ apiKey: process.env.PONDER_API_KEY })`
5. SDK sends `Authorization: Bearer pk_live_…` to Ponder's HTTP endpoint, which hashes + verifies via `apiKeys.verifyByHash` → resolves to a `customers._id` → scopes the dispatch

Clerk is involved exactly once: when the human created the key. The running SDK never touches Clerk.

## Troubleshooting

- **"missing org_id claim — check Clerk JWT template includes org_id"** → Step 3.3 missing or misspelled. The JWT template named `convex` must include `"org_id": "{{org.id}}"` in claims.
- **`getUserIdentity()` returns null in a dashboard query** → `convex.setAuth(...)` not called, or the JWT template name in `getToken({ template })` doesn't match. Should be `"convex"`.
- **JWT rejected with "invalid issuer"** → `CLERK_FRONTEND_API_URL` doesn't match the issuer printed on the JWT template page. Re-run `npx convex env set CLERK_FRONTEND_API_URL …` and redeploy.
- **Customer signs in but `customers.ensureExists` errors with "missing org_id"** → user hasn't selected an org. Add `<OrganizationSwitcher hidePersonal={false} />` to the dashboard layout; Clerk auto-creates the personal org on sign-up if enabled (step 2).
