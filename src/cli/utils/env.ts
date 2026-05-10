import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MANAGED_BEGIN = "# === managed by ponder (do not edit between markers) ===";
export const MANAGED_END = "# === end managed by ponder ===";

export interface EnvBlock {
  /** Vars the CLI owns. Will be written between the managed markers. */
  managed: Record<string, string>;
}

/**
 * Read a dotenv file into a flat Record<string, string>. Returns {} if the
 * file is missing. Strips surrounding quotes; ignores blank lines and #
 * comments. Not a full dotenv parser — just enough for our managed block.
 */
export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  const lines = readFileSync(path, "utf-8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Rewrite ONLY the managed block of `path`, leaving every line outside the
 * markers untouched. Creates the file if it doesn't exist. The managed block
 * always lives at the top of the file; user-added vars go below it.
 */
export function writeManagedEnv(path: string, vars: Record<string, string>): void {
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const lines = existing.split(/\r?\n/);

  const beginIdx = lines.indexOf(MANAGED_BEGIN);
  const endIdx = lines.indexOf(MANAGED_END);

  const managedBody = renderManagedBody(vars);

  let next: string[];
  if (beginIdx >= 0 && endIdx > beginIdx) {
    next = [
      ...lines.slice(0, beginIdx),
      MANAGED_BEGIN,
      ...managedBody,
      MANAGED_END,
      ...lines.slice(endIdx + 1),
    ];
  } else {
    next = [
      MANAGED_BEGIN,
      ...managedBody,
      MANAGED_END,
      "",
      ...(existing ? lines : []),
    ];
  }

  writeFileSync(path, next.join("\n"));
}

function renderManagedBody(vars: Record<string, string>): string[] {
  return Object.entries(vars).map(([k, v]) => `${k}=${quoteIfNeeded(v)}`);
}

function quoteIfNeeded(value: string): string {
  if (value === "") return "";
  if (/[\s#]/.test(value)) return `"${value.replace(/"/g, '\\"')}"`;
  return value;
}

/**
 * Read the project's existing managed-block values so an installer can show
 * "current" defaults and we don't lose vars unrelated to the active provider.
 */
export function readManagedEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const content = readFileSync(path, "utf-8");
  const lines = content.split(/\r?\n/);
  const beginIdx = lines.indexOf(MANAGED_BEGIN);
  const endIdx = lines.indexOf(MANAGED_END);
  if (beginIdx < 0 || endIdx < 0 || endIdx <= beginIdx) return {};
  const slice = lines.slice(beginIdx + 1, endIdx).join("\n");
  return readEnvBuffer(slice);
}

function readEnvBuffer(buf: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of buf.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Append ONE line to .gitignore if it isn't already covered. Idempotent.
 */
export function ensureGitignore(cwd: string, entries: string[]): void {
  const path = join(cwd, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const lines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const additions = entries.filter((e) => !lines.has(e.trim()));
  if (additions.length === 0) return;
  const next =
    (existing.endsWith("\n") || existing === "" ? existing : existing + "\n") +
    additions.join("\n") +
    "\n";
  writeFileSync(path, next);
}
