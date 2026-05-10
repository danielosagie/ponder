/**
 * PonderClient — thin dispatch client for SDK consumers.
 *
 * Talks to the dev's own Convex deployment (the same one the customer's
 * Ponder desktop app is configured against via the ponder:// deep-link).
 * Uses string-form FunctionReferences so the SDK doesn't depend on the
 * consumer's generated Convex types — they just need to copy the schema
 * from `ponder/convex/*` (the CLI's `init` does this automatically).
 */
import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import type { ProviderName } from "./agent/types";

export type SessionStatus =
  | "pending"
  | "running"
  | "done"
  | "error"
  | "cancelled";

export type StepKind =
  | "thought"
  | "ground"
  | "action"
  | "screenshot"
  | "error"
  | "status"
  | "result";

export interface Step {
  _id: string;
  sessionId: string;
  index: number;
  kind: StepKind;
  text?: string;
  coords?: { x: number; y: number };
  action?: { type: string; payload: unknown };
  screenshotId?: string;
  createdAt: number;
}

export interface DispatchOptions {
  /** Override the client's default provider for this single dispatch. */
  provider?: ProviderName;
}

export interface DispatchResult {
  sessionId: string;
}

export interface PonderClientOptions {
  /** Convex deployment URL (e.g. https://example.convex.cloud). */
  convexUrl: string;
  /** Default provider used when dispatch() is called without one. */
  defaultProvider?: ProviderName;
  /** Optional auth token forwarded to the underlying Convex client. */
  auth?: string;
}

export class PonderClient {
  private readonly http: ConvexHttpClient;
  private readonly convexUrl: string;
  private readonly auth?: string;
  private readonly defaultProvider: ProviderName;
  private ws: ConvexClient | null = null;

  constructor(opts: PonderClientOptions) {
    this.convexUrl = opts.convexUrl;
    this.auth = opts.auth;
    this.defaultProvider = opts.defaultProvider ?? "hcompany";
    this.http = new ConvexHttpClient(opts.convexUrl);
    if (opts.auth) this.http.setAuth(opts.auth);
  }

  private getWs(): ConvexClient {
    if (!this.ws) {
      this.ws = new ConvexClient(this.convexUrl);
      const auth = this.auth;
      if (auth) this.ws.setAuth(async () => auth);
    }
    return this.ws;
  }

  /** Enqueue a task. Returns the new session's id. */
  async dispatch(
    task: string,
    opts: DispatchOptions = {},
  ): Promise<DispatchResult> {
    const sessionId = await this.http.mutation(anyApi.sessions.create, {
      prompt: task,
      provider: opts.provider ?? this.defaultProvider,
    });
    return { sessionId: String(sessionId) };
  }

  /**
   * Subscribe to step events for a session. The callback fires once per new
   * step (deduped client-side); the returned function tears the subscription
   * down.
   */
  subscribe(sessionId: string, cb: (step: Step) => void): () => void {
    const seen = new Set<string>();
    const unsub = this.getWs().onUpdate(
      anyApi.steps.listBySession,
      { sessionId },
      (rows: unknown) => {
        const list = (rows as Step[] | null) ?? [];
        for (const row of list) {
          if (seen.has(row._id)) continue;
          seen.add(row._id);
          cb(row);
        }
      },
    );
    return unsub;
  }

  /** Mark a session cancelled. The desktop app stops at the next await boundary. */
  async cancel(sessionId: string): Promise<void> {
    await this.http.mutation(anyApi.sessions.setStatus, {
      sessionId,
      status: "cancelled",
    });
  }

  /**
   * Read the final state of a session. Returns the latest `result` step text
   * (the user-facing answer the extractor produced), the session status, and
   * any error message captured at end-of-run.
   */
  async getResult(
    sessionId: string,
  ): Promise<{ status: SessionStatus; result?: string; error?: string }> {
    const session = (await this.http.query(anyApi.sessions.get, {
      sessionId,
    })) as null | { status: SessionStatus; error?: string };
    if (!session) return { status: "error", error: "session not found" };

    const steps = (await this.http.query(anyApi.steps.tail, {
      sessionId,
      n: 50,
    })) as Step[];
    const resultRow = [...steps].reverse().find((r) => r.kind === "result");
    return {
      status: session.status,
      result: resultRow?.text,
      error: session.error,
    };
  }

  /** Tear down any open websocket subscription. Safe to call multiple times. */
  async close(): Promise<void> {
    const ws = this.ws;
    this.ws = null;
    if (ws) await ws.close();
  }
}
