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
}

function envStr(...keys: string[]): string {
  for (const key of keys) {
    const value = String(process.env[key] || "").trim();
    if (value) return value;
  }
  return "";
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
    bridgePort: Number(process.env.PONDER_BRIDGE_PORT ?? 7900),
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
