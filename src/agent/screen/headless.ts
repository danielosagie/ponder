import type { ClickOpts, Screenshot, ScreenAdapter } from "./types";

/**
 * Thrown when a vision action fires under serveHeadless. The loop catches
 * this and surfaces it as a session error so the dev sees "the planner asked
 * for `click on the search bar` but there's no screen here — give it a more
 * structured task or a richer browser snapshot."
 */
export class HeadlessVisionActionError extends Error {
  constructor(action: string) {
    super(
      `Vision action "${action}" fired in headless mode. Headless serving ` +
        "expects browser.* actions only. Either narrow the task so the planner " +
        "uses browser actions, or run on a desktop with a real ScreenAdapter.",
    );
    this.name = "HeadlessVisionActionError";
  }
}

/** 1×1 transparent PNG. Sent to the planner when there's no real screen. */
const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

/**
 * Screen adapter for headless serving via `ponder/server`. Screenshots return
 * a 1×1 placeholder so the planner doesn't crash when it asks for a frame
 * (the real signal flows through the browser snapshot). Every input action
 * throws HeadlessVisionActionError — the loop converts that into a session
 * error rather than silently dropping clicks.
 *
 * Distinct from createNoopScreenAdapter, which throws on screenshot too —
 * use that when you want to assert the loop never even *captures* a frame.
 */
export function createHeadlessScreenAdapter(): ScreenAdapter {
  return {
    async screenshot(): Promise<Screenshot> {
      return { png: ONE_BY_ONE_PNG, width: 1, height: 1 };
    },
    async size(): Promise<{ width: number; height: number }> {
      return { width: 1, height: 1 };
    },
    async click(_x: number, _y: number, _opts?: ClickOpts): Promise<void> {
      throw new HeadlessVisionActionError("click");
    },
    async drag(): Promise<void> {
      throw new HeadlessVisionActionError("drag");
    },
    async move(): Promise<void> {
      throw new HeadlessVisionActionError("move");
    },
    async typeText(): Promise<void> {
      throw new HeadlessVisionActionError("type");
    },
    async pressCombo(): Promise<void> {
      throw new HeadlessVisionActionError("press");
    },
    async scroll(): Promise<void> {
      throw new HeadlessVisionActionError("scroll");
    },
    sleep(ms: number): Promise<void> {
      return new Promise((r) => setTimeout(r, ms));
    },
    backgroundMode: false,
  };
}
