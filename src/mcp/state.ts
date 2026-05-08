/**
 * Shared state file for the MCP setup CLI.
 *
 * `pnpm mcp:setup` writes the current tunnel URL + local port + brand
 * here whenever it (re-)registers a tunnel. `pnpm mcp:status` reads
 * it to answer "is the MCP up, and what URL?". Other tooling can read
 * it too — e.g. a slash command in Claude Code that pastes the URL,
 * or a future re-attach flow that reuses an existing URL instead of
 * spawning a new tunnel.
 *
 * Path: `${TMPDIR}/holo3-mcp-state.json` (works across macOS/Linux,
 * survives across processes within the same boot, gets cleaned up by
 * the OS reboot — which is desirable since URLs are session-scoped).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface McpState {
  /** Local HTTP port the server is bound to. */
  port: number;
  /** Public tunnel hostname (https://...) — null until the tunnel
   *  registers. Updated on every tunnel restart that gets a new URL. */
  tunnelUrl: string | null;
  /** Full /mcp URL the user pastes into claude.ai. Derived but stored
   *  so consumers don't have to re-derive. */
  pasteUrl: string | null;
  /** Brand / connector name suggestion (matches MCP_BRAND env var). */
  brand: string;
  /** Tunnel binary in use ("cloudflared" / "ngrok" / null=stdio-only). */
  tunnelKind: "cloudflared" | "ngrok" | null;
  /** Whether bearer auth is on. */
  authOn: boolean;
  /** PID of the setup process, so status can tell if it's still alive. */
  setupPid: number;
  /** Wall-clock timestamp of last write (ms). */
  updatedAt: number;
}

const STATE_PATH = path.join(os.tmpdir(), "holo3-mcp-state.json");

export function getStatePath(): string {
  return STATE_PATH;
}

export function readState(): McpState | null {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf-8");
    return JSON.parse(raw) as McpState;
  } catch {
    return null;
  }
}

export function writeState(state: McpState): void {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

export function clearState(): void {
  try {
    fs.unlinkSync(STATE_PATH);
  } catch {
    // best-effort
  }
}

/** True if a process with the given pid is still running. Lets status
 *  detect stale state files left behind by a setup that was killed
 *  without a chance to clean up (kill -9, crash, etc.). */
export function pidAlive(pid: number): boolean {
  try {
    // Sending signal 0 doesn't actually deliver — it just checks
    // permissions on the target. Throws ESRCH if no such pid.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
