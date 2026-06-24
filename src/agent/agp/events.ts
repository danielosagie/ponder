/**
 * TrajectoryPoller — long-polls the AGP event stream and turns it into
 * narration + lifecycle signals. Port of the relevant half of the
 * extension's `lib/agp/agp-events.js`, trimmed to what a CLI/headless
 * driver needs (no chrome.* UI plumbing).
 *
 * Events arrive wrapped (observed live in bench/agp-protocol-probe.ts):
 *   { type:"AgentEvent", data:{ ..., event:{ kind:"policy_event"|... } } }
 * plus bare lifecycle events: RequestStartEvent, AgentStartedEvent,
 * ActiveStateChangeEvent{state:"idle"|"running"}, MetricsUpdateEvent.
 * We unwrap to the inner event and emit a normalized shape.
 */

import {
  AGP_LONG_POLL_SECONDS,
  AGP_POLLER_RATE_LIMIT_BACKOFF_MS,
  AGP_TERMINAL_STATUSES,
} from "./constants";
import { AgpApiError, type AgpClient } from "./client";

export interface NormalizedEvent {
  kind: string;
  /** Best-effort human-readable line for narration. */
  text?: string;
  /** For policy_event: the requested tool actions (names). */
  tools?: string[];
  /** For answer_event: the final answer. */
  answer?: string;
  /** For error_event. */
  error?: string;
  /** For lifecycle ActiveStateChangeEvent. */
  state?: string;
  raw?: unknown;
}

export interface TrajectoryPollerOpts {
  onEvent?: (ev: NormalizedEvent) => void;
  /** Wrapped index callback so the caller can persist a cursor if needed. */
  onCursor?: (index: number) => void;
}

function getInner(e: unknown): Record<string, unknown> {
  if (!e || typeof e !== "object") return {};
  const o = e as Record<string, unknown>;
  if (typeof o.kind === "string") return o;
  const data = o.data as Record<string, unknown> | undefined;
  if (data?.event) {
    const ev = data.event as Record<string, unknown>;
    if (ev.event && typeof (ev.event as Record<string, unknown>).kind === "string") {
      return ev.event as Record<string, unknown>;
    }
    if (typeof ev.kind === "string") return ev;
  }
  if (o.event) {
    const ev = o.event as Record<string, unknown>;
    if (typeof ev.kind === "string") return ev;
  }
  return o;
}

function asText(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string").join("\n");
  return "";
}

function normalize(raw: unknown): NormalizedEvent | null {
  const outer = raw as Record<string, unknown>;
  const inner = getInner(raw);
  const kind = (inner.kind as string) || (outer?.type as string) || "";

  // Bare lifecycle events.
  if (!inner.kind) {
    const type = (outer?.type as string) || "";
    if (type === "ActiveStateChangeEvent") {
      const state = ((outer?.data as Record<string, unknown>)?.state as string) || "";
      return { kind: "lifecycle", state, raw };
    }
    if (type) return { kind: "lifecycle", text: type, raw };
    return null;
  }

  switch (inner.kind) {
    case "policy_event": {
      const msg = inner.message as Record<string, unknown> | undefined;
      const content = asText(msg?.content ?? inner.content);
      const toolReqs = Array.isArray(inner.tool_reqs) ? (inner.tool_reqs as Array<Record<string, unknown>>) : [];
      return {
        kind: "policy_event",
        text: content,
        tools: toolReqs.map((t) => String(t.tool_name || "action")),
        raw,
      };
    }
    case "message_event":
      return { kind: "message_event", text: asText(inner.content), raw };
    case "observation_event":
      return { kind: "observation_event", text: asText(inner.text), raw };
    case "tool_result":
      return { kind: "tool_result", text: typeof inner.result === "string" ? inner.result : "", raw };
    case "answer_event": {
      const ans = inner.answer;
      return { kind: "answer_event", answer: typeof ans === "string" ? ans : JSON.stringify(ans), raw };
    }
    case "error_event":
      return { kind: "error_event", error: String(inner.error || "Agent error"), raw };
    case "flow_event":
      return { kind: "flow_event", text: String(inner.flow || ""), raw };
    default:
      return { kind, raw };
  }
}

export class TrajectoryPoller {
  private readonly client: AgpClient;
  private readonly trajectoryId: string;
  private readonly opts: TrajectoryPollerOpts;
  private running = false;
  private abort: AbortController | null = null;
  private cursor = 0;
  private donePromise: Promise<void>;
  private resolveDone: () => void = () => {};
  private idlePromise: Promise<void>;
  private resolveIdle: (() => void) | null = null;

  /** Final answer text, if the brain emitted one. */
  answer: string | null = null;
  /** Terminal status, once reached. */
  terminalStatus: string | null = null;
  /** Last error surfaced by the brain. */
  lastError: string | null = null;

  constructor(client: AgpClient, trajectoryId: string, opts: TrajectoryPollerOpts = {}) {
    this.client = client;
    this.trajectoryId = trajectoryId;
    this.opts = opts;
    this.donePromise = new Promise((r) => (this.resolveDone = r));
    this.idlePromise = new Promise((r) => (this.resolveIdle = r));
  }

  start(fromIndex = 0): void {
    if (this.running) return;
    this.running = true;
    this.cursor = fromIndex;
    this.abort = new AbortController();
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
    this.resolveIdle?.();
    this.resolveIdle = null;
    this.resolveDone();
  }

  waitUntilDone(): Promise<void> {
    return this.donePromise;
  }

  /** Resolves on the first idle/running transition or after `timeoutMs`. */
  waitForInitialIdle(timeoutMs = 60_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout>;
    const guard = new Promise<void>((r) => {
      timer = setTimeout(r, timeoutMs);
    });
    return Promise.race([this.idlePromise, guard]).finally(() => clearTimeout(timer));
  }

  private async loop(): Promise<void> {
    let backoff = 1000;
    while (this.running) {
      const t0 = Date.now();
      try {
        const changes = await this.client.getTrajectoryChanges(this.trajectoryId, this.cursor, {
          signal: this.abort?.signal,
          waitForSeconds: AGP_LONG_POLL_SECONDS,
        });
        backoff = 1000;
        const elapsed = Date.now() - t0;
        if (elapsed < 100) await new Promise((r) => setTimeout(r, 100 - elapsed));
        if (!changes) continue;
        const events = changes.new_events ?? [];
        for (const e of events) {
          const norm = normalize(e);
          if (norm) {
            if (norm.kind === "lifecycle" && (norm.state === "idle" || norm.state === "running")) {
              this.resolveIdle?.();
              this.resolveIdle = null;
            }
            if (norm.kind === "answer_event" && norm.answer) this.answer = norm.answer;
            if (norm.kind === "error_event") this.lastError = norm.error ?? null;
            this.opts.onEvent?.(norm);
          }
          this.cursor++;
          this.opts.onCursor?.(this.cursor);
        }
        // A one-shot task is complete once the brain emits its answer; don't
        // hang until the idle timeout waiting for a non-existent next event.
        if (this.answer) {
          this.terminalStatus ??= "completed";
          this.stop();
          break;
        }
        if (changes.status && (AGP_TERMINAL_STATUSES as readonly string[]).includes(changes.status)) {
          this.terminalStatus = changes.status;
          if (changes.status === "failed" || changes.status === "timed_out") {
            this.lastError = changes.error || `Trajectory ${changes.status}.`;
          }
          this.stop();
          break;
        }
      } catch (e) {
        if (!this.running || this.abort?.signal.aborted) break;
        if (e instanceof AgpApiError && e.isAuthError) {
          this.lastError = "AGP auth error. Check HAI_API_KEY.";
          this.stop();
          break;
        }
        if (e instanceof AgpApiError && e.status === 429) {
          await new Promise((r) => setTimeout(r, AGP_POLLER_RATE_LIMIT_BACKOFF_MS));
          continue;
        }
        backoff = Math.min(backoff * 2, 30_000);
        console.warn(`[agp-poller] error (backoff ${backoff}ms):`, (e as Error).message);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
}
