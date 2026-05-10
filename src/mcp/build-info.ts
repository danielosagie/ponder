/**
 * Build / boot-time identity stamp for the MCP server process.
 *
 * Solves the "stale MCP server PID" problem: when a developer ships a
 * commit that changes the tool surface (e.g. adds `provider.groundBatch`
 * on the loaded provider object), any Claude Code session that was
 * connected to the OLD `tsx src/mcp/server.ts` PID continues to see the
 * old tool surface. Without a commit stamp, the running session has no
 * way to detect the staleness from inside — every benchmark looks
 * mysteriously "fallback-y" until someone restarts Claude Code by hand.
 *
 * Resolution policy (first match wins):
 *   1. `HOLO3_MCP_COMMIT` env var (so a future `pnpm build` can bake
 *      the SHA in at install time without touching git at runtime).
 *   2. `git rev-parse HEAD` + `git status --porcelain` invoked once at
 *      module load. ~30 ms for a long-lived process — irrelevant cost.
 *   3. `"unknown"` fallback when neither is available (non-git installs,
 *      `git` binary missing, etc.) — never crashes the boot.
 *
 * Surfaced via:
 *   - stdio stderr banner   (server.ts boot line)
 *   - HTTP /health JSON     (server-http.ts)
 *   - `holo3_version` MCP tool (tools.ts) — the channel a Claude session
 *     can call before running a benchmark to verify it's talking to a
 *     fresh server.
 */

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface BuildInfo {
  /** Full SHA-1 (40 hex chars) or `"unknown"`. */
  commit: string;
  /** First 12 hex chars — what humans paste into commit messages. */
  commitShort: string;
  /** True when the working tree had uncommitted changes at boot. */
  dirty: boolean;
  /** ISO-8601 timestamp the module was first evaluated. */
  builtAt: string;
}

function resolveBuildInfo(): BuildInfo {
  const builtAt = new Date().toISOString();

  // 1. Env override — preferred when set so build pipelines can stamp
  //    the commit without invoking git at runtime.
  const envCommit = process.env.HOLO3_MCP_COMMIT;
  if (envCommit && envCommit.trim().length > 0) {
    const c = envCommit.trim();
    return {
      commit: c,
      commitShort: c.slice(0, 12),
      dirty: process.env.HOLO3_MCP_DIRTY === "1",
      builtAt,
    };
  }

  // 2. Try `git` against the package root. We resolve from THIS file's
  //    directory so the lookup works regardless of whatever cwd the
  //    spawning process (Claude Desktop, claude.ai tunnel, dev script)
  //    happens to use — Claude Desktop launches with cwd=/, for instance.
  try {
    // ESM-safe __dirname equivalent; tsx evaluates this file as ESM.
    const here = dirname(fileURLToPath(import.meta.url));
    const cwd = resolve(here);
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    let dirty = false;
    try {
      const status = execFileSync("git", ["status", "--porcelain"], {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      dirty = status.trim().length > 0;
    } catch {
      // status failure is harmless — just leaves `dirty = false`.
    }
    return {
      commit,
      commitShort: commit.slice(0, 12),
      dirty,
      builtAt,
    };
  } catch {
    // 3. Non-git install or git binary missing — fall through.
  }

  return {
    commit: "unknown",
    commitShort: "unknown",
    dirty: false,
    builtAt,
  };
}

/** Module-scope singleton — resolved exactly once at first import. */
export const BUILD_INFO: BuildInfo = resolveBuildInfo();

/** Human-friendly suffix for log lines: `commit=27eee93d1b93 (dirty)`. */
export function buildInfoLabel(): string {
  const dirty = BUILD_INFO.dirty ? " (dirty)" : "";
  return `commit=${BUILD_INFO.commitShort}${dirty} builtAt=${BUILD_INFO.builtAt}`;
}
