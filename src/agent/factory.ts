/**
 * Provider + router factory — single source of truth.
 *
 * Both Electron's main process and the MCP server need to construct a
 * `ProviderClient` (Holo3 vision-language model) and an optional
 * `RouterClient` (Qwen3 fast-path) based on the same env-var rules. Before
 * this module the logic was inlined in `electron/main.ts`; the MCP server
 * had no way to share it. Pulling it out here means a fix in one place
 * reaches both transports automatically.
 *
 * No top-level side effects — no console.log, no env mutations, no eager
 * network calls. Safe to import from anywhere (Electron, MCP stdio, MCP
 * HTTP) without worrying about the bootstrap-stderr-redirect ordering in
 * `src/mcp/bootstrap.ts`.
 */

import { getProviderPreference } from "./preferences";
import { createHCompanyProvider } from "./providers/hcompany";
import { createLocalProvider } from "./providers/local";
import { createRemoteProvider } from "./providers/remote";
import { createOllamaRouter, type RouterClient } from "./router";
import type { ProviderClient, ProviderName } from "./types";

/**
 * Pick the default provider.
 *
 * Priority (highest first):
 *   1. **User preference** persisted at ~/.holo3-agent/preferences.json.
 *      Set when the user picks a provider from the Electron tray menu.
 *      Wins over env vars because it's the most explicit signal — the
 *      user clicked a thing — and works across processes (Electron's
 *      pick is visible to the MCP server spawned by Claude Code).
 *   2. `hcompany`   — hosted H Company API (full-quality, no infra). Wins
 *      when HAI_API_KEY or HCOMPANY_API_KEY is set.
 *   3. `remote`     — self-hosted Modal endpoint. Wins when both
 *      MODAL_BASE_URL and MODAL_BEARER_TOKEN are set.
 *   4. `local`      — local Ollama (default). Always available even if
 *      Ollama isn't running (the user gets a clearer error from the loop).
 *
 * Set the preference by clicking a provider in the tray menu, OR clear
 * `~/.holo3-agent/preferences.json` to fall back to env-var priority.
 */
export function computeDefaultProvider(): ProviderName {
  const pref = getProviderPreference();
  if (pref && isProviderConfigured(pref)) return pref;
  if (process.env.HAI_API_KEY ?? process.env.HCOMPANY_API_KEY) return "hcompany";
  if (process.env.MODAL_BASE_URL && process.env.MODAL_BEARER_TOKEN) return "remote";
  return "local";
}

/**
 * Construct a `ProviderClient` for the given provider name.
 *
 * For `remote` we always return SOMETHING — even if creds are missing — so
 * callers don't have to `try/catch` around construction. The returned
 * client will fail at call-time with a clear error, which is also the
 * behavior the Electron path has shipped with from day 1.
 *
 * For configuration validation use `isProviderConfigured()` BEFORE warming
 * the client; that's the cheap fast-fail path.
 */
export function makeProvider(name: ProviderName): ProviderClient {
  if (name === "local") return createLocalProvider();

  if (name === "hcompany") {
    const apiKey =
      process.env.HAI_API_KEY ?? process.env.HCOMPANY_API_KEY ?? "";
    return createHCompanyProvider({
      apiKey,
      model: process.env.HCOMPANY_MODEL ?? "holo3-35b-a3b",
    });
  }

  const baseUrl = process.env.MODAL_BASE_URL;
  const token = process.env.MODAL_BEARER_TOKEN;
  if (!baseUrl || !token) {
    return createRemoteProvider({
      baseUrl: "http://invalid",
      token: "missing",
    });
  }
  return createRemoteProvider({ baseUrl, token });
}

/**
 * Whether the env vars needed for the given provider are present.
 *
 * Used by callers to fast-fail with a clear configuration error before
 * paying the warm-up cost. `local` always returns true (we can't know if
 * Ollama is actually running without a network probe; the loop's first
 * call will surface the connection error if it isn't).
 */
export function isProviderConfigured(name: ProviderName): boolean {
  if (name === "local") return true;
  if (name === "hcompany") {
    return !!(process.env.HAI_API_KEY ?? process.env.HCOMPANY_API_KEY);
  }
  return !!(process.env.MODAL_BASE_URL && process.env.MODAL_BEARER_TOKEN);
}

/**
 * Construct the optional CLI fast-path router (Qwen3 via Ollama). Returns
 * `null` when the user has explicitly disabled it via `HOLO3_ROUTER=off`.
 *
 * Construction is cheap (no network) — `available()` is what probes
 * Ollama, and the loop tolerates an unavailable router by falling through
 * to the vision path with no behavior change.
 */
export function makeRouter(): RouterClient | null {
  if (process.env.HOLO3_ROUTER === "off") return null;
  return createOllamaRouter();
}

/**
 * Human-readable label for a provider name. Used in tray notifications
 * and the menu so users see "H Company API" instead of "hcompany".
 *
 * (Distinct from the warm-up status string in electron/main.ts:493-498,
 * which uses shorter labels like "Modal" / "local model" inline. Keep
 * those local; this label is for the Notification / settings surface.)
 */
export function humanProviderLabel(name: ProviderName): string {
  if (name === "hcompany") return "H Company API";
  if (name === "remote") return "Modal · Holo3";
  return "Local (Ollama)";
}
