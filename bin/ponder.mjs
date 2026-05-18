#!/usr/bin/env node
// Thin shim that forwards to src/cli/ponder.ts via tsx. Lets `npx ponder`
// (or a global `ponder` after `npm install -g`) work without a separate
// build step — the TypeScript source IS the source of truth, and tsx
// transparently handles the loader.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
// Repo root from `bin/`. Works whether the package is installed
// (./node_modules/<pkg>/bin/) or linked (./<pkg>/bin/).
const cliPath = path.resolve(here, "..", "src", "cli", "ponder.ts");
// Resolve tsx from the package's own dependencies.
const tsxBin = path.resolve(
  here,
  "..",
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);

const child = spawn(tsxBin, [cliPath, ...process.argv.slice(2)], {
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (e) => {
  process.stderr.write(
    `ponder: failed to spawn tsx (${e instanceof Error ? e.message : String(e)}). ` +
      `Is tsx installed? (npm install)\n`,
  );
  process.exit(127);
});
