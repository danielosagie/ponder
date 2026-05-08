/**
 * MCP server bootstrap — redirects all console output to stderr AND
 * loads the project's .env files into process.env.
 *
 * MCP uses STDOUT for the JSON-RPC protocol. Any other write to stdout
 * corrupts the message stream and the MCP client (Claude Desktop) closes
 * the connection with "Invalid JSON".
 *
 * Modules in this codebase log via `console.log` at import time
 * (screen.ts logs cliclick detection, playwriter.ts logs relay status,
 * etc.). Those logs run during module evaluation — BEFORE any top-level
 * code in server.ts. To intercept them we have to override `console`
 * BEFORE the offending modules are imported.
 *
 * ES modules evaluate dependencies in DFS order. By making this file the
 * VERY FIRST static import in server.ts, its top-level overrides run
 * before any other module's top-level code, including screen.ts. After
 * this file evaluates, `console.log = stderrLog` is in effect for every
 * subsequent module evaluation in the graph.
 *
 * Why .env loading lives here: the Electron app loads .env via dotenv
 * in electron/main.ts:21-22, but the MCP server is a SEPARATE process
 * spawned by Claude Code (or whichever client) with no env inheritance
 * beyond what the host shell exposed. Without this, HAI_API_KEY /
 * MODAL_BASE_URL set in .env are invisible to the MCP and the provider
 * always falls back to "local" (Ollama). Loading happens BEFORE the
 * factory module reads env vars (which is lazy at first agent_do call,
 * but loading at boot makes it visible to ALL tool handlers from the
 * first call onwards).
 */

import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const stderrLog = (...args: unknown[]): void => {
  process.stderr.write(
    args
      .map((a) =>
        typeof a === "string"
          ? a
          : a instanceof Error
            ? a.stack ?? a.message
            : (() => {
                try {
                  return JSON.stringify(a);
                } catch {
                  return String(a);
                }
              })(),
      )
      .join(" ") + "\n",
  );
};

console.log = stderrLog;
console.warn = stderrLog;
console.error = stderrLog;
console.info = stderrLog;
console.debug = stderrLog;

// ── Load .env / .env.local from the project root ─────────────────────
//
// This file lives at src/mcp/bootstrap.ts; the project root (where
// .env / .env.local live) is two directories up. We resolve relative
// to __dirname so the loader works regardless of the launcher's CWD —
// Claude Desktop's spawn CWD is typically `/`, not the project root.
//
// We DON'T override existing process.env values (`override: false`):
// vars set by the parent shell win over .env so users can override
// project defaults without editing files.

try {
  // __dirname is provided by tsx in CJS-mode evaluation (the project's
  // package.json doesn't set "type":"module", so tsx defaults to CJS
  // semantics for bare-imported code). If for some reason it's missing,
  // fall back to resolving from process.argv[1] (the entry script).
  const here =
    typeof __dirname !== "undefined"
      ? __dirname
      : dirname(process.argv[1] ?? "");
  const projectRoot = resolve(here, "..", "..");
  for (const filename of [".env", ".env.local"]) {
    const p = join(projectRoot, filename);
    if (existsSync(p)) {
      // quiet: true suppresses dotenv@17's "◇ injected env (N) from .env"
      // tip line that would otherwise leak to stderr on every boot.
      const result = loadDotenv({ path: p, override: false, quiet: true });
      if (result.error) {
        stderrLog(`[mcp] dotenv ${filename}: ${result.error.message}`);
      } else {
        stderrLog(`[mcp] loaded ${filename}`);
      }
    }
  }
} catch (e) {
  stderrLog(
    `[mcp] dotenv load failed (continuing without): ${
      e instanceof Error ? e.message : String(e)
    }`,
  );
}
