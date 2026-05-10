import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { spawnInherit, spawnSpinner } from "../utils/exec";
import { readEnvFile, writeManagedEnv } from "../utils/env";

interface ConvexInstallerOpts {
  cwd: string;
  packageRoot: string;
  /** "new" runs `npx convex dev --once`; "link" prompts for an existing URL. */
  mode: "new" | "link";
}

/**
 * Set up Convex in the consumer's project:
 *   1. Copy our schema/sessions/steps files into <cwd>/convex/ if missing.
 *   2. Run `npx convex dev --once` (mode=new) or prompt for an existing URL
 *      (mode=link).
 *   3. Push the schema with `npx convex deploy`.
 *
 * Returns the Convex deployment URL.
 */
export async function installConvex(
  opts: ConvexInstallerOpts,
): Promise<string> {
  copySchemaFiles(opts.packageRoot, opts.cwd);

  if (opts.mode === "new") {
    p.log.info(
      "Bootstrapping Convex deployment (this opens a browser if you aren't logged in)…",
    );
    await spawnInherit("npx", ["convex", "dev", "--once"], { cwd: opts.cwd });
  } else {
    const url = (await p.text({
      message: "Convex deployment URL",
      placeholder: "https://your-deployment.convex.cloud",
      validate: (value) => {
        if (!value) return "URL is required";
        if (!value.startsWith("https://")) return "Must be an https:// URL";
        return undefined;
      },
    })) as string;
    if (p.isCancel(url)) {
      throw new Error("cancelled");
    }
    const existingEnv = readEnvFile(join(opts.cwd, ".env"));
    writeManagedEnv(join(opts.cwd, ".env"), {
      ...existingEnv,
      VITE_CONVEX_URL: url,
    });
  }

  // After convex dev --once, .env.local has VITE_CONVEX_URL. Lift it into .env
  // so a single dotenv load (the SDK + the desktop app) sees it consistently.
  const envLocal = readEnvFile(join(opts.cwd, ".env.local"));
  const env = readEnvFile(join(opts.cwd, ".env"));
  const url = envLocal.VITE_CONVEX_URL ?? env.VITE_CONVEX_URL;
  if (!url) {
    throw new Error(
      "Convex setup finished but VITE_CONVEX_URL is missing from both .env and .env.local",
    );
  }

  await spawnSpinner(
    "Pushing Ponder schema to Convex",
    "npx",
    ["convex", "deploy", "-y"],
    { cwd: opts.cwd },
  );

  return url;
}

function copySchemaFiles(packageRoot: string, cwd: string): void {
  const target = join(cwd, "convex");
  mkdirSync(target, { recursive: true });
  for (const name of ["schema.ts", "sessions.ts", "steps.ts"]) {
    const src = join(packageRoot, "convex", name);
    const dst = join(target, name);
    if (!existsSync(src)) continue;
    if (existsSync(dst)) continue;
    copyFileSync(src, dst);
  }
}
