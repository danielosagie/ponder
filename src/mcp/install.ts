#!/usr/bin/env node
/**
 * One-command installer for the stdio MCP server across coding agents.
 *
 *   pnpm mcp:install              → install into every detected target
 *   pnpm mcp:install --dry-run    → show what would change, write nothing
 *   pnpm mcp:install --uninstall  → remove the entry from every target
 *   pnpm mcp:install --status     → show which targets already have it
 *
 * The user's pain — having to manage tunnel URLs and remember to start
 * the server for each agent — goes away because:
 *
 *   • stdio MCP servers are spawned ON DEMAND by the agent. Cold-start
 *     is ~1-2s for the first tool call; subsequent calls hit the warm
 *     server. When the agent session ends, the process exits cleanly.
 *
 *   • Each coding agent has its own config file with `mcpServers`.
 *     This installer writes the same stdio command into all of them
 *     so any agent you happen to use already has the tools available
 *     without per-agent manual config.
 *
 * Targets currently supported (others are skipped silently if their
 * config dir doesn't exist):
 *
 *   • Claude Desktop  (~/Library/Application Support/Claude/...)
 *   • Cursor          (~/.cursor/mcp.json)
 *   • Claude Code     (~/.claude.json — the user-level config)
 *   • Windsurf        (~/.codeium/windsurf/mcp_config.json)
 *
 * Adding a new target is a one-entry change to the TARGETS list below.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Where do the configs live ─────────────────────────────────────────
//
// Each entry: a friendly name, the absolute path to the config file,
// and (for Claude Desktop on different OSes) optional alternates.
// `mcpServers` is the canonical key in every modern MCP-aware client.

interface Target {
  name: string;
  /** Where the config file lives. We prefer to create it if missing. */
  configPath: string;
  /** Friendly URL/docs to point the user at if they want to verify. */
  docsHint?: string;
}

const HOME = os.homedir();
const PLATFORM = process.platform;

function targets(): Target[] {
  const list: Target[] = [];

  // Claude Desktop
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
      docsHint: "Settings → Developer → MCP servers",
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

  // Cursor
  list.push({
    name: "Cursor",
    configPath: path.join(HOME, ".cursor", "mcp.json"),
    docsHint: "https://docs.cursor.com/context/model-context-protocol",
  });

  // Claude Code (the CLI / IDE plugin). User-level config lives at
  // ~/.claude.json. Per-project `.mcp.json` is also supported but we
  // install at user-level so any project picks it up automatically.
  list.push({
    name: "Claude Code",
    configPath: path.join(HOME, ".claude.json"),
    docsHint: "or run: claude mcp add <name> -- <command> [args…]",
  });

  // Windsurf (Codeium's IDE)
  list.push({
    name: "Windsurf",
    configPath: path.join(HOME, ".codeium", "windsurf", "mcp_config.json"),
  });

  return list;
}

// ── Args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const uninstall = args.includes("--uninstall");
const statusOnly = args.includes("--status");
const force = args.includes("--force");

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

const log = (...a: unknown[]): void => {
  process.stderr.write(a.map(String).join(" ") + "\n");
};

// ── Build the entry we'll inject ──────────────────────────────────────
//
// Resolves the absolute path to src/mcp/server.ts based on THIS file's
// location, so wherever the user has the repo, the entry points at the
// right place. tsx + npx is used so the installer doesn't depend on a
// build step — `pnpm mcp` and Claude Desktop both work the same way.

const repoRoot = path.resolve(import.meta.dirname ?? __dirname, "..", "..");
const serverPath = path.join(repoRoot, "src", "mcp", "server.ts");
const tsxCliPath = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
// Path to the canonical skill markdown shipped with this repo. Both
// transports (Claude Code on-disk skill, Claude.ai uploaded skill)
// read from this file so an edit to the skill flows everywhere.
const skillSourcePath = path.join(repoRoot, "skills", "ponder", "SKILL.md");
// The current Node binary's absolute path — guaranteed to exist
// because we're running under it. Crucially this works when the
// MCP host (Claude Desktop, Cursor) spawns us with the macOS minimal
// PATH (/usr/bin:/bin:/usr/sbin:/sbin) which won't find homebrew node
// otherwise. process.execPath is the only reliable way to locate
// node from inside a node process.
const nodeAbs = process.execPath;
const brand = process.env.MCP_BRAND ?? "Ponder";
// The KEY in mcpServers — coding agents show this name in their MCP
// list and namespace the tools under it. Slug-safe form of the brand.
const entryKey = brand
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "");

interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

function buildEntry(): McpServerEntry {
  // ABSOLUTE PATHS, no PATH dependency. Why this matters:
  //
  // Claude Desktop on macOS spawns child processes with the minimal
  // launchd PATH (/usr/bin:/bin:/usr/sbin:/sbin). It does NOT inherit
  // your shell PATH, so /opt/homebrew/bin/npx and /opt/homebrew/bin/node
  // aren't visible — `command: "npx"` fails silently with ENOENT and
  // the agent shows zero tools with no useful error.
  //
  // Pinning to process.execPath (the absolute path of the node binary
  // running this installer) sidesteps the entire class of bug. The
  // tsx CLI is invoked as a script argument to that node, so we don't
  // need npx, tsx, or any PATH lookup at all.
  return {
    command: nodeAbs,
    args: [tsxCliPath, serverPath],
    env: {
      // Pin the brand so the descriptions match the connector name the
      // user sees in their agent. Inherited automatically when the
      // user's shell env has it set already, but explicit is clearer.
      MCP_BRAND: brand,
    },
  };
}

function entriesEqual(a: McpServerEntry, b: McpServerEntry): boolean {
  if (a.command !== b.command) return false;
  if (a.args.length !== b.args.length) return false;
  for (let i = 0; i < a.args.length; i++) {
    if (a.args[i] !== b.args[i]) return false;
  }
  // env is best-effort — don't reject on env drift, just rewrite.
  return true;
}

// ── Read / write helpers ──────────────────────────────────────────────

interface RawConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [k: string]: unknown;
}

function readConfig(p: string): RawConfig | null {
  try {
    if (!fs.existsSync(p)) return null;
    const text = fs.readFileSync(p, "utf-8");
    return JSON.parse(text) as RawConfig;
  } catch (e) {
    log(
      `${C.red}  ✖ Failed to parse ${p}: ${e instanceof Error ? e.message : String(e)}${C.reset}`,
    );
    log(`${C.dim}    Will skip this target. Fix the JSON or delete the file.${C.reset}`);
    return null;
  }
}

function writeConfig(p: string, cfg: RawConfig, isNew: boolean): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Pretty-print with 2-space indent so a human can hand-edit later.
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
  if (!isNew) {
    // Backup the previous version with a timestamp so an accidental
    // overwrite is recoverable.
    // (We took the backup BEFORE writing, see install() below — this
    // comment is just for the reader.)
  }
}

function backupConfig(p: string): string | null {
  if (!fs.existsSync(p)) return null;
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-");
  const bak = `${p}.holo3-backup-${stamp}`;
  fs.copyFileSync(p, bak);
  return bak;
}

// ── Per-target install / uninstall / status ───────────────────────────

interface ResultRow {
  target: Target;
  state: "installed" | "already-current" | "updated" | "missing" | "error" | "uninstalled" | "absent" | "skipped";
  detail?: string;
}

function install(target: Target): ResultRow {
  const entry = buildEntry();
  const existing = readConfig(target.configPath);

  if (existing && existing.mcpServers && existing.mcpServers[entryKey]) {
    if (entriesEqual(existing.mcpServers[entryKey]!, entry)) {
      return {
        target,
        state: "already-current",
        detail: `entry "${entryKey}" already points at ${serverPath}`,
      };
    }
    if (!force) {
      return {
        target,
        state: "updated",
        detail: `entry "${entryKey}" exists with different values — pass --force to overwrite (or just confirm the values match what you want)`,
      };
    }
  }

  if (dryRun) {
    return {
      target,
      state: "installed",
      detail: `(dry-run) would write to ${target.configPath}`,
    };
  }

  let bak: string | null = null;
  if (existing) {
    bak = backupConfig(target.configPath);
  }
  const cfg: RawConfig = existing ?? {};
  cfg.mcpServers = cfg.mcpServers ?? {};
  cfg.mcpServers[entryKey] = entry;
  writeConfig(target.configPath, cfg, !existing);

  return {
    target,
    state: existing && existing.mcpServers?.[entryKey] ? "updated" : "installed",
    detail: bak ? `wrote ${target.configPath} (backup: ${bak})` : `wrote ${target.configPath}`,
  };
}

function uninstallOne(target: Target): ResultRow {
  const existing = readConfig(target.configPath);
  if (!existing) {
    return {
      target,
      state: "absent",
      detail: `no config at ${target.configPath}`,
    };
  }
  if (!existing.mcpServers || !existing.mcpServers[entryKey]) {
    return {
      target,
      state: "absent",
      detail: `no "${entryKey}" entry in ${target.configPath}`,
    };
  }
  if (dryRun) {
    return {
      target,
      state: "uninstalled",
      detail: `(dry-run) would remove "${entryKey}" from ${target.configPath}`,
    };
  }
  const bak = backupConfig(target.configPath);
  delete existing.mcpServers[entryKey];
  // If mcpServers became empty, leave it as {} rather than deleting —
  // the agent's UI shows "no MCP servers" cleanly either way and the
  // next install can re-populate without re-creating the key.
  writeConfig(target.configPath, existing, false);
  return {
    target,
    state: "uninstalled",
    detail: bak ? `removed (backup: ${bak})` : "removed",
  };
}

// ── Skill install (Claude Code on-disk + Claude.ai upload guidance) ──
//
// Claude Code reads skills from ~/.claude/skills/<name>/SKILL.md and
// auto-loads them when their `description` matches the user's request.
// We copy our canonical skill there so any Claude Code session has the
// procedural guidance for the browser tools without per-project setup.
//
// Claude.ai web doesn't read disk; the user uploads skills via the
// "Write skill instructions" dialog. We can't automate that — but we
// CAN print the exact three fields they need to paste, derived from
// the same SKILL.md, so it's a 30-second copy-paste instead of a hunt
// through docs.

// Skill install path — derived from the entryKey (slug of MCP_BRAND)
// so that renaming the brand also renames the on-disk skill folder.
// Default brand "Ponder" → entryKey "ponder" → ~/.claude/skills/ponder/.
const SKILL_TARGET_DIR = path.join(HOME, ".claude", "skills", entryKey);
const SKILL_TARGET_PATH = path.join(SKILL_TARGET_DIR, "SKILL.md");

// Legacy skill folder names we should clean up on install. Earlier
// versions of this installer used "holo3-browser" as the skill name;
// when a user reinstalls after we renamed to "ponder" the old folder
// would otherwise stick around forever and Claude Code would load
// BOTH skills with overlapping descriptions, leading to duplicate
// tool routing prompts. Drop the old one (with backup) on install.
const LEGACY_SKILL_DIRS = ["holo3-browser"];

function cleanupLegacySkills(): string[] {
  const cleaned: string[] = [];
  for (const legacy of LEGACY_SKILL_DIRS) {
    if (legacy === entryKey) continue; // skip if user named brand "holo3-browser" deliberately
    const dir = path.join(HOME, ".claude", "skills", legacy);
    const file = path.join(dir, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    if (dryRun) {
      cleaned.push(`(dry-run) would remove legacy skill at ${file}`);
      continue;
    }
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      fs.copyFileSync(file, `${file}.holo3-backup-${stamp}`);
      fs.unlinkSync(file);
      try {
        fs.rmdirSync(dir);
      } catch {
        // dir not empty (the backup we just made) — leave it.
      }
      cleaned.push(`removed legacy skill ${file}`);
    } catch (e) {
      cleaned.push(
        `failed to remove legacy skill ${file}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return cleaned;
}

function installSkill(): ResultRow {
  const skillTarget: Target = {
    name: "Skill (Claude Code, ~/.claude/skills)",
    configPath: SKILL_TARGET_PATH,
  };
  if (!fs.existsSync(skillSourcePath)) {
    return {
      target: skillTarget,
      state: "error",
      detail: `skill source not found at ${skillSourcePath}`,
    };
  }
  const source = fs.readFileSync(skillSourcePath, "utf-8");
  const existing = fs.existsSync(SKILL_TARGET_PATH)
    ? fs.readFileSync(SKILL_TARGET_PATH, "utf-8")
    : null;
  if (existing === source) {
    return {
      target: skillTarget,
      state: "already-current",
      detail: "skill on disk matches the repo's SKILL.md byte-for-byte",
    };
  }
  if (dryRun) {
    return {
      target: skillTarget,
      state: existing ? "updated" : "installed",
      detail: `(dry-run) would write ${SKILL_TARGET_PATH}`,
    };
  }
  fs.mkdirSync(SKILL_TARGET_DIR, { recursive: true });
  if (existing) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(
      SKILL_TARGET_PATH,
      `${SKILL_TARGET_PATH}.holo3-backup-${stamp}`,
    );
  }
  fs.writeFileSync(SKILL_TARGET_PATH, source);

  // Clean up any legacy skill folders (e.g. "holo3-browser" from before
  // the rename to "ponder"). Keeping both around makes Claude Code
  // load duplicate skills with overlapping descriptions, which routes
  // user requests through both — confusing and wasteful.
  const legacyNotes = cleanupLegacySkills();

  let detail = `wrote ${SKILL_TARGET_PATH}`;
  if (legacyNotes.length > 0) {
    detail += "; " + legacyNotes.join("; ");
  }
  return {
    target: skillTarget,
    state: existing ? "updated" : "installed",
    detail,
  };
}

function uninstallSkill(): ResultRow {
  const skillTarget: Target = {
    name: "Skill (Claude Code, ~/.claude/skills)",
    configPath: SKILL_TARGET_PATH,
  };
  if (!fs.existsSync(SKILL_TARGET_PATH)) {
    return { target: skillTarget, state: "absent", detail: "no skill on disk" };
  }
  if (dryRun) {
    return {
      target: skillTarget,
      state: "uninstalled",
      detail: `(dry-run) would remove ${SKILL_TARGET_PATH}`,
    };
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.copyFileSync(
    SKILL_TARGET_PATH,
    `${SKILL_TARGET_PATH}.holo3-backup-${stamp}`,
  );
  fs.unlinkSync(SKILL_TARGET_PATH);
  // Remove the directory if empty (don't strand a `holo3-browser/` dir).
  try {
    fs.rmdirSync(SKILL_TARGET_DIR);
  } catch {
    // dir not empty (backup file still there) — leave it.
  }
  return {
    target: skillTarget,
    state: "uninstalled",
    detail: `removed ${SKILL_TARGET_PATH} (backed up alongside)`,
  };
}

function statusSkill(): ResultRow {
  const skillTarget: Target = {
    name: "Skill (Claude Code, ~/.claude/skills)",
    configPath: SKILL_TARGET_PATH,
  };
  if (!fs.existsSync(skillSourcePath)) {
    return {
      target: skillTarget,
      state: "error",
      detail: `skill source missing at ${skillSourcePath}`,
    };
  }
  if (!fs.existsSync(SKILL_TARGET_PATH)) {
    return { target: skillTarget, state: "absent", detail: "no skill on disk" };
  }
  const same =
    fs.readFileSync(skillSourcePath, "utf-8") ===
    fs.readFileSync(SKILL_TARGET_PATH, "utf-8");
  return {
    target: skillTarget,
    state: same ? "already-current" : "updated",
    detail: same
      ? "matches repo source"
      : "drift from repo SKILL.md — re-run install --force to refresh",
  };
}

/**
 * Parse the YAML frontmatter from SKILL.md to extract `name` +
 * `description`. We don't pull in a YAML library for two fields —
 * just regex the simple shape we control. Body is everything after
 * the closing `---`.
 */
function parseSkillFields(): { name: string; description: string; body: string } | null {
  if (!fs.existsSync(skillSourcePath)) return null;
  const text = fs.readFileSync(skillSourcePath, "utf-8");
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!m) return null;
  const fm = m[1]!;
  const body = m[2]!.trim();
  const nameM = fm.match(/^name:\s*(.+)$/m);
  const descM = fm.match(/^description:\s*(.+(?:\n  .+)*)$/m);
  if (!nameM || !descM) return null;
  return {
    name: nameM[1]!.trim(),
    description: descM[1]!.trim().replace(/\n  /g, " "),
    body,
  };
}

function printClaudeAiUploadGuide(): void {
  const fields = parseSkillFields();
  if (!fields) {
    log(
      `${C.dim}  (couldn't parse skill source — open ${skillSourcePath} manually)${C.reset}`,
    );
    return;
  }
  log("");
  log(`${C.bold}Claude.ai (web) skill upload — copy/paste these three fields:${C.reset}`);
  log(`${C.dim}  Settings → Skills → "+" → Write skill instructions${C.reset}`);
  log("");
  log(`  ${C.bold}Skill name:${C.reset}    ${fields.name}`);
  log(`  ${C.bold}Description:${C.reset}   ${fields.description}`);
  log(
    `  ${C.bold}Instructions:${C.reset}  paste the body of ${C.cyan}${skillSourcePath}${C.reset} (everything below the closing \`---\`)`,
  );
  log(
    `  ${C.dim}    (or open the file and copy from line 5 onward — that's the markdown body)${C.reset}`,
  );
}

function statusOne(target: Target): ResultRow {
  const existing = readConfig(target.configPath);
  if (!existing) {
    return {
      target,
      state: "missing",
      detail: `no config at ${target.configPath} (target probably not installed)`,
    };
  }
  if (!existing.mcpServers || !existing.mcpServers[entryKey]) {
    return {
      target,
      state: "absent",
      detail: `no "${entryKey}" entry`,
    };
  }
  const e = existing.mcpServers[entryKey]!;
  const same = entriesEqual(e, buildEntry());
  return {
    target,
    state: same ? "already-current" : "updated",
    detail: same
      ? `installed and current`
      : `installed but values differ from this repo's path; run install --force to update`,
  };
}

// ── Pretty-print + main ───────────────────────────────────────────────

function styleState(s: ResultRow["state"]): string {
  switch (s) {
    case "installed":
      return `${C.green}✓ installed${C.reset}`;
    case "updated":
      return `${C.green}✓ updated${C.reset}`;
    case "already-current":
      return `${C.green}✓ already current${C.reset}`;
    case "uninstalled":
      return `${C.green}✓ uninstalled${C.reset}`;
    case "absent":
      return `${C.dim}· not present${C.reset}`;
    case "missing":
      return `${C.dim}· target not found (skipping)${C.reset}`;
    case "error":
      return `${C.red}✖ error${C.reset}`;
    case "skipped":
      return `${C.yellow}· skipped${C.reset}`;
  }
}

async function main(): Promise<void> {
  log(`${C.bold}${brand} MCP — installer${C.reset}`);
  log(
    `${C.dim}  server path: ${serverPath}${C.reset}`,
  );
  log(`${C.dim}  entry key:   ${entryKey}${C.reset}`);
  log("");

  if (!fs.existsSync(serverPath)) {
    log(
      `${C.red}✖ ${serverPath} doesn't exist. Run this from inside the holo3-agent repo.${C.reset}`,
    );
    process.exit(1);
  }

  const ts = targets();
  const results: ResultRow[] = [];
  for (const t of ts) {
    let r: ResultRow;
    try {
      if (statusOnly) r = statusOne(t);
      else if (uninstall) r = uninstallOne(t);
      else r = install(t);
    } catch (e) {
      r = {
        target: t,
        state: "error",
        detail: e instanceof Error ? e.message : String(e),
      };
    }
    results.push(r);
  }

  // Skill install/uninstall/status. Runs alongside the MCP config
  // operations so the on-disk Claude Code skill always lines up with
  // whatever version of the MCP we just installed.
  let skillResult: ResultRow;
  try {
    if (statusOnly) skillResult = statusSkill();
    else if (uninstall) skillResult = uninstallSkill();
    else skillResult = installSkill();
  } catch (e) {
    skillResult = {
      target: {
        name: "Skill (Claude Code, ~/.claude/skills)",
        configPath: SKILL_TARGET_PATH,
      },
      state: "error",
      detail: e instanceof Error ? e.message : String(e),
    };
  }
  results.push(skillResult);

  // Pretty grid
  const nameWidth = Math.max(...results.map((r) => r.target.name.length));
  for (const r of results) {
    log(
      `  ${r.target.name.padEnd(nameWidth)}   ${styleState(r.state)}   ${C.dim}${r.detail ?? ""}${C.reset}`,
    );
  }
  log("");

  if (statusOnly) {
    process.exit(0);
  }

  if (uninstall) {
    log(`${C.dim}Uninstall complete. Restart your coding agent(s) to drop the tools.${C.reset}`);
    process.exit(0);
  }

  // Tell the user what's next
  if (dryRun) {
    log(
      `${C.yellow}Dry run only — no files were modified. Re-run without --dry-run to apply.${C.reset}`,
    );
  } else {
    log(`${C.bold}Next:${C.reset}`);
    log(`  1. Restart any agent that was running (Claude Desktop / Cursor / Windsurf).`);
    log(
      `  2. The agent will spawn the server on demand on the first tool call (~1-2s cold start).`,
    );
    log(
      `  3. Try a prompt like ${C.cyan}"open google.com in chrome and read the page"${C.reset} — the agent`,
    );
    log(`     should pick browser_navigate / browser_read on its own from the tool descriptions.`);
    log("");
    log(
      `${C.dim}If a particular agent doesn't see the tools, run ${C.bold}pnpm mcp:doctor${C.reset}${C.dim} to diagnose,${C.reset}`,
    );
    log(`${C.dim}or check the agent's config file directly with ${C.bold}pnpm mcp:install --status${C.reset}${C.dim}.${C.reset}`);

    // Claude.ai skill upload — can't be automated (web UI only) but
    // we can hand the user the exact paste-able fields.
    printClaudeAiUploadGuide();
  }
}

void main().catch((e) => {
  log(
    `${C.red}[install] ${e instanceof Error ? e.stack ?? e.message : String(e)}${C.reset}`,
  );
  process.exit(1);
});
