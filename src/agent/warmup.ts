import type { ProviderClient } from "./types";

type State = "cold" | "warming" | "ready" | "error";

export class WarmupQueue {
  private state: State = "cold";
  private warmingPromise: Promise<void> | null = null;
  private waiters: Array<() => void> = [];
  private errorMessage: string | null = null;
  private listeners = new Set<(state: State, detail?: string) => void>();

  constructor(private provider: ProviderClient) {}

  getProvider(): ProviderClient {
    return this.provider;
  }

  setProvider(p: ProviderClient): void {
    if (p === this.provider) return;
    this.provider = p;
    this.state = "cold";
    this.warmingPromise = null;
    this.errorMessage = null;
    this.emit();
  }

  getState(): State {
    return this.state;
  }

  onChange(fn: (state: State, detail?: string) => void): () => void {
    this.listeners.add(fn);
    fn(this.state, this.errorMessage ?? undefined);
    return () => this.listeners.delete(fn);
  }

  warmInBackground(): void {
    if (this.state === "ready" || this.state === "warming") return;
    // .catch() swallows the rejection — state/listeners are already updated
    // inside warm()'s catch block, so this is just to avoid an UnhandledPromiseRejection.
    this.warm().catch(() => {});
  }

  async warm(): Promise<void> {
    if (this.state === "ready") return;
    if (this.warmingPromise) return this.warmingPromise;
    this.state = "warming";
    this.errorMessage = null;
    this.emit();

    this.warmingPromise = (async () => {
      try {
        await this.provider.warm();
        this.state = "ready";
        this.emit();
        const w = this.waiters.splice(0);
        w.forEach((fn) => fn());
      } catch (e: unknown) {
        this.state = "error";
        this.errorMessage = e instanceof Error ? e.message : String(e);
        this.emit();
        throw e;
      } finally {
        this.warmingPromise = null;
      }
    })();
    return this.warmingPromise;
  }

  async waitReady(): Promise<void> {
    if (this.state === "ready") return;
    if (this.state === "cold") this.warmInBackground();
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.state, this.errorMessage ?? undefined);
  }
}
