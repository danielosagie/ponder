import type { ProviderClient, PlanResult, GroundResult } from "../types";

interface RemoteConfig {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

// Modal exposes each @fastapi_endpoint as a separate web function with its
// own subdomain: `${prefix}-<funcname>.modal.run`. Map our logical paths
// (`/warm`, `/plan`, `/ground`, `/ground/batch`) to the actual Modal
// function names.
const PATH_TO_FUNC: Record<string, string> = {
  "/warm": "warm",
  "/plan": "plan-endpoint",
  "/step": "step-endpoint",
  "/ground": "ground-endpoint",
  "/ground/batch": "ground-batch-endpoint",
  "/health": "health",
};

function resolveUrl(baseUrl: string, path: string): string {
  // Accept either:
  //   1. A bare prefix like  "https://you--holo3-agent"
  //      → produces        "https://you--holo3-agent-warm.modal.run"
  //   2. A full URL like   "https://you--holo3-agent-warm.modal.run"
  //      → strips the trailing "-<funcname>.modal.run" and rebuilds per path
  const func = PATH_TO_FUNC[path] ?? path.replace(/^\//, "");
  const prefix = baseUrl
    .replace(/\/+$/, "")
    .replace(
      /-(?:warm|plan-endpoint|step-endpoint|ground-endpoint|ground-batch-endpoint|health)\.modal\.run$/,
      "",
    )
    .replace(/\.modal\.run$/, "");
  return `${prefix}-${func}.modal.run`;
}

export function createRemoteProvider(cfg: RemoteConfig): ProviderClient {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.token}`,
  };

  async function post<T>(
    path: string,
    body: unknown,
    timeoutMs = 60_000,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    // Bail before opening a socket if the caller already aborted (Stop pressed
    // between awaits). Otherwise we'd waste a Modal request that gets dropped
    // mid-flight when the next abort check fires.
    if (externalSignal?.aborted) {
      throw new Error("remote cancelled");
    }
    // Composite signal: abort if the caller's signal aborts (Stop) OR our
    // internal timeout fires. Either path collapses to one ctrl. Mirrors
    // hcompany.ts so cancel-mid-drag works consistently across providers.
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const onExternalAbort = () => ctrl.abort();
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    try {
      const res = await fetchImpl(resolveUrl(cfg.baseUrl, path), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`remote ${path} ${res.status}: ${text.slice(0, 200)}`);
      }
      return (await res.json()) as T;
    } catch (e: unknown) {
      // External cancel turns into a clean "cancelled" error so the loop
      // can return early without surfacing a scary fetch-aborted trace.
      if (externalSignal?.aborted) {
        throw new Error("remote cancelled");
      }
      throw e;
    } finally {
      clearTimeout(t);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }

  return {
    name: "remote",
    async warm() {
      const r = await post<{ ready: boolean; warm_seconds?: number }>(
        "/warm",
        {},
        300_000,
      );
      return { ready: r.ready, warmSeconds: r.warm_seconds };
    },
    async plan(args): Promise<PlanResult> {
      return post<PlanResult>(
        "/plan",
        {
          task: args.task,
          history: args.history,
          screenshot_b64: args.screenshotB64,
          screen: args.screen,
        },
        60_000,
        args.signal,
      );
    },
    async ground(args): Promise<GroundResult> {
      return post<GroundResult>(
        "/ground",
        {
          instruction: args.instruction,
          screenshot_b64: args.screenshotB64,
          screen: args.screen,
        },
        60_000,
        args.signal,
      );
    },
    async step(args): Promise<{
      action: string;
      x: number | null;
      y: number | null;
      raw?: [number, number];
      usage?: Record<string, number>;
    }> {
      return post(
        "/step",
        {
          task: args.task,
          history: args.history,
          screenshot_b64: args.screenshotB64,
          screen: args.screen,
        },
        60_000,
        args.signal,
      );
    },
    async groundBatch(args): Promise<GroundResult[]> {
      // Timeout shaped to the inference cost. Bumped from (30s + 6s/extra)
      // to (60s + 10s/extra) after observing the actual /ground/batch wall
      // come in at 60.7s for N=6 on the May-10 llama.cpp build — JUST over
      // the previous 60s ceiling, causing the TS client to abandon and
      // fall back to Promise.all 0.7s before the server's response was
      // already on the wire. The fallback path is slower (single /ground
      // calls don't batch through llama-server's --parallel 4 slots once
      // Modal's max_inputs=4 cap is hit), so a too-tight timeout actively
      // makes things worse. With the bump, N=6 gets 60+50=110s, N=12 gets
      // 60+110=170s — both safely within the Modal endpoint's 300s
      // function ceiling.
      const n = args.instructions.length;
      const timeoutMs = Math.min(180_000, 60_000 + Math.max(0, n - 1) * 10_000);
      // Server returns either {results: GroundResult[]} on success or
      // {error: "..."} on validation failure (empty list, oversized batch,
      // etc.). The error case throws so callers' fallback path can run
      // — they fan out to N parallel ground() calls instead.
      //
      // `crop` is forwarded snake_case for the FastAPI shim. When set, the
      // server PIL-crops the screenshot before grounding and returns coords
      // in CROPPED-image space — caller translates back via `r.x + crop.x`.
      const body: Record<string, unknown> = {
        instructions: args.instructions,
        screenshot_b64: args.screenshotB64,
        screen: args.screen,
      };
      if (args.crop) {
        body.crop = {
          x: args.crop.x,
          y: args.crop.y,
          w: args.crop.w,
          h: args.crop.h,
        };
      }
      const r = await post<{ results?: GroundResult[]; error?: string }>(
        "/ground/batch",
        body,
        timeoutMs,
        args.signal,
      );
      if (r.error || !r.results) {
        throw new Error(`groundBatch: ${r.error ?? "no results returned"}`);
      }
      if (r.results.length !== n) {
        throw new Error(
          `groundBatch: expected ${n} results, got ${r.results.length}`,
        );
      }
      return r.results;
    },
  };
}
