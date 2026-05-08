#!/usr/bin/env node
/**
 * One-command MCP setup CLI.
 *
 *   pnpm mcp:setup          → boot HTTP server + tunnel + print URL
 *   pnpm mcp:setup --token  → also generate a bearer token for auth
 *   pnpm mcp:setup --ngrok  → use ngrok instead of cloudflared
 *
 * What this does, in order:
 *   1. Picks an available local port (default 7831, or MCP_PORT).
 *   2. Spawns the HTTP MCP server on that port (same as `pnpm mcp:http`).
 *   3. Detects which tunnel binary is on PATH (cloudflared or ngrok),
 *      explains how to install if neither is present.
 *   4. Spawns the tunnel — cloudflared with `--protocol http2` to avoid
 *      the QUIC/UDP failure mode (`sendmsg: network is unreachable`)
 *      that hits networks blocking outbound UDP.
 *   5. Watches the tunnel's logs for its public hostname.
 *   6. Prints the FULL URL (with the /mcp suffix) in a banner that's
 *      hard to miss, plus the exact line to paste into claude.ai.
 *   7. Holds both processes open until ctrl+c, then cleans up.
 *
 * Why this exists: the previous flow ("run two terminals, find the
 * tunnel URL, append /mcp, paste") was a stack of papercuts and the
 * user kept missing the /mcp suffix. One command, copy-paste-ready URL.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as net from "node:net";
import * as path from "node:path";
import { writeState, clearState } from "./state.js";

// ── flags ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const wantToken = args.includes("--token");
const useNgrok = args.includes("--ngrok");
const port = Number(process.env.MCP_PORT ?? 7831);
const brand = process.env.MCP_BRAND ?? "Ponder";

// ── helpers ───────────────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

function log(...args: unknown[]): void {
  process.stderr.write(args.map(String).join(" ") + "\n");
}

/** Returns the path to the binary on PATH, or null. */
function which(bin: string): string | null {
  try {
    return execSync(`/usr/bin/which ${bin}`, { encoding: "utf-8" }).trim() || null;
  } catch {
    return null;
  }
}

/** Resolves once the given port accepts a TCP connection — used to wait
 *  for the HTTP server to be listening before we start the tunnel. */
async function waitForPort(p: number, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ port: p, host: "127.0.0.1" });
      sock.once("connect", () => {
        sock.end();
        resolve(true);
      });
      sock.once("error", () => resolve(false));
      sock.setTimeout(500, () => {
        sock.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not start listening on :${p} within ${timeoutMs}ms`);
}

// ── main ──────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  // 1. Generate a bearer token if requested.
  const token = wantToken ? randomBytes(24).toString("hex") : undefined;

  // 2. Find the tunnel binary.
  const tunnelName = useNgrok ? "ngrok" : "cloudflared";
  const tunnelPath = which(tunnelName);
  if (!tunnelPath) {
    log(`${C.red}✖ ${tunnelName} not found on PATH${C.reset}`);
    log("");
    if (useNgrok) {
      log("  Install with:");
      log(`    ${C.bold}brew install ngrok${C.reset}`);
    } else {
      log("  Install with:");
      log(`    ${C.bold}brew install cloudflared${C.reset}`);
      log("  Or use ngrok instead:");
      log(`    ${C.bold}pnpm mcp:setup --ngrok${C.reset}`);
    }
    log("");
    log(`  Or if you don't want a tunnel at all, switch to ${C.bold}Claude Desktop${C.reset}`);
    log(`  (the native app) and use ${C.bold}pnpm mcp${C.reset} — no tunnel needed.`);
    process.exit(1);
  }

  // 3. Spawn the HTTP server.
  const repoRoot = path.resolve(import.meta.dirname ?? __dirname, "..", "..");
  log(`${C.dim}[setup] booting MCP server on :${port}…${C.reset}`);
  const serverEnv: NodeJS.ProcessEnv = {
    ...process.env,
    MCP_PORT: String(port),
  };
  if (token) serverEnv.MCP_TOKEN = token;
  const server = spawn(
    "npx",
    ["tsx", path.join(repoRoot, "src", "mcp", "server-http.ts")],
    {
      env: serverEnv,
      cwd: repoRoot,
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  server.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      log(`${C.red}[setup] MCP server exited with code ${code}${C.reset}`);
    }
    process.exit(code ?? 0);
  });

  // 4. Wait for the server to actually be listening.
  try {
    await waitForPort(port);
  } catch (e) {
    log(
      `${C.red}[setup] ${e instanceof Error ? e.message : String(e)}${C.reset}`,
    );
    server.kill();
    process.exit(1);
  }
  log(`${C.green}[setup] MCP server is up.${C.reset}`);

  // 5. Spawn the tunnel under a watchdog. Cloudflare's free quick
  //    tunnels die ~hourly with "Unauthorized: Tunnel not found" and
  //    after a few "Lost connection with the edge" events the
  //    registration is gone. The watchdog kills cloudflared and
  //    re-spawns it on those failures so the user doesn't have to
  //    manually restart — but the URL changes on respawn (free quick
  //    tunnels can't reuse a hostname), so we re-print the banner.
  //
  //    For a STABLE URL across restarts: see the printed instructions
  //    at end-of-setup — a named cloudflared tunnel or Tailscale
  //    Funnel keeps the same URL forever.
  let tunnel: ChildProcess | null = null;
  let currentTunnelHost: string | null = null;
  let tunnelDeaths = 0;
  let lastTunnelStartMs = Date.now();
  let shuttingDown = false;
  // Threshold for "this tunnel session is broken, give it a fresh
  // start": 3 lost-connection events within 90s. Tunnels that limp
  // along with one drop per hour are fine; what we're catching is
  // the "Tunnel not found" cascade from your trace.
  const DEATH_WINDOW_MS = 90_000;
  const DEATH_THRESHOLD = 3;

  function spawnTunnel(): void {
    if (shuttingDown) return;
    log(`${C.dim}[setup] starting ${tunnelName} tunnel…${C.reset}`);
    lastTunnelStartMs = Date.now();
    tunnelDeaths = 0;
    if (useNgrok) {
      // ngrok streams the URL via its API on :4040; we'd rather just
      // parse the stderr "started tunnel ... -> https://..." line.
      tunnel = spawn(
        tunnelPath!,
        ["http", String(port), "--log=stdout", "--log-format=logfmt"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    } else {
      // --protocol http2 forces TCP/443 instead of QUIC/UDP. Avoids
      // the "sendmsg: network is unreachable" failure mode on
      // networks that block outbound UDP.
      tunnel = spawn(
        tunnelPath!,
        [
          "tunnel",
          "--url",
          `http://localhost:${port}`,
          "--protocol",
          "http2",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    }

    let printed = false;
    function watchTunnelOutput(buf: Buffer): void {
      const text = buf.toString();
      process.stderr.write(C.dim + `[${tunnelName}] ` + C.reset + text);

      // First-time URL detection.
      if (!printed) {
        const m = text.match(
          /https:\/\/[a-zA-Z0-9.-]+\.(?:trycloudflare\.com|ngrok-free\.app|ngrok\.io|ngrok\.dev|ngrok\.app)/,
        );
        if (m) {
          printed = true;
          currentTunnelHost = m[0];
          persistState(currentTunnelHost);
          printBanner(currentTunnelHost, token);
        }
      }

      // Watchdog: count failure events. cloudflared:
      //   "Lost connection with the edge"
      //   "Unauthorized: Tunnel not found"
      //   "DialContext error"
      // Any of these → tick the death counter; if we cross threshold
      // within DEATH_WINDOW_MS, kill the process and respawn fresh.
      if (
        /Lost connection with the edge|Tunnel not found|DialContext error|connection with edge closed/.test(
          text,
        )
      ) {
        tunnelDeaths += 1;
        const elapsed = Date.now() - lastTunnelStartMs;
        if (
          tunnelDeaths >= DEATH_THRESHOLD &&
          elapsed < DEATH_WINDOW_MS
        ) {
          log(
            `${C.yellow}[setup] tunnel dropped ${tunnelDeaths} times in ${Math.round(elapsed / 1000)}s — respawning for a fresh URL${C.reset}`,
          );
          // Kill and respawn — exit handler below will call
          // spawnTunnel() again.
          tunnel?.kill("SIGTERM");
        }
      }
    }
    tunnel.stdout?.on("data", watchTunnelOutput);
    tunnel.stderr?.on("data", watchTunnelOutput);
    tunnel.on("exit", (code) => {
      if (shuttingDown) return;
      log(
        `${C.red}[setup] ${tunnelName} exited (${code}). Respawning in 2s…${C.reset}`,
      );
      currentTunnelHost = null;
      persistState(null);
      setTimeout(spawnTunnel, 2000);
    });
  }

  function persistState(host: string | null): void {
    writeState({
      port,
      tunnelUrl: host,
      pasteUrl: host ? `${host}/mcp` : null,
      brand,
      tunnelKind: useNgrok ? "ngrok" : "cloudflared",
      authOn: !!token,
      setupPid: process.pid,
      updatedAt: Date.now(),
    });
  }

  // Initial state write so `pnpm mcp:status` can detect a setup is
  // running even before the tunnel URL is known.
  persistState(null);
  spawnTunnel();

  // 6. Cleanup on ctrl+c / SIGTERM.
  const cleanup = (sig: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${C.dim}[setup] received ${sig}, stopping…${C.reset}`);
    tunnel?.kill("SIGTERM");
    server.kill("SIGTERM");
    clearState();
    setTimeout(() => process.exit(0), 200);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // 7. Print stable-URL guidance at startup so the user knows quick
  //    tunnels are session-scoped on purpose.
  setTimeout(() => {
    if (!shuttingDown) printStableUrlNote();
  }, 500);
}

function printStableUrlNote(): void {
  const C2 = {
    reset: "\x1b[0m",
    dim: "\x1b[2m",
    bold: "\x1b[1m",
  };
  process.stderr.write(
    `${C2.dim}─── Heads up: trycloudflare.com URLs are session-scoped ───${C2.reset}\n`,
  );
  process.stderr.write(
    `${C2.dim}  Free quick tunnels expire after ~1h of inactivity ("Tunnel not found").${C2.reset}\n`,
  );
  process.stderr.write(
    `${C2.dim}  This setup auto-restarts on disconnect, but you'll get a NEW URL each time${C2.reset}\n`,
  );
  process.stderr.write(
    `${C2.dim}  → re-paste into claude.ai. For a STABLE URL across restarts:${C2.reset}\n`,
  );
  process.stderr.write(
    `${C2.dim}    • Named cloudflared tunnel: cloudflared tunnel login → tunnel create → DNS route${C2.reset}\n`,
  );
  process.stderr.write(
    `${C2.dim}    • Tailscale Funnel: tailscale serve --bg ${port} (free, stable hostname)${C2.reset}\n`,
  );
  process.stderr.write(
    `${C2.dim}    • Or skip tunnels entirely: use Claude Desktop + ${C2.bold}pnpm mcp${C2.reset}${C2.dim} (stdio).${C2.reset}\n\n`,
  );
}

function printBanner(host: string, token: string | undefined): void {
  const fullUrl = `${host}/mcp`;
  const bar = "═".repeat(Math.max(40, fullUrl.length + 4));
  process.stderr.write("\n");
  process.stderr.write(C.green + bar + C.reset + "\n");
  process.stderr.write(
    `${C.green}${C.bold}  Tunnel up. Paste this URL into claude.ai:${C.reset}\n`,
  );
  process.stderr.write(`${C.bold}  ${C.cyan}${fullUrl}${C.reset}\n`);
  process.stderr.write(C.green + bar + C.reset + "\n");
  process.stderr.write("\n");
  process.stderr.write(
    `${C.dim}  • In claude.ai → Connectors → Add custom connector:${C.reset}\n`,
  );
  process.stderr.write(
    `${C.dim}      Name:               ${C.bold}${brand}${C.reset}${C.dim}  ← Claude prefixes tools with this${C.reset}\n`,
  );
  process.stderr.write(
    `${C.dim}      Remote MCP URL:     ${fullUrl}${C.reset}\n`,
  );
  if (token) {
    process.stderr.write(
      `${C.yellow}  • Bearer token (set MCP_TOKEN to use it on other clients):${C.reset}\n`,
    );
    process.stderr.write(`${C.yellow}      ${token}${C.reset}\n`);
    process.stderr.write(
      `${C.dim}    (claude.ai's custom connector dialog has no bearer field — use --token only when you're driving with a non-claude.ai client.)${C.reset}\n`,
    );
  } else {
    process.stderr.write(
      `${C.dim}  • Auth is OFF. Anyone with the tunnel URL can drive your Chrome.${C.reset}\n`,
    );
    process.stderr.write(
      `${C.dim}    Tunnel hostnames are unguessable, but kill this script when done.${C.reset}\n`,
    );
  }
  process.stderr.write("\n");
  process.stderr.write(
    `${C.dim}  Verify the tunnel works in a browser: ${host}/${C.reset}\n`,
  );
  process.stderr.write(
    `${C.dim}  (If that loads our setup page, claude.ai will reach it too.)${C.reset}\n`,
  );
  process.stderr.write("\n");
  process.stderr.write(`${C.dim}  ctrl+c to stop both server and tunnel.${C.reset}\n`);
  process.stderr.write("\n");
}

void main().catch((e) => {
  log(`${C.red}[setup] ${e instanceof Error ? e.stack ?? e.message : String(e)}${C.reset}`);
  process.exit(1);
});
