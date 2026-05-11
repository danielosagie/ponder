/**
 * Null provider — used when no platform-specific provider is available
 * (unsupported platform, permission denied, helper binary missing).
 * Every method either returns a "not available" status or rejects with
 * a clear message so MCP tools can surface actionable errors.
 */

import type { OsClient, OsClientStatus, OsSnapshot } from "../types.js";

export function createNullOsClient(reason: string): OsClient {
  const status: OsClientStatus = {
    available: false,
    platform: "null",
    reason,
  };

  function reject<T>(): Promise<T> {
    return Promise.reject(new Error(`OS provider unavailable: ${reason}`));
  }

  return {
    available: () => Promise.resolve(false),
    status: () => Promise.resolve(status),
    snapshot: () => reject<OsSnapshot>(),
    click: () => reject(),
    type: () => reject(),
    hover: () => reject(),
    drag: () => reject(),
    close: () => Promise.resolve(),
  };
}
