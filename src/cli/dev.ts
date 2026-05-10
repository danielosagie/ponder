import chalk from "chalk";
import { spawnInherit } from "./utils/exec";

interface DevOpts {
  cwd: string;
}

/**
 * `ponder dev` — for v1 just shells out to `npx convex dev` with a banner so
 * the dev knows their schema is being watched. We don't (yet) run a separate
 * watcher for the consumer's own SDK code; their existing dev tooling handles
 * that. This command exists mainly so users have a single "start coding"
 * entry point matching the Convex/T3 mental model.
 */
export async function runDev(opts: DevOpts): Promise<void> {
  console.log(chalk.bold("ponder dev"));
  console.log(
    chalk.dim(
      "Starting `npx convex dev` — your Ponder schema (sessions/steps) " +
        "stays synced. Cancel with Ctrl-C.",
    ),
  );
  console.log();
  await spawnInherit("npx", ["convex", "dev"], { cwd: opts.cwd });
}
