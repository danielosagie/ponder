/**
 * Reusable deterministic-scoring helpers for the bench suite.
 *
 * The bench philosophy (SUITE.md): state inspection > OCR. These helpers
 * wrap the macOS surfaces we use most: osascript for app state, defaults
 * for system config, file hashing for "did the artifact land", clipboard
 * reading for handoff tasks.
 *
 * Each helper is intentionally small — the case-specific scoring logic
 * lives in the case .md's bash block. These exist so the bash block (or
 * a TS sidecar scorer) can stay readable.
 *
 * All functions are sync (execFileSync). They print to stderr on error
 * but do NOT throw, returning null/false so the case scorer can decide
 * how to weight a missing signal vs a hard fail.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

/**
 * Run an AppleScript snippet via `osascript -e` and return its stdout
 * trimmed. Returns null on error.
 *
 * Use for any "tell application X to get Y" or "tell process X to ..."
 * state query.
 */
export function appleScriptValue(script: string): string | null {
  try {
    const out = execFileSync("osascript", ["-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 5000,
    });
    return out.trim();
  } catch (e) {
    process.stderr.write(
      `[check.appleScriptValue] failed: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return null;
  }
}

/**
 * Return the current macOS clipboard contents as a string (or null).
 * Useful for handoff tasks where the agent copies something and we
 * want to verify it before paste.
 */
export function clipboardContents(): string | null {
  return appleScriptValue("the clipboard");
}

/**
 * Poll until `appName` is the frontmost process, or until `timeoutMs`
 * elapses. Returns true if it became frontmost, false on timeout.
 *
 * Critical for `setup` steps: `tell application X to activate` returns
 * 0 immediately but the app may take 100-1500ms to actually become
 * frontmost. Without this poll the agent's first screenshot can
 * capture the wrong app (this bit us in the t4 pilot — Safari never
 * came forward and we had to pivot to Chrome mid-run).
 */
export function waitFrontmost(appName: string, timeoutMs = 3000): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const front = appleScriptValue(
      `tell application "System Events" to get name of first application process whose frontmost is true`,
    );
    if (front && front.toLowerCase() === appName.toLowerCase()) return true;
    // 100ms granularity — fine for what's effectively a UI animation wait
    execFileSync("sleep", ["0.1"]);
  }
  return false;
}

/**
 * Run `defaults read <domain> <key>` and return the value, or null
 * if the key doesn't exist / the command fails.
 *
 * Use for verifying persistent system config changes (sound volume,
 * dock auto-hide, hot corners, etc.).
 */
export function defaultsRead(domain: string, key: string): string | null {
  try {
    const out = execFileSync("defaults", ["read", domain, key], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 3000,
    });
    return out.trim();
  } catch {
    return null;
  }
}

/**
 * SHA-256 of a file's contents. Returns null if the file doesn't
 * exist or is unreadable.
 *
 * Use for "did the agent modify a file" / "did the artifact land
 * verbatim" checks.
 */
export function fileChecksum(path: string): string | null {
  try {
    const buf = readFileSync(path);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Return true if `path` exists AND its mtime is at or after `sinceIso`.
 * Use for "was a file created during the run window".
 */
export function fileNewerThan(path: string, sinceIso: string): boolean {
  try {
    const st = statSync(path);
    return st.mtimeMs >= new Date(sinceIso).getTime();
  } catch {
    return false;
  }
}

/**
 * Empty the macOS clipboard. Use in setup to ensure a handoff task's
 * clipboard check fails if the agent never copies anything (otherwise
 * a stale clipboard from a previous run leaks a false-positive).
 */
export function clearClipboard(): void {
  appleScriptValue('set the clipboard to ""');
}

/**
 * Activate `appName` and wait up to `timeoutMs` for it to become
 * frontmost. Returns true on success.
 *
 * Use in setup for "open this app and wait until it's actually ready".
 * Pairs with waitFrontmost — this is the convenience wrapper most
 * cases will use.
 */
export function openApp(appName: string, timeoutMs = 3000): boolean {
  appleScriptValue(`tell application "${appName}" to activate`);
  return waitFrontmost(appName, timeoutMs);
}
