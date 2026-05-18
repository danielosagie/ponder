#!/usr/bin/env node
/**
 * `ponder` postinstall — probe for the Playwriter CLI and, if it's
 * missing, attempt to install it globally with whichever package
 * manager invoked us.
 *
 * Warns loudly but does NOT fail the install if Playwriter can't be
 * added (CI / restricted shells / offline laptops shouldn't have
 * their `npm i ponder` blow up because of an optional peer).
 *
 * Skip the probe entirely:
 *   PONDER_SKIP_POSTINSTALL=1 npm i ponder
 */

import { spawn } from "node:child_process";

async function which(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = spawn(bin, ["--version"], { stdio: "ignore" });
    c.on("exit", (code) => resolve(code === 0));
    c.on("error", () => resolve(false));
  });
}

function detectPackageManager(): "npm" | "pnpm" | "yarn" | "bun" {
  const ua = process.env.npm_config_user_agent ?? "";
  if (ua.startsWith("pnpm")) return "pnpm";
  if (ua.startsWith("yarn")) return "yarn";
  if (ua.startsWith("bun")) return "bun";
  return "npm";
}

async function installGlobally(pkg: string): Promise<boolean> {
  const pm = detectPackageManager();
  const args =
    pm === "yarn"
      ? ["global", "add", pkg]
      : pm === "bun"
        ? ["add", "-g", pkg]
        : pm === "pnpm"
          ? ["add", "-g", pkg]
          : ["install", "-g", pkg];
  process.stderr.write(`[ponder] installing ${pkg} via ${pm}…\n`);
  return new Promise((resolve) => {
    const c = spawn(pm, args, { stdio: "inherit" });
    c.on("exit", (code) => resolve(code === 0));
    c.on("error", () => resolve(false));
  });
}

async function main(): Promise<void> {
  if (process.env.PONDER_SKIP_POSTINSTALL === "1") return;

  // Skip when ponder is being installed as a transitive dep — we only
  // bother probing for the top-level project install.
  if (process.env.npm_config_global !== "true" && process.env.INIT_CWD === undefined) {
    return;
  }

  // Probe for the playwriter CLI. The SDK runtime imports the
  // playwriter npm package (already pulled in via `dependencies`),
  // but `playwriter browser start` (managed Chromium) and other CLI
  // helpers need the binary on PATH.
  const hasPlaywriter = await which("playwriter");
  if (hasPlaywriter) {
    process.stderr.write("[ponder] playwriter CLI on PATH — good.\n");
    process.stderr.write("[ponder] Run `ponder setup` to finish the Chrome extension step.\n");
    return;
  }

  process.stderr.write(
    "[ponder] Playwriter CLI not on PATH. Attempting global install…\n",
  );
  const ok = await installGlobally("playwriter");
  if (!ok) {
    process.stderr.write(
      "[ponder] Could not install playwriter automatically. Install it yourself:\n" +
        "         npm i -g playwriter\n" +
        "         (Then re-run `ponder setup`.)\n",
    );
    return;
  }
  process.stderr.write(
    "[ponder] Playwriter installed globally. Next steps:\n" +
      "         1. Open Chrome to chrome://extensions/\n" +
      "         2. Install the Playwriter extension from the Web Store\n" +
      "         3. Run `ponder setup`\n",
  );
}

void main().catch((e) => {
  // Postinstall must never fail npm install. Log and exit 0.
  process.stderr.write(
    `[ponder] postinstall non-fatal error: ${e instanceof Error ? e.message : String(e)}\n`,
  );
});
