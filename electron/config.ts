import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface DesktopConfig {
  convexUrl?: string;
}

function configPath(): string {
  return join(app.getPath("userData"), "config.json");
}

function readConfig(): DesktopConfig {
  try {
    const path = configPath();
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch (e) {
    console.warn(
      `[config] failed to read ${configPath()}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return {};
  }
}

function writeConfig(cfg: DesktopConfig): void {
  const path = configPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2), "utf-8");
}

/**
 * Resolve the Convex deployment URL with precedence:
 *   1. VITE_CONVEX_URL / CONVEX_URL env (developer mode)
 *   2. ~/Library/Application Support/Ponder/config.json (customer mode,
 *      written by the ponder:// deep-link handler)
 * Returns null when neither is set — the AppWindow then renders a
 * "paste your provider's setup link" empty state.
 */
export function loadConvexUrl(): string | null {
  return (
    process.env.VITE_CONVEX_URL ??
    process.env.CONVEX_URL ??
    readConfig().convexUrl ??
    null
  );
}

/**
 * Parse a `ponder://configure?convex=<url>` deep-link, persist the parsed
 * Convex URL to config.json, and return it. Returns null when the URL is
 * malformed or doesn't carry a `convex` query param.
 */
export function applyDeepLink(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "ponder:") return null;
  if (parsed.host !== "configure" && parsed.pathname !== "/configure" &&
      parsed.pathname !== "configure") return null;
  const convexUrl = parsed.searchParams.get("convex");
  if (!convexUrl) return null;

  const cfg = readConfig();
  cfg.convexUrl = convexUrl;
  writeConfig(cfg);
  console.log(`[config] applied ponder:// deep-link, convexUrl=${convexUrl}`);
  return convexUrl;
}
