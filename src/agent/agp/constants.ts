/**
 * AGP (H-company Agent Platform) protocol constants.
 *
 * Reverse-engineered from the HoloTab Chrome extension's bundled
 * `lib/constants.js` (the decoded numeric values are documented inline).
 * These drive holo3-agent's THIN-DRIVER mode: instead of running the
 * plan→ground→verify brain client-side, holo3-agent creates a server-side
 * "trajectory", long-polls a driver command queue, executes each command
 * against the local Chrome (via playwriter), and posts results back. The
 * planning/grounding agent loop runs on H-company's servers.
 *
 * Everything here is intentionally a faithful copy of the extension's
 * tuned values so the server brain behaves identically to how it does in
 * production HoloTab. Override the base URL / long-poll window via env if
 * you need staging or a shorter idle timeout.
 */

/** Production + EU AGP REST roots. Both already include the `/api/v1`
 *  path segment — trajectory endpoints hang directly off this; the driver
 *  command queue strips `/api/v1` and re-adds it (see client.ts). */
export const AGP_API_BASE_URLS = {
  production: "https://agp.hcompany.ai/api/v1",
  eu: "https://agp.eu.hcompany.ai/api/v1",
} as const;

export type AgpEnvironment = keyof typeof AGP_API_BASE_URLS;

// ---- REST client (trajectories / interaction / changes) -------------------
/** Server holds the /changes long-poll open up to this many seconds and
 *  returns the instant new events exist — near-zero brain→client latency. */
export const AGP_LONG_POLL_SECONDS = 20;
/** Default fetch timeout for non-long-poll requests. */
export const AGP_DEFAULT_TIMEOUT_MS = 30_000;
/** Fallback cycle interval for the paused/empty poll branches. */
export const AGP_POLL_ACTIVE_INTERVAL_MS = 100;
/** Server kills an interactive trajectory after this much idle time. */
export const AGP_TRAJECTORY_IDLE_TIMEOUT_S = 1800;
export const AGP_5XX_MAX_RETRIES = 2;
export const AGP_5XX_BACKOFF_MS = 1500;
export const AGP_RATE_LIMIT_MAX_RETRIES = 2;
export const AGP_RATE_LIMIT_BACKOFF_MS = 2000;
/** Poller-specific 429 backoff (the changes long-poll loop). */
export const AGP_POLLER_RATE_LIMIT_BACKOFF_MS = 5000;

/** A trajectory in any of these statuses is finished. */
export const AGP_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "timed_out",
  "interrupted",
] as const;

/** When re-attaching to a terminal-but-resumable trajectory, keep polling
 *  this many times for it to transition out of terminal before giving up. */
export const POLLER_MAX_IGNORE_TERMINAL_POLLS = 15;

// ---- Driver command queue --------------------------------------------------
export const DRIVER_LONG_POLL_SECONDS = 20;
export const DRIVER_POLL_INTERVAL_MS = 300;
export const DRIVER_FETCH_TIMEOUT_MS = 30_000;
export const DRIVER_POST_RESULT_RETRIES = 2;
export const DRIVER_POST_RESULT_BACKOFF_MS = 500;
export const DRIVER_POST_RESULT_TIMEOUT_MS = 10_000;

// ---- Observation / execution timing ---------------------------------------
/** Settle delay after switching/launching the viewport before observing. */
export const VIEWPORT_SETTLE_DELAY_MS = 300;
/** DOM-quiesce wait: resolve once the DOM is quiet for this long... */
export const DOM_STABLE_QUIESCE_MS = 80;
/** ...capped by this ceiling so a perpetually-mutating page can't hang. */
export const DOM_STABLE_TIMEOUT_MS = 1000;
export const NEW_TAB_SETTLE_MS = 2000;
export const NAVIGATION_TIMEOUT_MS = 15_000;

// ---- Accessibility snapshot ------------------------------------------------
export const A11Y_SNAPSHOT_MAX_CHARS = 12_000;
export const A11Y_SNAPSHOT_MAX_DEPTH = 12;
export const A11Y_VISUAL_MIN_SIZE_PX = 50;
/** Ref tokens emitted in the snapshot are `${PREFIX}${n}` → e0, e1, ... */
export const A11Y_REF_PREFIX = "e";

// ---- Caller ids (interaction provenance) ----------------------------------
export const CALLER_ID_USER = "user";
export const CALLER_ID_SESSION_CONTEXT = "session_context";
export const CALLER_ID_WORKFLOW_CONTEXT = "workflow_context";
export const CALLER_ID_EXTENSION = "extension";

/** Header the extension sends on every AGP request; some server features
 *  (notably the driver command flow) are gated on it, so we mirror it. */
export const AGP_CLIENT_HEADER = { "X-From-htab": "true" } as const;

/** Hard cap on driver commands executed per run — runaway-loop backstop. */
export const MAX_RUN_STEPS = 120;
