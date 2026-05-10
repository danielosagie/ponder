/**
 * `ponder/agent` — embedded API for advanced consumers who want to run the
 * agent loop in their own process instead of dispatching to a customer's
 * Ponder desktop app via Convex. Most consumers should import from `ponder`
 * (the dispatch client) instead.
 */
export { runTask } from "./loop";
export type { RunOptions } from "./loop";

export type {
  AgentEvents,
  GroundResult,
  PlanResult,
  ProviderClient,
  ProviderName,
} from "./types";

export type { ClickOpts, Screenshot, ScreenAdapter } from "./screen/types";
export { createNutScreenAdapter } from "./screen/nut";
export { createNoopScreenAdapter } from "./screen/noop";

export {
  createRemoteProvider,
  type RemoteConfig,
} from "./providers/remote";
export {
  createLocalProvider,
  type LocalConfig,
} from "./providers/local";
export {
  createHCompanyProvider,
  type HCompanyConfig,
} from "./providers/hcompany";

export { createOllamaPlanner } from "./planner";
export { createOllamaNarrator } from "./narrator";
export { createExtractor } from "./extractor";

export { createPlaywriterClient } from "./browser/playwriter";
export type { BrowserClient, BrowserSnapshot } from "./browser/types";

import type { ProviderClient, ProviderName } from "./types";
import { createRemoteProvider, type RemoteConfig } from "./providers/remote";
import { createLocalProvider, type LocalConfig } from "./providers/local";
import {
  createHCompanyProvider,
  type HCompanyConfig,
} from "./providers/hcompany";

export type ProviderConfig =
  | ({ name: "remote" } & RemoteConfig)
  | ({ name: "local" } & LocalConfig)
  | ({ name: "hcompany" } & HCompanyConfig);

/**
 * Single-entry factory that dispatches to the right provider implementation.
 * Equivalent to picking `createRemoteProvider` / `createLocalProvider` /
 * `createHCompanyProvider` directly — use whichever reads better at the call
 * site.
 */
export function makeProvider(cfg: ProviderConfig): ProviderClient {
  switch (cfg.name) {
    case "remote": {
      const { name: _n, ...rest } = cfg;
      return createRemoteProvider(rest);
    }
    case "local": {
      const { name: _n, ...rest } = cfg;
      return createLocalProvider(rest);
    }
    case "hcompany": {
      const { name: _n, ...rest } = cfg;
      return createHCompanyProvider(rest);
    }
    default: {
      const exhaustive: never = cfg;
      throw new Error(
        `Unknown provider config: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

export type { ProviderName as ProviderId };
