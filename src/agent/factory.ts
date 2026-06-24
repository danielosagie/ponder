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
import {
  createCompositeProvider,
  plannerConfigFromEnv,
} from "./providers/planner";
import { createOllamaRouter, type RouterClient } from "./router";
import type {
  ExecutorProviderName,
  ProviderClient,
  ProviderName,
} from "./types";

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
export function computeDefaultProvider(): ExecutorProviderName {
  const hasApi = !!(process.env.HAI_API_KEY ?? process.env.HCOMPANY_API_KEY);
  const pref = getProviderPreference();
  // Honor an explicit pick — EXCEPT a stale "remote" (Modal) pin when the fast
  // H-company API is configured. Modal cold-starts are slow and the self-host
  // has been flaky, so the API is the default whenever it's available (user
  // directive 2026-06-21: "use the api by default not modal"). Modal still
  // wins if it's the explicit pick AND no API key exists.
  if (pref && pref !== "remote" && isProviderConfigured(pref)) return pref;
  if (pref === "remote" && !hasApi && isProviderConfigured("remote")) return "remote";
  if (hasApi) return "hcompany";
  if (process.env.MODAL_BASE_URL && process.env.MODAL_BEARER_TOKEN) return "remote";
  return "local";
}

/** Map a runtime provider name to the concrete executor backend —
 *  Convex's sessions schema (and the preferences file) only know the
 *  three executors; "composite" persists as whatever it wraps. */
export function executorNameFor(name: ProviderName): ExecutorProviderName {
  return name === "composite" ? computeDefaultProvider() : name;
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
  return maybeWrapWithPlanner(makeExecutorProvider(name));
}

/**
 * Surfer-2 split (2026-06-10): when a hosted planner is configured
 * (GEMINI_API_KEY, or PLANNER_API_KEY + PLANNER_API_BASE), wrap the
 * executor so plan() goes to the smart cheap model and ground() stays
 * on Holo3. Everything that calls provider.plan — brain, verifier,
 * completion probe, decompose — upgrades automatically. The loop
 * detects name === "composite" and skips the local Ollama router and
 * hierarchical planner (subsumed by the smart planner).
 * PONDER_PLANNER=off disables wrapping.
 */
let plannerAnnounced = false;
function maybeWrapWithPlanner(executor: ProviderClient): ProviderClient {
  const cfg = plannerConfigFromEnv();
  if (!cfg) return executor;
  if (!plannerAnnounced) {
    plannerAnnounced = true;
    // console.error: stays off stdout (MCP JSON-RPC) — informational only.
    console.error(
      `[boot] planner configured: ${cfg.text.model} (text) / ${cfg.vision.model} (vision) plan, ${executor.name} grounds (composite mode — local router/planner bypassed)`,
    );
  }
  return createCompositeProvider(executor, cfg);
}

function makeExecutorProvider(name: ProviderName): ProviderClient {
  if (name === "local") return createLocalProvider();

  if (name === "hcompany") {
    const apiKey =
      process.env.HAI_API_KEY ?? process.env.HCOMPANY_API_KEY ?? "";
    return createHCompanyProvider({
      apiKey,
      // holo3-35b-a3b is deprecated 2026-06-15 — holo3-1-35b-a3b is the
      // drop-in successor. See createHCompanyProvider.
      model: process.env.HCOMPANY_MODEL ?? "holo3-1-35b-a3b",
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
  if (name === "composite") {
    const cfg = plannerConfigFromEnv();
    // Short label: strip the OpenRouter "vendor/" prefix for readability.
    const shortText = cfg?.text.model.split("/").pop() ?? "planner";
    return `${shortText} + Holo3`;
  }
  return "Local (Ollama)";
}
