/**
 * Entry point for the Ponder browser-jobs consumer.
 *
 * Assembles config (env + optional bootstrap) → PonderExecutor → consumer,
 * and starts the Convex subscription. Used by `ponder consume` and can be
 * called from the Electron main process to run the consumer in-app.
 */

import {
  readBrowserJobsConfig,
  bootstrapConfig,
  isConfigured,
  type BrowserJobsConfig,
} from "./config.js";
import { PonderExecutor } from "./ponder-executor.js";
import { BrowserJobsConsumer, type ConsumerEvents } from "./consumer.js";

export { BrowserJobsConsumer } from "./consumer.js";
export {
  PonderExecutor,
  goalForJob,
  isWriteJob,
  detectFrictionPhrase,
  FRICTION_PHRASES,
  BRIDGE_NOT_REACHABLE_MARKER,
} from "./ponder-executor.js";
export type { BrowserJob } from "./ponder-executor.js";
export {
  readBrowserJobsConfig,
  bootstrapConfig,
  isConfigured,
  type BrowserJobsConfig,
} from "./config.js";

export interface StartOptions {
  config?: BrowserJobsConfig;
  events?: ConsumerEvents;
}

/**
 * Resolve config (filling convexURL/userId from the backend bootstrap when
 * only a sync base URL + token are set), build the consumer, and start it.
 * Returns the running consumer (call `.stop()` to tear down) or throws with a
 * clear message if it cannot be configured.
 */
export async function startBrowserJobsConsumer(
  opts: StartOptions = {},
): Promise<BrowserJobsConsumer> {
  let config = opts.config ?? readBrowserJobsConfig();
  if (!isConfigured(config)) {
    config = await bootstrapConfig(config);
  }
  if (!isConfigured(config)) {
    throw new Error(
      "browser-jobs consumer not configured. Set PONDER_BROWSER_JOBS_CONVEX_URL + " +
        "PONDER_BROWSER_JOBS_USER_ID, or PONDER_BROWSER_JOBS_SYNC_BASE_URL + " +
        "PONDER_BROWSER_JOBS_SYNC_TOKEN so it can bootstrap from the backend.",
    );
  }

  const executor = new PonderExecutor({ bridgePort: config.bridgePort });
  const consumer = new BrowserJobsConsumer(config, executor, opts.events);
  consumer.start();
  return consumer;
}
