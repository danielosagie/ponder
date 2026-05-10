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
  /**
   * OPTIONAL batch-grounding: ONE screenshot, N instructions, N coords.
   *
   * Provider-side optimization. When a provider implements this, callers
   * (notably `agent_click_sequence` in src/mcp/tools.ts) get the full
   * benefit of:
   *   • a single image upload over the wire (bandwidth + latency),
   *   • a single Modal/H Company HTTP round-trip (TLS + parsing overhead),
   *   • server-side fan-out to a continuous-batching inference slot
   *     (e.g. llama-server --parallel 4) so multiple prompts can share
   *     a forward pass instead of serializing through one slot.
   *
   * Providers without server-side batching (Local Ollama, H Company in
   * its current shape) simply omit this method; callers detect the
   * missing implementation and fall back to `Promise.all` of `ground()`,
   * which still saves the per-call screenshot capture but pays N HTTP
   * round-trips and N image uploads.
   *
   * Result-list ORDER must match the input `instructions` order. Per-
   * target failures appear as entries with `error` set — the batch
   * itself succeeds, the orchestrator decides whether one bad target
   * aborts the action sequence or not.
   */
  groundBatch?(args: {
    instructions: string[];
    screenshotB64: string;
    screen: [number, number];
    signal?: AbortSignal;
  }): Promise<GroundResult[]>;
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
