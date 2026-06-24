#!/usr/bin/env bash
# Restart the stale Ponder MCP server — SCOPED to this repo only.
#
# ── YOU PROBABLY DON'T NEED THIS ──────────────────────────────────────
# The agent loop (src/agent/**) does NOT run in the MCP server. It runs
# in the Electron app: `agent_do` is FORWARDED from the MCP over the
# localhost bridge (:7900) into Electron, where macOS perms + the
# provider live (electron/main.ts imports runTask directly).
#
# So the restart matrix is:
#   • Changed src/agent/** or a prompt?  → just restart `pnpm dev`
#     (Electron rebuilds the main process and loads fresh agent code).
#     DO NOT touch the MCP. Claude Code keeps running undisturbed.
#   • Changed src/mcp/** (tool defs / the forwarder itself)?  → THEN
#     run this script + restart Claude Code so it respawns its MCP child.
#
# This version is SCOPED to PIDs whose working directory is THIS repo,
# so it never kills another project's MCP server (or another Claude Code
# session pointed at a different checkout).
#
# Usage:
#   bash scripts/kill-stale-mcp.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Candidate PIDs: any `tsx src/mcp/server*` process (stdio + HTTP).
ALL=$(pgrep -f 'tsx.*src/mcp/server' || true)
if [[ -z "$ALL" ]]; then
  echo "[kill-stale-mcp] no tsx src/mcp/server* PIDs found — nothing to kill."
  exit 0
fi

# Keep only those whose cwd is THIS repo (macOS: lsof -d cwd), so other
# projects' / sessions' MCP servers are never touched.
PIDS=""
for pid in $ALL; do
  cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1 || true)
  if [[ "$cwd" == "$REPO_ROOT"* ]]; then
    PIDS="$PIDS $pid"
  fi
done
PIDS=$(echo "$PIDS" | xargs || true)

if [[ -z "$PIDS" ]]; then
  echo "[kill-stale-mcp] found MCP servers, but none rooted in $REPO_ROOT — leaving them alone."
  echo "[kill-stale-mcp] (other Claude Code sessions / projects are untouched.)"
  exit 0
fi

echo "[kill-stale-mcp] killing this repo's MCP PIDs: $PIDS"
echo "$PIDS" | xargs -r kill -TERM
sleep 0.5

# Anything still alive after TERM gets KILL (scoped to the same PID set).
SURVIVORS=""
for pid in $PIDS; do
  if kill -0 "$pid" 2>/dev/null; then SURVIVORS="$SURVIVORS $pid"; fi
done
SURVIVORS=$(echo "$SURVIVORS" | xargs || true)
if [[ -n "$SURVIVORS" ]]; then
  echo "[kill-stale-mcp] survivors after TERM, sending KILL: $SURVIVORS"
  echo "$SURVIVORS" | xargs -r kill -KILL
fi

echo "[kill-stale-mcp] done. Restart Claude Code to spawn a fresh MCP server."
