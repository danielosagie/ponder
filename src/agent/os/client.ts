/**
 * pickOsClient — runtime factory. Picks the platform provider based on
 * process.platform with HOLO3_OS_PROVIDER as an override (useful for
 * forcing the null provider during development, or for testing
 * cross-platform tools.ts code paths from Linux).
 *
 * Memoized at module scope: every MCP tool call hits the same client,
 * which keeps the RefStore consistent across snapshot → click pairs.
 */

import type { OsClient } from "./types.js";
import { createNullOsClient } from "./providers/null.js";

let _client: OsClient | null = null;

export function pickOsClient(): OsClient {
  if (_client) return _client;
  const override = process.env.HOLO3_OS_PROVIDER?.toLowerCase();
  const platform = override ?? process.platform;
  if (platform === "darwin" || platform === "mac") {
    // Lazy import so non-mac environments don't pay the parse cost.
    // We avoid top-level await to keep CommonJS interop simple.
    _client = lazyMac();
    return _client;
  }
  if (platform === "win32" || platform === "windows") {
    _client = createNullOsClient("Windows provider not implemented yet.");
    return _client;
  }
  if (platform === "linux") {
    _client = createNullOsClient(
      "Linux AT-SPI provider not implemented yet (deferred).",
    );
    return _client;
  }
  if (platform === "null") {
    _client = createNullOsClient("Forced null provider via HOLO3_OS_PROVIDER.");
    return _client;
  }
  _client = createNullOsClient(`Unsupported platform: ${platform}.`);
  return _client;
}

function lazyMac(): OsClient {
  // Synchronous require shim — works under both ESM (tsx) and CJS.
  // We resolve via dynamic import wrapped in a thunk so the parse
  // happens at first call rather than at module-load time on Linux/win.
  const stub: OsClient = {
    available: async () => false,
    status: async () => ({
      available: false,
      platform: "mac",
      reason: "mac provider loading…",
    }),
    snapshot: () => Promise.reject(new Error("mac provider not yet loaded")),
    click: () => Promise.reject(new Error("mac provider not yet loaded")),
    type: () => Promise.reject(new Error("mac provider not yet loaded")),
    hover: () => Promise.reject(new Error("mac provider not yet loaded")),
    drag: () => Promise.reject(new Error("mac provider not yet loaded")),
    close: () => Promise.resolve(),
  };
  // Fire-and-forget the import; first real call awaits via the proxy.
  let ready: Promise<OsClient> | null = null;
  function load(): Promise<OsClient> {
    if (!ready) {
      ready = import("./providers/mac.js").then((m) => {
        const real = m.createMacOsClient();
        _client = real;
        return real;
      });
    }
    return ready;
  }
  return {
    available: async () => (await load()).available(),
    status: async () => (await load()).status(),
    snapshot: async () => (await load()).snapshot(),
    click: async (s, o) => (await load()).click(s, o),
    type: async (s, t, o) => (await load()).type(s, t, o),
    hover: async (s) => (await load()).hover(s),
    drag: async (a, b) => (await load()).drag(a, b),
    close: async () => (await load()).close(),
  };
  void stub;
}
