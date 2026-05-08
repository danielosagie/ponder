#!/usr/bin/env node
/**
 * `pnpm mcp:status` — quick "is the MCP up and reachable?" CLI.
 *
 * Reads the state file written by `pnpm mcp:setup`, checks that the
 * setup PID is still alive, probes the local /health endpoint, and
 * (when a tunnel URL is registered) probes the tunnel /health
 * endpoint to verify the tunnel is end-to-end reachable.
 *
 * Use cases:
 *   • Before starting a demo: `pnpm mcp:status` → see the URL to
 *     paste, or get a clear "not running, run `pnpm mcp:setup`".
 *   • Debug claude.ai showing "Couldn't reach the MCP server": run
 *     this to disambiguate "tunnel down" vs "claude.ai cached a
 *     dead URL" vs "wrong URL pasted (missing /mcp)".
 *
 * Exits non-zero when the MCP isn't reachable, so this can also be
 * used in shell scripts: `pnpm mcp:status && do-something`.
 *
 * Pass --json to get machine-readable output.
 */

import { readState, pidAlive } from "./state.js";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

const wantJson = process.argv.slice(2).includes("--json");

interface CheckResult {
  ok: boolean;
  msg: string;
  detail?: string;
}

async function probe(url: string, timeoutMs = 4000): Promise<CheckResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      return {
        ok: false,
        msg: `HTTP ${res.status}`,
        detail: (await res.text()).slice(0, 200),
      };
    }
    const text = await res.text();
    return { ok: true, msg: "200 OK", detail: text.slice(0, 200) };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return { ok: false, msg: m };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const state = readState();

  if (!state) {
    if (wantJson) {
      console.log(JSON.stringify({ running: false, reason: "no-state-file" }));
    } else {
      console.log(`${C.red}✖ MCP setup is NOT running.${C.reset}`);
      console.log(
        `${C.dim}  No state file at /tmp/holo3-mcp-state.json — run:${C.reset}`,
      );
      console.log(`    ${C.bold}pnpm mcp:setup${C.reset}`);
    }
    process.exit(1);
  }

  // Check the setup PID. If the process is gone but the state file
  // wasn't cleaned (kill -9 / crash), that's stale state.
  const alive = pidAlive(state.setupPid);
  if (!alive) {
    if (wantJson) {
      console.log(
        JSON.stringify({
          running: false,
          reason: "stale-state",
          setupPid: state.setupPid,
        }),
      );
    } else {
      console.log(
        `${C.red}✖ Stale state file — setup process ${state.setupPid} is gone.${C.reset}`,
      );
      console.log(`${C.dim}  Restart with:${C.reset}`);
      console.log(`    ${C.bold}pnpm mcp:setup${C.reset}`);
    }
    process.exit(1);
  }

  // Probe the local server.
  const localHealth = `http://127.0.0.1:${state.port}/health`;
  const local = await probe(localHealth);

  // Probe the tunnel if we have one.
  let tunnel: CheckResult | null = null;
  if (state.tunnelUrl) {
    tunnel = await probe(`${state.tunnelUrl}/health`, 8000);
  }

  if (wantJson) {
    console.log(
      JSON.stringify({
        running: true,
        port: state.port,
        brand: state.brand,
        tunnelKind: state.tunnelKind,
        authOn: state.authOn,
        setupPid: state.setupPid,
        tunnelUrl: state.tunnelUrl,
        pasteUrl: state.pasteUrl,
        localHealthy: local.ok,
        tunnelHealthy: tunnel?.ok ?? null,
        ageSeconds: Math.round((Date.now() - state.updatedAt) / 1000),
      }),
    );
    process.exit(local.ok && (!state.tunnelUrl || tunnel?.ok) ? 0 : 2);
  }

  // Pretty output.
  console.log(`${C.bold}${state.brand} MCP — status${C.reset}`);
  console.log(`${C.dim}─────────────────────────────${C.reset}`);
  console.log(
    `Setup PID:        ${C.bold}${state.setupPid}${C.reset} ${C.green}(alive)${C.reset}`,
  );
  console.log(
    `Local server:     ${local.ok ? C.green + "✓ " + local.msg : C.red + "✗ " + local.msg}${C.reset}  ${C.dim}(${localHealth})${C.reset}`,
  );
  console.log(
    `Tunnel kind:      ${state.tunnelKind ?? "none (stdio)"}`,
  );
  if (state.tunnelUrl) {
    console.log(
      `Tunnel URL:       ${C.cyan}${state.tunnelUrl}${C.reset}`,
    );
    console.log(
      `Tunnel health:    ${tunnel?.ok ? C.green + "✓ " + tunnel.msg : C.red + "✗ " + (tunnel?.msg ?? "?")}${C.reset}`,
    );
    console.log("");
    if (state.pasteUrl) {
      console.log(`${C.bold}Paste this URL into claude.ai:${C.reset}`);
      console.log(`  ${C.cyan}${state.pasteUrl}${C.reset}`);
      console.log(`  ${C.dim}(connector name: "${state.brand}")${C.reset}`);
    }
  } else {
    console.log(
      `${C.yellow}Tunnel URL:       not yet registered (cloudflared still booting?)${C.reset}`,
    );
  }
  console.log("");
  console.log(
    `${C.dim}Last update: ${Math.round((Date.now() - state.updatedAt) / 1000)}s ago${C.reset}`,
  );

  // Non-zero exit if anything's broken — useful for shell guards.
  if (!local.ok || (state.tunnelUrl && !tunnel?.ok)) {
    console.log("");
    console.log(`${C.yellow}⚠ Something is unhealthy. Common fixes:${C.reset}`);
    if (!local.ok) {
      console.log(
        `  - Local server isn't responding. The setup process may be wedged. Restart:`,
      );
      console.log(`      ${C.bold}pkill -f 'src/mcp/setup' && pnpm mcp:setup${C.reset}`);
    }
    if (state.tunnelUrl && !tunnel?.ok) {
      console.log(
        `  - Tunnel URL not reachable from the internet — quick tunnels expire after ~1h.`,
      );
      console.log(
        `    Restart to get a fresh URL (you'll need to re-paste into claude.ai):`,
      );
      console.log(`      ${C.bold}pkill -f 'src/mcp/setup' && pnpm mcp:setup${C.reset}`);
    }
    process.exit(2);
  }

  process.exit(0);
}

void main().catch((e) => {
  console.error(`${C.red}[mcp:status] error: ${e instanceof Error ? e.message : String(e)}${C.reset}`);
  process.exit(1);
});
