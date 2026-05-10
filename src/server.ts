/**
 * `ponder/server` — run the agent loop in your own Node process instead of
 * dispatching to a customer's Ponder desktop app. Useful for browser-only
 * automation where there's no end-user machine in the loop (background jobs,
 * scheduled scrapers, server-side workflows).
 *
 * Marks the session with `runtime: "headless"` so item 7's desktop fleet
 * doesn't try to claim it. Streams every step into your Convex deployment,
 * so PonderClient.subscribe() still works for observability.
 */
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { runTask } from "./agent/loop";
import { makeProvider, type ProviderConfig } from "./agent/index";
import {
  createHeadlessScreenAdapter,
  HeadlessVisionActionError,
} from "./agent/screen/headless";
import { createConvexEvents } from "./agent/events/convex";
import type { BrowserClient } from "./agent/browser/types";

export interface ServeHeadlessOptions {
  /** Natural-language task description handed to the planner. */
  task: string;
  /** Convex deployment URL the run will stream into. */
  convexUrl: string;
  /** Provider config (hosted / modal / local). */
  provider: ProviderConfig;
  /** Optional auth token forwarded to Convex (e.g. Cloud API key). */
  auth?: string;
  /**
   * Optional pre-built BrowserClient. Pass your own Playwright wrapper for
   * headed/headless Chrome automation. Without one, every action will throw
   * HeadlessVisionActionError because there's no screen to fall back to.
   */
  browser?: BrowserClient;
  /** Cancellation hook checked at every loop boundary. */
  shouldCancel?: () => boolean;
}

export interface ServeHeadlessResult {
  /** The Convex sessions._id this run wrote to. */
  sessionId: string;
  /** Final outcome bucket from the loop. */
  outcome: "done" | "cancelled" | "exhausted" | "error";
  /** Any captured error message; populated when outcome === "error". */
  error?: string;
}

/**
 * Run a single Ponder task to completion in this process. Returns when the
 * loop exits (done / cancelled / exhausted) or an unrecoverable error fires.
 */
export async function serveHeadless(
  opts: ServeHeadlessOptions,
): Promise<ServeHeadlessResult> {
  const convex = new ConvexHttpClient(opts.convexUrl);
  if (opts.auth) convex.setAuth(opts.auth);

  const sessionId = String(
    await convex.mutation(anyApi.sessions.create, {
      prompt: opts.task,
      provider: opts.provider.name,
      runtime: "headless",
    }),
  );

  await convex.mutation(anyApi.sessions.setStatus, {
    sessionId: sessionId as never,
    status: "running",
  });

  const events = createConvexEvents({ client: convex, sessionId });
  const provider = makeProvider(opts.provider);
  const screen = createHeadlessScreenAdapter();

  let outcome: ServeHeadlessResult["outcome"];
  let errorMessage: string | undefined;

  try {
    outcome = await runTask({
      task: opts.task,
      provider,
      events,
      screen,
      browser: opts.browser ?? null,
      shouldCancel: opts.shouldCancel,
    });
  } catch (e) {
    outcome = "error";
    errorMessage =
      e instanceof HeadlessVisionActionError
        ? e.message
        : e instanceof Error
          ? e.message
          : String(e);
    await events.onError(errorMessage);
  }

  await convex.mutation(anyApi.sessions.setStatus, {
    sessionId: sessionId as never,
    status:
      outcome === "done"
        ? "done"
        : outcome === "cancelled"
          ? "cancelled"
          : "error",
    error: errorMessage,
  });

  return { sessionId, outcome, error: errorMessage };
}

export { HeadlessVisionActionError } from "./agent/screen/headless";
export { createHeadlessScreenAdapter } from "./agent/screen/headless";
