/**
 * Per-consumer auth for the Ponder localhost HTTP bridge.
 *
 * Keys live at `~/.ponder/keys.json`. Each entry has:
 *   { name, key, scopes: ["browser:*", "recipe:*", ...], createdAt, lastUsedAt }
 *
 * `ponder grant <name>` (in src/cli/ponder.ts) appends a row and
 * prints the key ONCE. The bridge middleware in electron/main.ts
 * verifies the `Authorization: Bearer pndr_live_<token>` header
 * against this file on every request.
 *
 * Audit log: `~/.ponder/audit.log` (JSONL) — one row per request with
 * `{ ts, consumer, method, path, status, durationMs }`. Surfaced via
 * `ponder grants log`.
 *
 * The bridge is localhost-only AND key-gated, but we still bias
 * toward the cautious defaults: missing key file → no requests pass;
 * empty scopes → no requests pass.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

export const PONDER_DIR = path.join(os.homedir(), ".ponder");
export const KEYS_PATH = path.join(PONDER_DIR, "keys.json");
export const AUDIT_LOG_PATH = path.join(PONDER_DIR, "audit.log");

/** Scope grammar: `category:action` or `category:*` or `*`. The
 *  default scope `*` allows everything. Restrict at grant time via
 *  --scopes. */
export type Scope = string;

export interface KeyRecord {
  name: string;
  /** Full key as stored on disk; what the consumer sends in
   *  Authorization headers. Never echoed back outside the grant flow. */
  key: string;
  scopes: Scope[];
  createdAt: string;
  lastUsedAt?: string;
  /** Optional notes — what consumer this key is for. */
  notes?: string;
}

interface KeyFileShape {
  version: 1;
  keys: KeyRecord[];
}

/** Read the key file. Returns empty when missing/malformed. */
export async function readKeys(): Promise<KeyRecord[]> {
  try {
    const raw = await fsp.readFile(KEYS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as KeyFileShape | KeyRecord[];
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.keys)) return parsed.keys;
    return [];
  } catch {
    return [];
  }
}

/** Synchronous version used by hot-path bridge middleware. */
export function readKeysSync(): KeyRecord[] {
  try {
    const raw = fs.readFileSync(KEYS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as KeyFileShape | KeyRecord[];
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.keys)) return parsed.keys;
    return [];
  } catch {
    return [];
  }
}

/** Persist the key file. Uses 0o600 permissions on POSIX. */
export async function writeKeys(keys: KeyRecord[]): Promise<void> {
  await fsp.mkdir(PONDER_DIR, { recursive: true });
  const shape: KeyFileShape = { version: 1, keys };
  await fsp.writeFile(KEYS_PATH, JSON.stringify(shape, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/** Generate a fresh key. */
export function generateKey(): string {
  const random = crypto.randomBytes(24).toString("base64url");
  return `pndr_live_${random}`;
}

/** Add or update a key by name. Returns the new record (with the key
 *  the caller should display to the user — only once). */
export async function grantKey(opts: {
  name: string;
  scopes: Scope[];
  notes?: string;
}): Promise<KeyRecord> {
  const keys = await readKeys();
  const existing = keys.findIndex((k) => k.name === opts.name);
  const record: KeyRecord = {
    name: opts.name,
    key: generateKey(),
    scopes: opts.scopes.length > 0 ? opts.scopes : ["*"],
    createdAt: new Date().toISOString(),
    ...(opts.notes ? { notes: opts.notes } : {}),
  };
  if (existing >= 0) {
    keys[existing] = record;
  } else {
    keys.push(record);
  }
  await writeKeys(keys);
  return record;
}

/** Remove a key by name. Returns true when something was removed. */
export async function revokeKey(name: string): Promise<boolean> {
  const keys = await readKeys();
  const before = keys.length;
  const filtered = keys.filter((k) => k.name !== name);
  if (filtered.length === before) return false;
  await writeKeys(filtered);
  return true;
}

/** Update `lastUsedAt` for the key. Best-effort; never throws. */
export async function touchKey(name: string): Promise<void> {
  try {
    const keys = await readKeys();
    const idx = keys.findIndex((k) => k.name === name);
    if (idx < 0) return;
    keys[idx]!.lastUsedAt = new Date().toISOString();
    await writeKeys(keys);
  } catch {
    /* best-effort */
  }
}

/** Synchronous touchKey for hot-path middleware. */
export function touchKeySync(name: string): void {
  try {
    const keys = readKeysSync();
    const idx = keys.findIndex((k) => k.name === name);
    if (idx < 0) return;
    keys[idx]!.lastUsedAt = new Date().toISOString();
    fs.mkdirSync(PONDER_DIR, { recursive: true });
    fs.writeFileSync(
      KEYS_PATH,
      JSON.stringify({ version: 1, keys }, null, 2),
      { encoding: "utf-8", mode: 0o600 },
    );
  } catch {
    /* best-effort */
  }
}

export type AuthResult =
  | { ok: true; consumer: string; record: KeyRecord }
  | { ok: false; code: "MISSING_AUTH" | "INVALID_KEY"; message: string };

/** Verify a bearer token against the key file. */
export function verifyToken(authorization: string | undefined): AuthResult {
  if (!authorization || !authorization.startsWith("Bearer ")) {
    return {
      ok: false,
      code: "MISSING_AUTH",
      message:
        "Missing Authorization: Bearer <key> header. Issue a key with `ponder grant <name>`.",
    };
  }
  const token = authorization.slice("Bearer ".length).trim();
  if (!token) {
    return { ok: false, code: "MISSING_AUTH", message: "Empty bearer token." };
  }
  const keys = readKeysSync();
  const match = keys.find((k) => k.key === token);
  if (!match) {
    return {
      ok: false,
      code: "INVALID_KEY",
      message: "Key not recognized. Issue a new key with `ponder grant <name>`.",
    };
  }
  return { ok: true, consumer: match.name, record: match };
}

/** Check whether a scope satisfies the granted scopes. */
export function scopeAllowed(granted: Scope[], required: Scope): boolean {
  if (granted.includes("*")) return true;
  if (granted.includes(required)) return true;
  // category:* matches category:anything
  const colon = required.indexOf(":");
  if (colon > 0) {
    const wildcard = `${required.slice(0, colon)}:*`;
    if (granted.includes(wildcard)) return true;
  }
  return false;
}

/** Append one audit row. Best-effort. */
export function audit(row: {
  consumer: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
}): void {
  try {
    fs.mkdirSync(PONDER_DIR, { recursive: true });
    const line =
      JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n";
    fs.appendFileSync(AUDIT_LOG_PATH, line, { encoding: "utf-8", mode: 0o600 });
  } catch {
    /* best-effort */
  }
}

/** Read the most recent N audit rows. */
export async function readAuditTail(opts: {
  tail?: number;
  consumer?: string;
} = {}): Promise<
  Array<{
    ts: string;
    consumer: string;
    method: string;
    path: string;
    status: number;
    durationMs: number;
  }>
> {
  const tail = opts.tail ?? 50;
  try {
    const raw = await fsp.readFile(AUDIT_LOG_PATH, "utf-8");
    const lines = raw.trim().split("\n").reverse();
    const out: Array<{
      ts: string;
      consumer: string;
      method: string;
      path: string;
      status: number;
      durationMs: number;
    }> = [];
    for (const line of lines) {
      if (out.length >= tail) break;
      try {
        const row = JSON.parse(line) as {
          ts: string;
          consumer: string;
          method: string;
          path: string;
          status: number;
          durationMs: number;
        };
        if (opts.consumer && row.consumer !== opts.consumer) continue;
        out.push(row);
      } catch {
        /* skip malformed */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Whether magic mode is on (env or set programmatically). Magic mode
 *  short-circuits confirmation prompts inside the Electron tray. It
 *  does NOT bypass auth — the bridge still enforces `verifyToken`. */
export function isMagicMode(): boolean {
  return process.env.PONDER_AUTO === "1" || process.env.PONDER_MAGIC === "1";
}
