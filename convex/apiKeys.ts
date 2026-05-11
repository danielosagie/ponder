import { v } from "convex/values";
import {
  mutation,
  query,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import { requireCustomer } from "./_helpers";

/**
 * API key format:
 *   pk_live_<32 base64url-encoded random bytes>
 *
 * The plaintext is generated server-side in `create`, returned to the
 * client exactly once, then SHA-256 hashed and stored. Plaintext is never
 * persisted. Lookups go through the by_hashedKey index — SDK requests
 * include the plaintext key in the Authorization header, the HTTP action
 * (defined in convex/http.ts in Week 2) hashes it and looks up the row.
 *
 * Why not bcrypt? Convex's V8 isolate doesn't have native bcrypt. SHA-256
 * is fine here because the secret space (256 bits) is large enough that
 * brute-forcing a single hash is infeasible — bcrypt's slowness only
 * matters for low-entropy passwords. API keys are not passwords.
 */

const KEY_PREFIX = "pk_live_";

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function base64UrlFromBytes(bytes: Uint8Array): string {
  // V8 isolate has btoa for ascii→base64; we then transform to base64url.
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Create a new API key for the authenticated customer. Returns the
 * plaintext key exactly once — the caller MUST store it; we cannot
 * retrieve it later. The dashboard shows a "Copy and save this key,
 * we can't show it again" modal.
 */
export const create = mutation({
  args: { name: v.string() },
  returns: v.object({
    _id: v.id("apiKeys"),
    plaintext: v.string(),
    displayPrefix: v.string(),
    name: v.string(),
    createdAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const customer = await requireCustomer(ctx);
    const trimmedName = args.name.trim();
    if (trimmedName.length === 0 || trimmedName.length > 80) {
      throw new Error("name must be 1-80 characters");
    }
    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);
    const plaintext = KEY_PREFIX + base64UrlFromBytes(randomBytes);
    const hashedKey = await sha256Hex(plaintext);
    // Show enough of the key in the dashboard for the user to identify it
    // visually ("which key did I revoke?") without leaking entropy. First
    // 12 chars covers the "pk_live_" prefix + 4 chars of randomness; last
    // 4 chars helps disambiguate near-prefix-collisions.
    const displayPrefix =
      plaintext.slice(0, 12) + "..." + plaintext.slice(-4);
    const now = Date.now();
    const id = await ctx.db.insert("apiKeys", {
      customerId: customer._id,
      hashedKey,
      displayPrefix,
      name: trimmedName,
      createdAt: now,
    });
    return {
      _id: id,
      plaintext,
      displayPrefix,
      name: trimmedName,
      createdAt: now,
    };
  },
});

/**
 * List the authenticated customer's API keys. Returns only metadata —
 * never the hash, never the plaintext. The dashboard renders these as a
 * table with a "Revoke" button per row.
 */
export const list = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("apiKeys"),
      displayPrefix: v.string(),
      name: v.string(),
      createdAt: v.number(),
      lastUsedAt: v.optional(v.number()),
      revokedAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx) => {
    const customer = await requireCustomer(ctx);
    const rows = await ctx.db
      .query("apiKeys")
      .withIndex("by_customer", (q) => q.eq("customerId", customer._id))
      .collect();
    return rows.map((r) => ({
      _id: r._id,
      displayPrefix: r.displayPrefix,
      name: r.name,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
      revokedAt: r.revokedAt,
    }));
  },
});

/**
 * Mark an API key as revoked. We don't delete the row — keeping it
 * means future leak-detection scans can still recognize "this key was
 * revoked on $date" instead of "this key never existed."
 */
export const revoke = mutation({
  args: { id: v.id("apiKeys") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const customer = await requireCustomer(ctx);
    const key = await ctx.db.get(args.id);
    if (!key) throw new Error("key not found");
    if (key.customerId !== customer._id) {
      // Don't leak existence — same error message as not found.
      throw new Error("key not found");
    }
    if (key.revokedAt !== undefined) return null; // idempotent
    await ctx.db.patch(args.id, { revokedAt: Date.now() });
    return null;
  },
});

/**
 * Internal: resolve a plaintext API key to its customer record. Called
 * by the HTTP action that fronts SDK requests (Week 2). Returns null on
 * unknown / revoked keys; the HTTP action turns null into a 401.
 *
 * Updates lastUsedAt as a side effect for the "last used" column in the
 * dashboard. Cheap because it's a single index lookup + patch.
 */
export const verifyByHash = internalMutation({
  args: { hashedKey: v.string() },
  returns: v.union(v.null(), v.id("customers")),
  handler: async (ctx, args) => {
    const key = await ctx.db
      .query("apiKeys")
      .withIndex("by_hashedKey", (q) => q.eq("hashedKey", args.hashedKey))
      .first();
    if (!key) return null;
    if (key.revokedAt !== undefined) return null;
    await ctx.db.patch(key._id, { lastUsedAt: Date.now() });
    return key.customerId;
  },
});

/**
 * Internal helper that the Week 2 HTTP action will use: hash a plaintext
 * key and return the same hex digest that `create` stored. Exported as
 * an internalQuery so it lives in the V8 isolate, not Node — keeps the
 * hash function consistent across all callers.
 */
export const hashPlaintext = internalQuery({
  args: { plaintext: v.string() },
  returns: v.string(),
  handler: async (_ctx, args) => {
    return await sha256Hex(args.plaintext);
  },
});
