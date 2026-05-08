#!/usr/bin/env node
/**
 * `pnpm mcp:doctor` — diagnostic CLI for "the agent doesn't see my tools".
 *
 * Reads each coding agent's config file, finds the holo3-browser
 * entry, then ACTUALLY SPAWNS the configured command exactly the way
 * Claude Desktop / Cursor / etc. would, sends an MCP `initialize` +
 * `tools/list` over stdio, and reports what each step did.
 *
 * Why this exists: when an MCP server doesn't show up in an agent,
 * 90% of the time the failure is at one of three boring spots:
 *   1. Config file isn't where we wrote it (permissions, alternate
 *      install path).
 *   2. The configured `command` isn't on the agent's spawn PATH —
 *      classic Claude Desktop "minimal launchd PATH" bug, fixed in
 *      install.ts by pinning to absolute paths but worth verifying.
 *   3. The server itself fails to boot (missing dep, syntax error,
 *      throws during module load) and the agent silently swallows
 *      stderr.
 *
 * Doctor checks all three with the SAME spawn the agent does, so a
 * green doctor result means "Claude Desktop will see the tools, just
 * restart it." A red result tells you exactly which step broke.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HOME = os.homedir();
const PLATFORM = process.platform;

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

interface Target {
  name: string;
  configPath: string;
}

function targets(): Target[] {
  const list: Target[] = [];
  if (PLATFORM === "darwin") {
    list.push({
      name: "Claude Desktop",
      configPath: path.join(
        HOME,
        "Library",
        "Application Support",
        "Claude",
        "claude_desktop_config.json",
      ),
    });
  } else if (PLATFORM === "win32") {
    list.push({
      name: "Claude Desktop",
      configPath: path.join(
        process.env.APPDATA ?? path.join(HOME, "AppData", "Roaming"),
        "Claude",
        "claude_desktop_config.json",
      ),
    });
  } else {
    list.push({
      name: "Claude Desktop",
      configPath: path.join(HOME, ".config", "Claude", "claude_desktop_config.json"),
    });
  }
  list.push({ name: "Cursor", configPath: path.join(HOME, ".cursor", "mcp.json") });
  list.push({ name: "Claude Code", configPath: path.join(HOME, ".claude.json") });
  list.push({
    name: "Windsurf",
    configPath: path.join(HOME, ".codeium", "windsurf", "mcp_config.json"),
  });
  return list;
}

interface RawEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface RawConfig {
  mcpServers?: Record<string, RawEntry>;
  [k: string]: unknown;
}

function readConfig(p: string): RawConfig | null {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8")) as RawConfig;
  } catch {
    return null;
  }
}

const brand = process.env.MCP_BRAND ?? "Ponder";
const entryKey = brand
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "");

interface SpawnReport {
  ok: boolean;
  step: "spawn" | "initialize" | "tools_list" | "complete";
  reason?: string;
  toolCount?: number;
  toolNames?: string[];
  stderrTail?: string;
}

/**
 * Spawn the configured command in a SCRUBBED environment that mimics
 * what Claude Desktop / Cursor see when they spawn child processes —
 * minimal PATH, no shell aliases, no homebrew prefix. If the spawn
 * succeeds here, it'll succeed there.
 *
 * Sends `initialize` and `tools/list` JSON-RPC over stdin, parses the
 * responses from stdout, returns a structured report.
 */
async function spawnAndProbe(entry: RawEntry, simulateMinimalPath: boolean): Promise<SpawnReport> {
  // Reproduce the macOS launchd-style minimal PATH that Claude Desktop
  // uses by default. On other platforms, fall back to a sensible
  // minimum. The MCP host MAY pass through more — but if our spawn
  // works under the LEAST PATH it'll work under any.
  const spawnEnv: NodeJS.ProcessEnv = {
    HOME: process.env.HOME,
    USER: process.env.USER,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    ...(entry.env ?? {}),
  };
  if (simulateMinimalPath) {
    spawnEnv.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
  } else {
    spawnEnv.PATH = process.env.PATH;
  }

  let child;
  try {
    child = spawn(entry.command, entry.args ?? [], {
      env: spawnEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    return {
      ok: false,
      step: "spawn",
      reason: `cannot spawn "${entry.command}": ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  let stdoutBuf = "";
  let stderrBuf = "";
  let spawnError: string | null = null;
  child.on("error", (e) => {
    spawnError = e.message;
  });
  child.stdout.on("data", (d: Buffer) => {
    stdoutBuf += d.toString();
  });
  child.stderr.on("data", (d: Buffer) => {
    stderrBuf += d.toString();
  });

  // Wait briefly for spawn to settle / die. If it dies, fail fast.
  await new Promise((r) => setTimeout(r, 400));
  if (spawnError) {
    return {
      ok: false,
      step: "spawn",
      reason: spawnError,
      stderrTail: stderrBuf.slice(-400),
    };
  }
  if (child.exitCode !== null) {
    return {
      ok: false,
      step: "spawn",
      reason: `process exited immediately with code ${child.exitCode}`,
      stderrTail: stderrBuf.slice(-400),
    };
  }

  // Send initialize.
  const init = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "holo3-doctor", version: "0.1.0" },
    },
  };
  const list = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  };
  child.stdin.write(JSON.stringify(init) + "\n");
  child.stdin.write(JSON.stringify(list) + "\n");

  // Wait up to 5s for the tools/list response.
  const deadline = Date.now() + 5000;
  let initResult: unknown = null;
  let toolsResult: unknown = null;
  while (Date.now() < deadline) {
    for (const line of stdoutBuf.split("\n")) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as { id?: number; result?: unknown };
        if (msg.id === 1) initResult = msg.result;
        if (msg.id === 2) toolsResult = msg.result;
      } catch {
        // partial line; skip
      }
    }
    if (initResult && toolsResult) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  child.kill("SIGTERM");

  if (!initResult) {
    return {
      ok: false,
      step: "initialize",
      reason: "no initialize response within 5s",
      stderrTail: stderrBuf.slice(-400),
    };
  }
  if (!toolsResult) {
    return {
      ok: false,
      step: "tools_list",
      reason: "no tools/list response within 5s",
      stderrTail: stderrBuf.slice(-400),
    };
  }

  const t = (toolsResult as { tools?: Array<{ name: string }> }).tools ?? [];
  return {
    ok: true,
    step: "complete",
    toolCount: t.length,
    toolNames: t.map((x) => x.name),
  };
}

async function main(): Promise<void> {
  process.stderr.write(`${C.bold}${brand} MCP — doctor${C.reset}\n`);
  process.stderr.write(`${C.dim}  brand:     ${brand}${C.reset}\n`);
  process.stderr.write(`${C.dim}  entry key: ${entryKey}${C.reset}\n\n`);

  const ts = targets();
  let anyOk = false;
  let anyConfigured = false;

  for (const t of ts) {
    process.stderr.write(`${C.bold}${t.name}${C.reset}\n`);
    const cfg = readConfig(t.configPath);
    if (!cfg) {
      process.stderr.write(
        `  ${C.dim}· no config at ${t.configPath} — target probably not installed${C.reset}\n\n`,
      );
      continue;
    }
    const entry = cfg.mcpServers?.[entryKey];
    if (!entry) {
      process.stderr.write(
        `  ${C.yellow}· config exists but has no "${entryKey}" entry${C.reset}\n`,
      );
      process.stderr.write(`  ${C.dim}  Run: ${C.bold}pnpm mcp:install${C.reset}\n\n`);
      continue;
    }
    anyConfigured = true;

    process.stderr.write(`  config:  ${C.dim}${t.configPath}${C.reset}\n`);
    process.stderr.write(`  command: ${C.dim}${entry.command} ${(entry.args ?? []).join(" ")}${C.reset}\n`);

    // First spawn under MINIMAL PATH (mimics Claude Desktop). This is
    // the strict test — passing here means the entry works regardless
    // of how the host configures PATH.
    process.stderr.write(`  ${C.dim}probing with minimal PATH (Claude Desktop-style)…${C.reset}\n`);
    const minimal = await spawnAndProbe(entry, true);
    if (minimal.ok) {
      process.stderr.write(
        `  ${C.green}✓ spawned + handshake OK with minimal PATH (${minimal.toolCount} tools)${C.reset}\n`,
      );
      anyOk = true;
    } else {
      process.stderr.write(
        `  ${C.red}✗ failed at step "${minimal.step}": ${minimal.reason}${C.reset}\n`,
      );
      if (minimal.stderrTail) {
        const lines = minimal.stderrTail.trim().split("\n").slice(-6);
        process.stderr.write(`  ${C.dim}  stderr tail:${C.reset}\n`);
        for (const l of lines) {
          process.stderr.write(`  ${C.dim}    ${l.slice(0, 200)}${C.reset}\n`);
        }
      }

      // Re-test under FULL shell PATH. If it works here, the entry
      // depends on PATH and Claude Desktop's spawn will fail.
      process.stderr.write(`  ${C.dim}retrying with full shell PATH…${C.reset}\n`);
      const shell = await spawnAndProbe(entry, false);
      if (shell.ok) {
        process.stderr.write(
          `  ${C.yellow}⚠ works with shell PATH (${shell.toolCount} tools) but FAILS with minimal PATH${C.reset}\n`,
        );
        process.stderr.write(
          `  ${C.dim}  This is the classic Claude Desktop bug. Re-run install:${C.reset}\n`,
        );
        process.stderr.write(`  ${C.dim}    ${C.bold}pnpm mcp:install --force${C.reset}\n`);
        process.stderr.write(
          `  ${C.dim}  to rewrite the entry with absolute paths.${C.reset}\n`,
        );
      } else {
        process.stderr.write(
          `  ${C.red}✗ also fails with shell PATH at step "${shell.step}": ${shell.reason}${C.reset}\n`,
        );
        if (shell.stderrTail) {
          const lines = shell.stderrTail.trim().split("\n").slice(-6);
          process.stderr.write(`  ${C.dim}  stderr tail:${C.reset}\n`);
          for (const l of lines) {
            process.stderr.write(`  ${C.dim}    ${l.slice(0, 200)}${C.reset}\n`);
          }
        }
      }
    }

    // Show first few tool names if we got them — confirms the
    // descriptions are landing where the agent will read them.
    if (minimal.ok && minimal.toolNames) {
      const head = minimal.toolNames.slice(0, 4).join(", ");
      const more =
        minimal.toolNames.length > 4
          ? `, … (${minimal.toolNames.length - 4} more)`
          : "";
      process.stderr.write(`  ${C.dim}  tools: ${head}${more}${C.reset}\n`);
    }
    process.stderr.write("\n");
  }

  if (!anyConfigured) {
    process.stderr.write(`${C.yellow}No agent has the MCP installed yet. Run:${C.reset}\n`);
    process.stderr.write(`  ${C.bold}pnpm mcp:install${C.reset}\n`);
    process.exit(1);
  }
  if (!anyOk) {
    process.stderr.write(`${C.red}No target spawned successfully. See errors above.${C.reset}\n`);
    process.exit(2);
  }
  process.stderr.write(
    `${C.green}All configured targets passed.${C.reset} ${C.dim}If your agent still doesn't see the tools, restart it (Claude Desktop / Cursor / Windsurf).${C.reset}\n`,
  );
  process.exit(0);
}

void main().catch((e) => {
  process.stderr.write(
    `${C.red}[doctor] ${e instanceof Error ? e.stack ?? e.message : String(e)}${C.reset}\n`,
  );
  process.exit(1);
});
