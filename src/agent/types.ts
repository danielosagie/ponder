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
}
