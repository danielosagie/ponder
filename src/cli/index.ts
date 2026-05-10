import { Command } from "commander";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { runInit } from "./init";
import { runDev } from "./dev";
import { runDoctor } from "./doctor";
import { runSetProvider } from "./set-provider";

/**
 * Resolve the package root regardless of how the CLI was invoked.
 * - Production (npx ponder): __filename ≈ <pkg>/dist/cli/index.js → <pkg>
 * - Dev (tsx src/cli/index.ts): __filename ≈ <repo>/src/cli/index.ts → <repo>
 */
function resolvePackageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Walk up until we find a package.json named "ponder" — robust to either
  // dist/cli/index.js or src/cli/index.ts entry points.
  return resolve(here, "..", "..");
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("ponder")
    .description("Computer-use agent SDK + CLI")
    .version("0.1.0");

  const cwd = process.cwd();
  const packageRoot = resolvePackageRoot();

  program
    .command("init")
    .description("Set up Ponder in this project (env, provider, Convex schema)")
    .action(async () => {
      try {
        await runInit({ cwd, packageRoot });
      } catch (err) {
        if (err instanceof Error && err.message === "cancelled") {
          process.exit(0);
        }
        throw err;
      }
    });

  program
    .command("dev")
    .description("Start the development watcher (proxies `npx convex dev`)")
    .action(async () => {
      await runDev({ cwd });
    });

  program
    .command("doctor")
    .description("Verify your Ponder setup (env, Convex, provider)")
    .action(async () => {
      await runDoctor({ cwd });
    });

  program
    .command("set-provider")
    .alias("provider")
    .argument("[name]", "hosted | modal | local")
    .description("Switch the active provider, rewriting only the managed .env block")
    .action(async (name: string | undefined) => {
      try {
        await runSetProvider({ cwd, packageRoot, name });
      } catch (err) {
        if (err instanceof Error && err.message === "cancelled") {
          process.exit(0);
        }
        throw err;
      }
    });

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
