#!/usr/bin/env node
/**
 * Holo3 Browser — MCP server (Streamable HTTP transport).
 *
 * For claude.ai web "Add custom connector" and any other MCP client
 * that wants a remote HTTPS endpoint instead of spawning a local
 * stdio process. Same tool surface as ./server.ts (stdio); both
 * register from ./tools.ts.
 *
 * Usage:
 *
 *   1. Start the server:
 *        pnpm mcp:http
 *      Listens on http://localhost:7831 (override with MCP_PORT).
 *      All MCP requests (POST initialize, POST tools/list, POST
 *      tools/call, etc.) hit POST /mcp.
 *
 *   2. Expose to claude.ai via a tunnel:
 *        cloudflared tunnel --url http://localhost:7831
 *      (or `ngrok http 7831`). Cloudflared quick tunnels are free and
 *      need no signup. The tunnel command prints a public HTTPS URL
 *      like https://something.trycloudflare.com.
 *
 *   3. In claude.ai → Connectors → Add custom connector:
 *      • Name:               Holo3 Browser
 *      • Remote MCP server:  https://something.trycloudflare.com/mcp
 *      • OAuth fields:       leave blank (no auth) OR set MCP_TOKEN
 *                            below and configure bearer auth on the
 *                            client side.
 *
 * AUTH:
 *   Set MCP_TOKEN=<some-secret> when starting and clients must send
 *   `Authorization: Bearer <some-secret>` on every request. Off by
 *   default. Strongly recommended when exposing via a public tunnel —
 *   otherwise anyone with the URL can drive your Chrome.
 *
 * Multi-monitor caveat: when launched as a plain Node process,
 * Electron's `screen` API is unavailable, so `screen_screenshot` only
 * sees the PRIMARY display.
 */

// MUST be the first import — see ./server.ts for why.
import "./bootstrap.js";

import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools, TOOL_NAMES, MCP_BRAND } from "./tools.js";
import { BUILD_INFO, buildInfoLabel } from "./build-info.js";

const stderrLog = (...args: unknown[]): void => {
  process.stderr.write(args.map(String).join(" ") + "\n");
};

const PORT = Number(process.env.MCP_PORT ?? 7831);
const TOKEN = process.env.MCP_TOKEN; // optional — gate via Bearer header
const PATH = "/mcp";

// Read the request body up to a sane cap (16MB — protocol messages are
// small, but a base64 image being passed back in a tool result might
// inflate). Returns the parsed JSON or null for empty bodies (GET).
async function readJsonBody(req: http.IncomingMessage): Promise<unknown | null> {
  const MAX = 16 * 1024 * 1024;
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX) {
      throw new Error(`request body exceeds ${MAX} bytes`);
    }
    chunks.push(buf);
  }
  if (total === 0) return null;
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(
      `request body is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function checkAuth(req: http.IncomingMessage): true | string {
  if (!TOKEN) return true;
  const header = req.headers["authorization"];
  if (!header || typeof header !== "string") {
    return "missing Authorization header";
  }
  const expected = `Bearer ${TOKEN}`;
  if (header !== expected) return "invalid bearer token";
  return true;
}

function writeJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
    // Allow claude.ai to call us cross-origin. Tunneling services
    // sometimes don't add CORS by default, and claude.ai's connector
    // probe will fail without these.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type,Authorization,Mcp-Session-Id,Mcp-Protocol-Version",
  });
  res.end(text);
}

const httpServer = http.createServer(async (req, res) => {
  // CORS preflight — claude.ai sends OPTIONS before its first POST.
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type,Authorization,Mcp-Session-Id,Mcp-Protocol-Version",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return;
  }

  // Cheap health check — useful when verifying a tunnel is live AND for
  // a fresh Claude session to confirm it's connected to the post-deploy
  // server (the `commit` field below is what nukes the stale-PID guess-
  // work; see src/mcp/build-info.ts for why).
  if (req.method === "GET" && req.url === "/health") {
    writeJson(res, 200, {
      ok: true,
      commit: BUILD_INFO.commit,
      commitShort: BUILD_INFO.commitShort,
      dirty: BUILD_INFO.dirty,
      builtAt: BUILD_INFO.builtAt,
      tools: TOOL_NAMES,
    });
    return;
  }

  // Friendly landing page at "/" so the user can verify the tunnel
  // works in a browser tab, AND so misconfigurations (paste base URL
  // into claude.ai instead of /mcp) get an obvious "wrong URL" page
  // instead of a generic 404. Most common failure mode: user pastes
  // https://<tunnel-host> into claude.ai's connector dialog without
  // /mcp suffix, claude.ai shows "Couldn't reach the MCP server",
  // user has no idea why. With this page they at least see WHY.
  const urlPath = (req.url || "").split("?")[0];
  if (req.method === "GET" && (urlPath === "/" || urlPath === "")) {
    const fullMcpUrl = `${req.headers["x-forwarded-proto"] ?? "http"}://${req.headers.host ?? `localhost:${PORT}`}${PATH}`;
    const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${MCP_BRAND} MCP</title>
<style>
body { font: 15px/1.5 -apple-system, system-ui, sans-serif; max-width: 680px; margin: 40px auto; padding: 0 20px; color: #222; }
code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; }
.url { background: #fff8c5; padding: 8px 12px; border-radius: 4px; font-family: ui-monospace, monospace; word-break: break-all; font-size: 14px; }
.warn { background: #fff8e1; border-left: 3px solid #f39c12; padding: 10px 14px; margin: 16px 0; }
.tip { background: #e8f4fd; border-left: 3px solid #4a90e2; padding: 10px 14px; margin: 16px 0; }
table { border-collapse: collapse; margin: 8px 0; }
table td { padding: 4px 14px 4px 0; vertical-align: top; }
ul { padding-left: 22px; }
</style></head>
<body>
<h2>${MCP_BRAND} — MCP server</h2>
<p>This is the HTTP transport. The MCP endpoint is at <code>/mcp</code>, not the bare host.</p>
<h3>Add to claude.ai</h3>
<p>In claude.ai → Connectors → Add custom connector:</p>
<table>
<tr><td><b>Name</b></td><td><code>${MCP_BRAND}</code></td></tr>
<tr><td><b>Remote MCP URL</b></td><td><div class="url">${fullMcpUrl}</div></td></tr>
<tr><td><b>OAuth fields</b></td><td>leave blank</td></tr>
</table>
<div class="tip"><b>Why the name matters:</b> claude.ai prefixes every tool with your connector name (so tools become <code>mcp__claude_ai_${MCP_BRAND.replace(/\s+/g, "_")}__browser_*</code>). Picking a clear, memorable name here means when you tell Claude "use the ${MCP_BRAND} mcp" it actually finds the right tools.</div>
<div class="warn">If you pasted the URL <em>without</em> <code>/mcp</code> at the end, claude.ai will say "Couldn't reach the MCP server." Add <code>/mcp</code> and try again.</div>
<h3>Health check</h3>
<p><a href="/health">/health</a> — returns the tool list as JSON if the server is up.</p>
<h3>Tools (${TOOL_NAMES.length})</h3>
<p style="color:#555; font-size:14px"><b>browser_*</b> drive the active Chrome tab via Playwriter refs (in-page). <b>screen_*</b> drive the OS at the mouse/keyboard layer — Spotlight, app switcher, native apps, recovery when browser_click fails.</p>
<ul>${TOOL_NAMES.filter((n) => n.startsWith("browser_")).map((n) => `<li><code>${n}</code></li>`).join("")}</ul>
<p style="color:#555; font-size:14px; margin-top: 16px"><b>OS-level (mouse + keyboard):</b></p>
<ul>${TOOL_NAMES.filter((n) => n.startsWith("screen_")).map((n) => `<li><code>${n}</code></li>`).join("")}</ul>
<p style="color:#888; font-size:13px">Auth: ${TOKEN ? "bearer-token required" : "off"} · Local port: ${PORT} · Brand: ${MCP_BRAND} (override with MCP_BRAND env var)</p>
</body></html>`;
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(html),
      "Access-Control-Allow-Origin": "*",
    });
    res.end(html);
    return;
  }

  // Anything other than /, /health, /mcp → 404 with the correct path.
  if (urlPath !== PATH) {
    writeJson(res, 404, {
      error: `not found — MCP endpoint is ${PATH}, not ${urlPath}`,
      hint: `paste the URL with /mcp suffix into claude.ai's connector dialog. Visit / in a browser for setup help.`,
    });
    return;
  }

  const auth = checkAuth(req);
  if (auth !== true) {
    writeJson(res, 401, { error: auth });
    return;
  }

  // Stateless mode: spin up a fresh McpServer + transport per request.
  // The browser client (Playwriter session) is module-level inside
  // tools.ts and shared across requests, so no Chrome reconnect cost
  // per call — just a tiny McpServer construction (~ms).
  const server = new McpServer({
    name: MCP_BRAND.toLowerCase().replace(/\s+/g, "-"),
    // Same commit-short stamp as the stdio server — so a session can
    // surface the SHA either by reading /health or by calling the
    // `holo3_version` tool, regardless of which transport it's on.
    version: BUILD_INFO.commitShort,
  });
  registerTools(server);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  // Body must be parsed BEFORE handleRequest — the transport doesn't
  // re-read req. (Per the SDK example: `handleRequest(req, res, req.body)`.)
  let body: unknown = null;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    writeJson(res, 400, {
      error: e instanceof Error ? e.message : String(e),
    });
    return;
  }

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    stderrLog(
      `[mcp:http] handleRequest failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    if (!res.headersSent) {
      writeJson(res, 500, {
        error: "internal MCP error",
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }
});

httpServer.listen(PORT, "127.0.0.1", () => {
  stderrLog(
    `[mcp:http] listening on http://127.0.0.1:${PORT}${PATH} ` +
      `(auth=${TOKEN ? "bearer" : "off"}) — ${buildInfoLabel()}`,
  );
  stderrLog(`[mcp:http] tools: ${TOOL_NAMES.join(", ")}`);
  stderrLog(
    `[mcp:http] expose via:  cloudflared tunnel --url http://localhost:${PORT}`,
  );
  stderrLog(
    `[mcp:http] then paste  https://<tunnel-host>${PATH}  into claude.ai's connector dialog`,
  );
});

httpServer.on("error", (e) => {
  stderrLog(`[mcp:http] server error: ${e.message}`);
  process.exit(1);
});
