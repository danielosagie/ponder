#!/usr/bin/env bash
# Kill any stale `tsx src/mcp/server*.ts` PIDs from prior Claude Code /
# Claude Desktop sessions. Run between sessions when `holo3_version`
# reports a `commit` that doesn't match `git rev-parse HEAD` on disk —
# the live MCP server child process predates your most recent deploy.
#
# Safe to run multiple times. `pgrep -f` matches the full command line
# (so we hit BOTH stdio `src/mcp/server.ts` and HTTP `src/mcp/server-http.ts`).
# `xargs -r` is a no-op when pgrep finds nothing — never errors on a
# clean machine.
#
# Usage:
#   bash scripts/kill-stale-mcp.sh
#
# After it returns, restart Claude Code (the IDE re-spawns its MCP
# child) and re-call `holo3_version` to verify the new SHA.

set -euo pipefail

PIDS=$(pgrep -f 'tsx.*src/mcp/server' || true)
if [[ -z "$PIDS" ]]; then
  echo "[kill-stale-mcp] no tsx src/mcp/server* PIDs found — nothing to kill."
  exit 0
fi

echo "[kill-stale-mcp] killing PIDs: $PIDS"
echo "$PIDS" | xargs -r kill -TERM
sleep 0.5

# Verify nothing survived TERM. Anything still alive after 500ms gets KILL.
SURVIVORS=$(pgrep -f 'tsx.*src/mcp/server' || true)
if [[ -n "$SURVIVORS" ]]; then
  echo "[kill-stale-mcp] survivors after TERM, sending KILL: $SURVIVORS"
  echo "$SURVIVORS" | xargs -r kill -KILL
fi

echo "[kill-stale-mcp] done. Restart Claude Code to spawn a fresh MCP server."
