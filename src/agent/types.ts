export type ProviderName = "remote" | "local" | "hcompany";

export interface PlanResult {
  action: string;
  usage?: Record<string, number>;
}

export interface GroundResult {
  x: number;
  y: number;
  raw?: [number, number];
  error?: string;
}

export interface ProviderClient {
  name: ProviderName;
  warm(): Promise<{ ready: boolean; warmSeconds?: number }>;
  plan(args: {
    task: string;
    history: string[];
    screenshotB64: string;
    screen: [number, number];
    /**
     * Aborts the in-flight HTTP/SDK call. The loop wires this to a per-step
     * AbortController whose `abort()` is called the moment cancelFlag flips,
     * so pressing Stop kills the request immediately instead of waiting
     * ~10s for the request + step-pause to finish.
     */
    signal?: AbortSignal;
  }): Promise<PlanResult>;
  ground(args: {
    instruction: string;
    screenshotB64: string;
    screen: [number, number];
    signal?: AbortSignal;
  }): Promise<GroundResult>;
}

export interface AgentEvents {
  onThought(text: string): Promise<void> | void;
  onGround(coords: { x: number; y: number }): Promise<void> | void;
  onAction(action: { type: string; payload: Record<string, unknown> }): Promise<void> | void;
  onScreenshot(pngBuffer: Buffer): Promise<void> | void;
  onError(message: string): Promise<void> | void;
  onStatus(text: string): Promise<void> | void;
  /**
   * Emitted once per run when the extractor produces the user-facing
   * answer. Distinct from onThought (the narrator's friendly fluff) and
   * onStatus (transient progress lines) — this is the actual deliverable.
   * Persisted to Convex as `kind: "result"` and rendered as a special
   * bubble in the UI so it doesn't get lost in the action stream.
   */
  onResult?(text: string): Promise<void> | void;
}
