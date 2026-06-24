/**
 * AgpClient — REST + long-poll client for H-company's Agent Platform.
 *
 * Faithful TS port of the HoloTab extension's `lib/agp/agp-client.js`,
 * adapted for Node (global fetch + AbortSignal.timeout/any, Node 18+).
 * The one behavioral change: the extension re-authenticates a 401/403 by
 * refreshing a Portal SSO cookie; holo3-agent uses a static Portal-H API
 * key (HAI_API_KEY), so we surface auth errors instead of self-healing.
 *
 * Two transport surfaces live here:
 *   1. Trajectory REST  — createTrajectory / getTrajectoryChanges (the
 *      long-poll event stream) / interaction / flow-control / delete.
 *   2. Driver queue     — getDriverCommands / postDriverResult. These hang
 *      off `${root - /api/v1}/api/v1/commands/...`; since our base already
 *      ends in /api/v1 the strip-and-re-add is a no-op, but we mirror the
 *      extension's derivation exactly.
 */

import {
  AGP_API_BASE_URLS,
  AGP_CLIENT_HEADER,
  AGP_DEFAULT_TIMEOUT_MS,
  AGP_5XX_BACKOFF_MS,
  AGP_5XX_MAX_RETRIES,
  AGP_RATE_LIMIT_BACKOFF_MS,
  AGP_RATE_LIMIT_MAX_RETRIES,
  AGP_TRAJECTORY_IDLE_TIMEOUT_S,
  CALLER_ID_USER,
  DRIVER_FETCH_TIMEOUT_MS,
  DRIVER_POST_RESULT_BACKOFF_MS,
  DRIVER_POST_RESULT_RETRIES,
  DRIVER_POST_RESULT_TIMEOUT_MS,
  type AgpEnvironment,
} from "./constants";

export class AgpApiError extends Error {
  readonly status: number;
  readonly detail: string;
  readonly isAuthError: boolean;
  constructor(status: number, detail: string) {
    super(detail);
    this.name = "AgpApiError";
    this.status = status;
    this.detail = detail;
    this.isAuthError = status === 401 || status === 403;
  }
}

/** A single interaction event sent into a trajectory. */
export interface AgpInteraction {
  type: "user_message" | "flow_control" | "batch";
  message?: string;
  images?: string[];
  caller_id?: string;
  flow?: "pause" | "resume" | "stop" | "reset_history";
  origin?: string;
  events?: AgpInteraction[];
}

/** Reply shape from GET /trajectories/{id}/changes. */
export interface AgpChanges {
  new_events?: unknown[];
  status?: string;
  error?: string | null;
}

/** A driver command the server brain wants executed locally. */
export interface DriverCommand {
  id: string;
  command_uid?: string;
  name: string;
  args?: Record<string, unknown>;
}

/** The body we POST back per executed command. */
export interface DriverResult {
  result: unknown;
  error: string | null;
}

export interface CreateTrajectoryOpts {
  configOverride?: Record<string, unknown>;
  deleteAfterMin?: number;
  /** Extra task payload — the extension stuffs enabled skills here. */
  extra?: Record<string, unknown>;
  /** Override the interactive idle timeout (seconds). */
  idleTimeoutS?: number;
}

export interface AgpClientOptions {
  baseUrl?: string;
  apiKey?: string | null;
  timeoutMs?: number;
}

function resolveBaseUrl(): string {
  const override = process.env.AGP_BACKEND_URL?.trim();
  if (override) return override;
  // Default to EU: that's where the live Holo 3.1 HoloTab agent
  // (holo-tab-holo3-1-flash-visual-*) is hosted. The US (production) region's
  // public agents have dead model backends on this account. Override with
  // AGP_ENVIRONMENT=production if your agent lives there.
  const env = (process.env.AGP_ENVIRONMENT as AgpEnvironment) || "eu";
  return AGP_API_BASE_URLS[env] ?? AGP_API_BASE_URLS.eu;
}

/** Combine an external abort signal with a fresh timeout. */
function withTimeout(ms: number, extra?: AbortSignal): AbortSignal {
  const signals = [AbortSignal.timeout(ms)];
  if (extra) signals.push(extra);
  return AbortSignal.any(signals);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export class AgpClient {
  readonly baseUrl: string;
  /** Root with the trailing /api/v1 stripped — driver queue base. */
  private readonly commandRoot: string;
  private readonly apiKey: string | null;
  private readonly timeoutMs: number;

  constructor(opts: AgpClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? resolveBaseUrl()).replace(/\/$/, "");
    this.commandRoot = this.baseUrl.replace(/\/api\/v1$/, "").replace(/\/$/, "");
    this.apiKey =
      opts.apiKey ??
      process.env.HAI_API_KEY ??
      process.env.HCOMPANY_API_KEY ??
      null;
    this.timeoutMs = opts.timeoutMs ?? AGP_DEFAULT_TIMEOUT_MS;
  }

  get configured(): boolean {
    return !!this.apiKey;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      ...AGP_CLIENT_HEADER,
    };
  }

  /**
   * Core request helper with the extension's retry policy: 429 → bounded
   * backoff, 5xx on GET → bounded backoff, everything else throws an
   * AgpApiError carrying the server `detail`.
   */
  private async request<T>(
    path: string,
    init: RequestInit & { requestTimeout?: number } = {},
    rateRetry = 0,
    serverRetry = 0,
  ): Promise<T | null> {
    if (!this.apiKey) {
      throw new AgpApiError(0, "No AGP API key configured (set HAI_API_KEY).");
    }
    const url = `${this.baseUrl}${path}`;
    const { requestTimeout, signal, ...rest } = init;
    const res = await fetch(url, {
      ...rest,
      headers: { ...this.headers(), ...(rest.headers as object) },
      signal: withTimeout(requestTimeout ?? this.timeoutMs, signal ?? undefined),
    });

    if (!res.ok) {
      const detail = await this.extractDetail(res);
      if (res.status === 401 || res.status === 403) {
        throw new AgpApiError(
          res.status,
          detail || "AGP auth failed. Check HAI_API_KEY / Portal-H access.",
        );
      }
      if (res.status === 404) {
        throw new AgpApiError(
          404,
          detail || "Resource not found (agent or trajectory may be gone).",
        );
      }
      if (res.status === 429) {
        if (rateRetry < AGP_RATE_LIMIT_MAX_RETRIES) {
          await sleep((1 + rateRetry) * AGP_RATE_LIMIT_BACKOFF_MS + Math.random() * 1000);
          return this.request<T>(path, init, rateRetry + 1, serverRetry);
        }
        throw new AgpApiError(429, detail || "AGP rate limited.");
      }
      const method = (init.method || "GET").toUpperCase();
      if (
        method === "GET" &&
        (res.status === 502 || res.status === 503 || res.status === 504) &&
        serverRetry < AGP_5XX_MAX_RETRIES
      ) {
        await sleep((1 + serverRetry) * AGP_5XX_BACKOFF_MS + Math.random() * 500);
        return this.request<T>(path, init, rateRetry, serverRetry + 1);
      }
      throw new AgpApiError(res.status, detail || `AGP request failed (${res.status}).`);
    }

    if (res.status === 204) return null;
    const body = await res.text();
    if (!body) return null;
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new AgpApiError(res.status, `Invalid JSON in AGP response: ${body.slice(0, 200)}`);
    }
  }

  private async extractDetail(res: Response): Promise<string> {
    try {
      const j = (await res.json()) as { detail?: unknown };
      const d = j.detail;
      if (typeof d === "string") return d;
      if (Array.isArray(d)) {
        return d
          .map((x: { msg?: string; message?: string }) => x.msg || x.message || JSON.stringify(x))
          .join("; ");
      }
      if (d && typeof d === "object") {
        const o = d as { msg?: string; message?: string };
        return o.msg || o.message || JSON.stringify(d);
      }
    } catch {
      /* non-JSON error body */
    }
    return "";
  }

  // ---- Account ------------------------------------------------------------
  getQuota(): Promise<{ scope: string; limit: number; active: number; available: number } | null> {
    return this.request("/trajectories/quota", { method: "GET" });
  }

  listAgents(page = 1, size = 50, search?: string): Promise<unknown> {
    const q = new URLSearchParams({ page: String(page), size: String(size), owner: "organization" });
    if (search) q.set("search", search);
    return this.request(`/agents?${q}`, { method: "GET" });
  }

  // ---- Trajectory lifecycle ----------------------------------------------
  createTrajectory(
    agentId: string | null,
    startUrl: string | null,
    metadata: Record<string, unknown> | null,
    opts: CreateTrajectoryOpts = {},
  ): Promise<{ id: string; status?: string; created_at?: string; started_at?: string | null } | null> {
    const task: Record<string, unknown> = {
      type: "interactive",
      idle_timeout_s: opts.idleTimeoutS ?? AGP_TRAJECTORY_IDLE_TIMEOUT_S,
    };
    if (startUrl) task.start_url = startUrl;
    if (opts.extra && Object.keys(opts.extra).length > 0) task.extra = opts.extra;

    const body: Record<string, unknown> = { task, launch: true, store_calltrace: true };
    if (metadata) body.metadata = metadata;
    if (opts.configOverride) body.config_override = opts.configOverride;
    if (opts.deleteAfterMin != null) body.delete_after_min = opts.deleteAfterMin;

    const path = agentId
      ? `/agents/${encodeURIComponent(agentId)}/trajectories`
      : "/trajectories/";
    return this.request(path, { method: "POST", body: JSON.stringify(body) });
  }

  getTrajectory(id: string): Promise<unknown> {
    return this.request(`/trajectories/${id}`, { method: "GET" });
  }

  deleteTrajectory(id: string): Promise<unknown> {
    return this.request(`/trajectories/${id}`, { method: "DELETE" });
  }

  /**
   * Long-poll the event stream. The server holds the request open up to
   * `waitForSeconds` and returns the moment new events exist. `fromIndex`
   * is the cursor — each reply carries only events after it.
   */
  getTrajectoryChanges(
    id: string,
    fromIndex: number,
    opts: { signal?: AbortSignal; waitForSeconds?: number } = {},
  ): Promise<AgpChanges | null> {
    let path = `/trajectories/${id}/changes?from_index=${fromIndex}`;
    if (opts.waitForSeconds != null) path += `&wait_for_seconds=${opts.waitForSeconds}`;
    const requestTimeout =
      opts.waitForSeconds != null
        ? Math.max(this.timeoutMs, opts.waitForSeconds * 1000 + 5000)
        : undefined;
    return this.request(path, { method: "GET", signal: opts.signal, requestTimeout });
  }

  // ---- Interaction --------------------------------------------------------
  sendInteraction(id: string, interaction: AgpInteraction): Promise<unknown> {
    return this.request(`/trajectories/${id}/interaction`, {
      method: "POST",
      body: JSON.stringify(interaction),
    });
  }

  sendMessage(
    id: string,
    message: string,
    opts: { images?: string[]; callerId?: string } = {},
  ): Promise<unknown> {
    return this.sendInteraction(id, {
      type: "user_message",
      message,
      images: opts.images || [],
      caller_id: opts.callerId || CALLER_ID_USER,
    });
  }

  sendBatchInteraction(id: string, events: AgpInteraction[]): Promise<unknown> {
    return this.sendInteraction(id, { type: "batch", events });
  }

  sendFlowControl(
    id: string,
    flow: "pause" | "resume" | "stop" | "reset_history",
    origin?: string,
  ): Promise<unknown> {
    return this.sendInteraction(id, { type: "flow_control", flow, ...(origin && { origin }) });
  }

  // ---- Driver command queue ----------------------------------------------
  /**
   * Long-poll the driver queue for commands the brain wants executed.
   * Returns an array of commands, or null on a 204 (no commands ready).
   */
  async getDriverCommands(
    trajectoryId: string,
    waitForSeconds: number,
    signal?: AbortSignal,
  ): Promise<DriverCommand[] | null> {
    const url = `${this.commandRoot}/api/v1/commands/${trajectoryId}/commands?wait_for_seconds=${waitForSeconds}`;
    const res = await fetch(url, {
      method: "GET",
      headers: this.headers(),
      signal: withTimeout(DRIVER_FETCH_TIMEOUT_MS, signal),
    });
    if (res.status === 204) return null;
    if (res.status === 401 || res.status === 403) {
      throw new AgpApiError(res.status, `AGP driver auth error (${res.status}).`);
    }
    if (!res.ok) throw new AgpApiError(res.status, `AGP driver queue returned ${res.status}`);
    return (await res.json()) as DriverCommand[];
  }

  /** Deliver a command result, with the extension's retry/backoff. */
  async postDriverResult(
    commandId: string,
    commandUid: string | undefined,
    result: DriverResult,
    signal?: AbortSignal,
  ): Promise<void> {
    const url = `${this.commandRoot}/api/v1/commands/${commandId}/result`;
    const body = JSON.stringify({ ...result, command_uid: commandUid });
    for (let attempt = 0; attempt <= DRIVER_POST_RESULT_RETRIES; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: this.headers(),
          body,
          signal: withTimeout(DRIVER_POST_RESULT_TIMEOUT_MS, signal),
        });
        if (res.ok) return;
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError" && signal?.aborted) throw e;
      }
      if (attempt < DRIVER_POST_RESULT_RETRIES) {
        await sleep(DRIVER_POST_RESULT_BACKOFF_MS * (attempt + 1));
      }
    }
    throw new Error(
      `Failed to deliver result for command ${commandId} after ${DRIVER_POST_RESULT_RETRIES + 1} attempts`,
    );
  }
}
