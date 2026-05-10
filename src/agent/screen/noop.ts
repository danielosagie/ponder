import type { ClickOpts, Screenshot, ScreenAdapter } from "./types";

const REASON =
  "ScreenAdapter not configured. Pass `screen` in RunOptions, or use the " +
  "Ponder desktop app which provides createNutScreenAdapter() by default.";

function refuse(): never {
  throw new Error(REASON);
}

/**
 * No-op adapter that throws on every call. Useful when an SDK consumer wants
 * to embed the agent loop in a context where they only ever take browser-level
 * actions (via Playwriter) and the screen adapter should never be invoked. If
 * the loop ever does try to take a screen action, fail loudly instead of
 * silently doing nothing.
 */
export function createNoopScreenAdapter(): ScreenAdapter {
  return {
    async screenshot(): Promise<Screenshot> {
      return refuse();
    },
    async size(): Promise<{ width: number; height: number }> {
      return refuse();
    },
    async click(_x: number, _y: number, _opts?: ClickOpts): Promise<void> {
      refuse();
    },
    async drag(): Promise<void> {
      refuse();
    },
    async move(): Promise<void> {
      refuse();
    },
    async typeText(): Promise<void> {
      refuse();
    },
    async pressCombo(): Promise<void> {
      refuse();
    },
    async scroll(): Promise<void> {
      refuse();
    },
    sleep(ms: number): Promise<void> {
      return new Promise((r) => setTimeout(r, ms));
    },
    backgroundMode: false,
  };
}
