/**
 * Configuration for the holo3-agent (Ponder) browser-jobs consumer.
 *
 * The consumer subscribes to the sssync-bknd Convex `browserJobs` queue and
 * executes jobs through the Ponder engine (the local Electron bridge at
 * :7900). This is the "all-in on Ponder" desktop consumer — the missing
 * piece that lets a phone-dispatched Facebook Marketplace job actually run on
 * the desktop via computer use.
 *
 * Two ways to configure:
 *  1. Explicit env vars (below).
 *  2. The bootstrap endpoint: with PONDER_BROWSER_JOBS_SYNC_BASE_URL +
 *     PONDER_BROWSER_JOBS_SYNC_TOKEN set, call `bootstrapConfig()` to fetch
 *     { convexURL, userId } from GET /api/agent/browser-jobs/bootstrap.
 */

import * as os from "node:os";

export interface BrowserJobsConfig {
  /** Convex deployment URL the sssync-bknd writes browserJobs into. */
  convexURL: string;
  /** The owning user id (Convex jobs are filtered by_user_status). */
  userId: string;
  /** Stable id for THIS worker (shows up on claimed jobs). */
  workerId: string;
  /** sssync-bknd base URL for the reconcile callback (optional). */
  syncBaseURL: string;
  /** Bearer token for the reconcile callback (optional). */
  syncToken: string;
  /** Local Ponder Electron bridge port (engine execution). */
  bridgePort: number;

  // ── FB account-safety (writes only) ──────────────────────────────────
  // These pace/cap WRITE jobs (create_listing/update_listing/delete_listing/
  // send_message) to look human and avoid FB rate-limit/ban friction. READS
  // (scrape_inventory/check_messages/sync_listing_state) are EXEMPT from all
  // of these. Generous, env-tunable defaults; account-safety > speed.
  /** Feature A. Lower bound (ms) of the randomized pause BEFORE each write. */
  writeMinGapMs: number;
  /** Feature A. Upper bound (ms) of the randomized pre-write pause. */
  writeMaxGapMs: number;
  /** Feature B. Max writes in a rolling 1h window (defer when hit). */
  writeHourlyCap: number;
  /** Feature B. Max writes in a rolling 24h window (defer when hit). */
  writeDailyCap: number;
  /** Feature C. Consecutive write failures that trip the circuit breaker. */
  frictionBreakConsecutiveFails: number;
  /** Optional. Tiny randomized [0,MAX] pause before reads (0 = reads stay fast).
   *  NOTE: to DISABLE any cap below, set a LARGE number, never a blank value —
   *  a blank/garbage env value falls back to the documented default (envNum). */
  readJitterMaxMs: number;
  /** Feature C liveness. Interval (ms) for the consumer's cap-defer re-check
   *  tick that re-polls deferred writes once the rolling window clears.
   *  0 disables the tick. */
  deferRecheckMs: number;
}

function envStr(...keys: string[]): string {
  for (const key of keys) {
    const value = String(process.env[key] || "").trim();
    if (value) return value;
  }
  return "";
}

/**
 * Safe numeric env parse for the account-safety knobs.
 *
 * Footgun this guards against: `Number(process.env.X ?? default)` is wrong when
 * the var is SET-BUT-BLANK (`Number("") === 0` → e.g. hourly cap 0 = every
 * write perma-deferred; consecutive-fail 0 = breaker trips on the first
 * failure) or NON-NUMERIC (`Number("abc") === NaN` → cap silently disabled,
 * `sleep(NaN) ≈ 0` = no pacing at all). This helper:
 *   • returns `def` when the var is undefined / blank / NaN, and
 *   • clamps the result to [min, max] (default min = 0, so never negative).
 *
 * To DISABLE a cap, set a large number (e.g. 1000000) — NOT a blank value.
 */
function envNum(
  key: string,
  def: number,
  { min = 0, max = Number.POSITIVE_INFINITY }: { min?: number; max?: number } = {},
): number {
  const raw = process.env[key];
  // undefined OR set-but-blank → fall back to the documented default.
  if (raw == null || String(raw).trim() === "") return clamp(def, min, max);
  const n = Number(raw);
  // non-numeric (NaN) → fall back to the documented default (don't silently 0).
  if (!Number.isFinite(n)) return clamp(def, min, max);
  return clamp(n, min, max);
}

function clamp(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

export function defaultWorkerId(): string {
  const host = (() => {
    try {
      return os.hostname();
    } catch {
      return "desktop";
    }
  })();
  return `holo3-ponder-${host}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

/** Read whatever is available from the environment (no network). */
export function readBrowserJobsConfig(): BrowserJobsConfig {
  return {
    convexURL: envStr("PONDER_BROWSER_JOBS_CONVEX_URL", "CONVEX_URL"),
    userId: envStr("PONDER_BROWSER_JOBS_USER_ID"),
    workerId: envStr("PONDER_BROWSER_JOBS_WORKER_ID") || defaultWorkerId(),
    syncBaseURL: envStr(
      "PONDER_BROWSER_JOBS_SYNC_BASE_URL",
      "SSSYNC_API_URL",
      "ANORHA_BACKEND_URL",
    ),
    syncToken: envStr("PONDER_BROWSER_JOBS_SYNC_TOKEN"),
    bridgePort: envNum("PONDER_BRIDGE_PORT", 7900, { min: 1, max: 65535 }),

    // ── FB account-safety (writes only) ─────────────────────────────────
    // All parsed via envNum: a BLANK or non-numeric value falls back to the
    // documented default and is clamped to a sane range — never 0 / NaN. To
    // disable a cap, set a LARGE number (e.g. 1000000), not a blank value.
    ...(() => {
      const writeMinGapMs = envNum("PONDER_WRITE_MIN_GAP_MS", 5000);
      // max gap must be >= min gap (the consumer derives [min,max] from these).
      const writeMaxGapMs = envNum("PONDER_WRITE_MAX_GAP_MS", 20000, {
        min: writeMinGapMs,
      });
      return { writeMinGapMs, writeMaxGapMs };
    })(),
    // Caps: clamp to a minimum of 1 so a blank/garbage value can never brick
    // writes by deferring every one (a 0 cap would).
    writeHourlyCap: envNum("PONDER_WRITE_HOURLY_CAP", 8, { min: 1 }),
    writeDailyCap: envNum("PONDER_WRITE_DAILY_CAP", 25, { min: 1 }),
    // Breaker fail-streak: clamp to a minimum of 1 so a blank/garbage value
    // can never trip the breaker on the very first failure (a 0 would).
    frictionBreakConsecutiveFails: envNum(
      "PONDER_FRICTION_BREAK_CONSECUTIVE_FAILS",
      3,
      { min: 1 },
    ),
    readJitterMaxMs: envNum("PONDER_READ_JITTER_MAX_MS", 0),
    // Cap-defer re-check tick: 60s default; 0 disables. Clamped non-negative.
    deferRecheckMs: envNum("PONDER_DEFER_RECHECK_MS", 60000),
  };
}

export function isConfigured(config: BrowserJobsConfig): boolean {
  return Boolean(config.convexURL && config.userId);
}

/**
 * Fill missing convexURL/userId from the backend bootstrap endpoint when a
 * syncBaseURL + syncToken are available. Mirrors GET
 * /api/agent/browser-jobs/bootstrap which returns { convexURL, userId,
 * syncBaseURL }. Returns the (possibly) enriched config; never throws — on
 * failure it returns the input unchanged so explicit env still works.
 */
export async function bootstrapConfig(
  config: BrowserJobsConfig,
): Promise<BrowserJobsConfig> {
  if (isConfigured(config)) return config;
  if (!config.syncBaseURL || !config.syncToken) return config;

  try {
    const res = await fetch(
      `${config.syncBaseURL.replace(/\/+$/, "")}/api/agent/browser-jobs/bootstrap`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${config.syncToken}` },
      },
    );
    if (!res.ok) return config;
    const json = (await res.json()) as {
      bootstrap?: { convexURL?: string; userId?: string; syncBaseURL?: string };
    };
    const b = json?.bootstrap || {};
    return {
      ...config,
      convexURL: config.convexURL || String(b.convexURL || "").trim(),
      userId: config.userId || String(b.userId || "").trim(),
      syncBaseURL: config.syncBaseURL || String(b.syncBaseURL || "").trim(),
    };
  } catch {
    return config;
  }
}
