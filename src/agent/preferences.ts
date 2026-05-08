/**
 * User-runtime preferences shared across the Electron app and the MCP
 * server (which runs in a SEPARATE Node process spawned by Claude Code
 * / Claude Desktop / etc.).
 *
 * The Electron tray menu lets the user pick a provider (H Company /
 * Modal / Local). Without persistence, that pick is in-memory only and
 * the MCP server has no way to learn about it — every MCP-initiated
 * `agent_do` call would re-derive the provider from env vars,
 * defaulting to whatever HAI_API_KEY/MODAL/Ollama priority dictates.
 *
 * This module persists user choices to ~/.holo3-agent/preferences.json
 * with last-writer-wins semantics. Both Electron's switchProvider() and
 * MCP's computeDefaultProvider() read the file. No env vars to set;
 * the user-visible action (clicking a tray item) IS the configuration.
 *
 * No top-level side effects. Safe to import from any process. Failures
 * are silent — preferences are best-effort, not load-bearing.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ProviderName } from "./types";

const PREF_DIR = path.join(os.homedir(), ".holo3-agent");
const PREF_FILE = path.join(PREF_DIR, "preferences.json");

interface Preferences {
  provider?: ProviderName;
  /** Reserved for future settings (max steps, narrator on/off, etc.). */
  [key: string]: unknown;
}

function readAll(): Preferences {
  try {
    const raw = fs.readFileSync(PREF_FILE, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as Preferences;
  } catch {
    // File missing, malformed JSON, permission denied — all fine, just
    // return empty preferences and let the env-var fallback handle it.
  }
  return {};
}

function writeAll(prefs: Preferences): void {
  try {
    fs.mkdirSync(PREF_DIR, { recursive: true });
    fs.writeFileSync(PREF_FILE, JSON.stringify(prefs, null, 2));
  } catch {
    // Permission denied / disk full / etc. — silently swallow. The
    // user's choice still lives in-memory for the current Electron
    // session; we just won't propagate it to the MCP. Acceptable
    // degradation.
  }
}

/** Read the user's preferred provider (set via the Electron tray menu).
 *  Returns null when no preference is set — callers should fall back to
 *  env-var priority. Validates the stored value is a known
 *  ProviderName so a corrupted file can't crash the factory. */
export function getProviderPreference(): ProviderName | null {
  const prefs = readAll();
  const v = prefs.provider;
  if (v === "hcompany" || v === "remote" || v === "local") return v;
  return null;
}

/** Persist the user's provider choice. Called from the Electron tray
 *  menu's switchProvider() so an MCP started later (or already
 *  running) sees the new choice on the next tool call. */
export function setProviderPreference(name: ProviderName): void {
  const prefs = readAll();
  prefs.provider = name;
  writeAll(prefs);
}

/** Clear the persisted provider preference, falling back to env-var
 *  priority on the next read. Currently unused but kept for parity
 *  with set/get. */
export function clearProviderPreference(): void {
  const prefs = readAll();
  delete prefs.provider;
  writeAll(prefs);
}

/** Path to the preferences file — exposed for the doctor CLI / status
 *  commands so users can `cat` it when debugging. */
export const PREFERENCES_FILE_PATH = PREF_FILE;
