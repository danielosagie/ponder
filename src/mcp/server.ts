#!/usr/bin/env node
/**
 * Holo3 Browser — MCP server (stdio transport).
 *
 * For Claude Desktop (the native macOS / Windows app). Spawns as a
 * child process; communicates via stdin/stdout. Same tool surface as
 * the HTTP transport (see ./server-http.ts) — both register from
 * ./tools.ts so changes flow to both.
 *
 * Usage from Claude Desktop config (~/Library/Application Support/
 * Claude/claude_desktop_config.json on macOS):
 *   {
 *     "mcpServers": {
 *       "holo3-browser": {
 *         "command": "npx",
 *         "args": ["tsx", "/abs/path/to/holo3-agent/src/mcp/server.ts"]
 *       }
 *     }
 *   }
 *
 * Or test standalone:
 *   pnpm mcp
 *
 * For claude.ai web (the browser app), use the HTTP transport instead:
 *   pnpm mcp:http
 * Then expose via cloudflared/ngrok tunnel and paste the public URL
 * into claude.ai's "Add custom connector" dialog.
 *
 * Multi-monitor caveat: when launched as a plain Node child process,
 * Electron's `screen` API is unavailable, so `screen_screenshot` only
 * sees the PRIMARY display. Run the agent's own Electron app for
 * multi-monitor capture.
 */

// MUST be the first import: redirects console.* to stderr BEFORE any
// other module evaluates and (potentially) logs at import time. ES
// modules evaluate dependencies in DFS order, so bootstrap.ts's
// top-level runs before screen.ts / playwriter.ts whose own
// import-time logs would otherwise write to stdout and corrupt the MCP
// JSON-RPC protocol stream.
import "./bootstrap.js";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools, TOOL_NAMES, MCP_BRAND } from "./tools.js";
import { BUILD_INFO, buildInfoLabel } from "./build-info.js";

const stderrLog = (...args: unknown[]): void => {
  process.stderr.write(args.map(String).join(" ") + "\n");
};

const server = new McpServer({
  // Lowercase + dash form for the server identity that some clients
  // log; the human-friendly brand string lives on every tool's title.
  name: MCP_BRAND.toLowerCase().replace(/\s+/g, "-"),
  // Stamp with the loaded commit so a session can detect when it's
  // talking to a stale child process (a prior session's PID that
  // predates the current `git HEAD`). See ./build-info.ts.
  version: BUILD_INFO.commitShort,
});
registerTools(server);

// Wrapped in async IIFE so the file parses as CJS under tsx without
// the `--import tsx` ESM flag — keeps `pnpm mcp` and Claude Desktop's
// `npx tsx ...` config working without extra setup.
void (async () => {
  const transport = new StdioServerTransport();
  try {
    await server.connect(transport);
    stderrLog(
      `[mcp:stdio] holo3-browser ready. ${buildInfoLabel()}. ` +
        `Tools: ${TOOL_NAMES.join(", ")}.`,
    );
  } catch (e) {
    stderrLog(
      `[mcp:stdio] failed to connect transport: ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(1);
  }
})();
