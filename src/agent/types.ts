// "composite" = a hosted smart planner wrapping one of the three
// executors (Surfer-2 split): plan() → planner, ground() → executor.
// Not user-selectable in preferences — it activates via env
// (GEMINI_API_KEY / PLANNER_API_KEY) on top of whichever executor the
// preference resolves to.
export type ProviderName = "remote" | "local" | "hcompany" | "composite";

/** The concrete executor backends — what Convex persistence and the
 *  preferences file accept. "composite" maps to its underlying executor
 *  via factory.executorNameFor(). */
export type ExecutorProviderName = Exclude<ProviderName, "composite">;

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
   * OPTIONAL combined plan+ground: ONE model call returns the next
   * action AND, for mouse-aimed verbs, the click point — halving
   * per-step model time vs the sequential plan→ground pair (each of
   * which re-uploads the screenshot and re-runs the vision tower on
   * it). x/y are SCREEN-space ints (rescaled server-side like ground)
   * or null for keyboard/scroll/wait/DONE verbs and for drag (two
   * points — drag stays on the split path). Callers MUST treat null
   * coords on a mouse-aimed action as "ground separately".
   */
  step?(args: {
    task: string;
    history: string[];
    screenshotB64: string;
    screen: [number, number];
    signal?: AbortSignal;
  }): Promise<{
    action: string;
    x: number | null;
    y: number | null;
    raw?: [number, number];
    usage?: Record<string, number>;
  }>;
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
    /**
     * OPTIONAL screenshot crop rect, in screenshot-pixel space (NOT
     * screen-space — apply offsetX/offsetY translation BEFORE passing).
     * When set, the server crops the screenshot to this rect before
     * grounding, and the returned coords are in CROPPED-image space.
     * The caller must translate back: `actual_x = result.x + crop.x`.
     *
     * Used by `agent_click_sequence` with `targetApp` — defends against
     * the embedded-screenshot decoy (a chat showing the same app's
     * screenshot on the same display) by giving the vision model only
     * the real app's pixels.
     *
     * Caller-side bounds-checking IS REQUIRED: the server has no way
     * to know whether a grounded coord landing outside the crop
     * indicates a decoy hit vs. a legitimate edge. Validate at the
     * caller; treat out-of-bounds as a recoverable error.
     */
    crop?: { x: number; y: number; w: number; h: number };
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
