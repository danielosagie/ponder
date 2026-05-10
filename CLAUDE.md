<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->

## Post-deploy MCP refresh

This repo runs an MCP server (`tsx src/mcp/server.ts` for stdio, or
`tsx src/mcp/server-http.ts` for HTTP) that Claude Code / Claude Desktop
connect to. The server is a long-lived child process — it does NOT
hot-reload when you commit or run `npm run modal:deploy`. A session
that was started before your most recent commit will keep using the
OLD code until the child process is killed and respawned.

This bites hardest when adding optional methods on a provider object
(e.g. `provider.groundBatch`): the new code path silently no-ops and
the caller takes the slow fallback path with no obvious error.

**Workflow after any commit that touches `src/mcp/**` or `src/agent/**`:**

1. Ask Claude to call `holo3_version` (it's an MCP tool — no shell needed).
2. Compare the returned `commit` against `git rev-parse --short=12 HEAD`.
3. If they differ:
   - Run `bash scripts/kill-stale-mcp.sh` (kills any stale `tsx src/mcp/server*` PIDs).
   - Restart Claude Code so it respawns a fresh MCP child.
   - Re-call `holo3_version` to confirm the SHA now matches.

The HTTP transport also exposes the same fields at `GET /health` (e.g.
`curl http://127.0.0.1:7831/health | jq .commit`).

