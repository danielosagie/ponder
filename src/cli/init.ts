import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { spawnInherit } from "./utils/exec";
import { detectProject } from "./utils/detect";
import { ensureGitignore } from "./utils/env";
import { installConvex } from "./installers/convex";
import { installHosted } from "./installers/hosted";
import { installLocal } from "./installers/local";
import { installModal } from "./installers/modal";

interface InitOpts {
  cwd: string;
  packageRoot: string;
}

export async function runInit(opts: InitOpts): Promise<void> {
  p.intro(chalk.bold("ponder init"));
  const det = await detectProject(opts.cwd);

  if (!det.hasPackageJson) {
    const create = await p.confirm({
      message:
        "No package.json found in this directory. Run `npm init -y` first?",
      initialValue: true,
    });
    if (p.isCancel(create) || !create) {
      p.cancel("Aborting — `ponder init` needs a package.json to attach to.");
      process.exit(1);
    }
    await spawnInherit("npm", ["init", "-y"], { cwd: opts.cwd });
  }

  const provider = (await p.select({
    message: "Which provider?",
    options: [
      {
        value: "hosted",
        label: "Hosted",
        hint: "H Company API key — no infra, pay per token",
      },
      {
        value: "modal",
        label: "Self-hosted on Modal",
        hint: "Cheapest GPU; we'll deploy modal_app.py for you",
      },
      {
        value: "local",
        label: "Local",
        hint: "Ollama + Holo3 GGUF, fully offline",
      },
    ],
  })) as string;
  if (p.isCancel(provider)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  const convexMode = det.hasConvexFolder
    ? "existing"
    : ((await p.select({
        message: "Convex deployment",
        options: [
          { value: "new", label: "Create a new one (npx convex dev --once)" },
          { value: "link", label: "I'll paste an existing URL" },
        ],
        initialValue: "new",
      })) as string);
  if (p.isCancel(convexMode)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  // ---- Convex first so VITE_CONVEX_URL exists for the provider step ----
  let convexUrl: string;
  if (convexMode === "existing") {
    p.log.info("Detected an existing convex/ folder — re-using it.");
    // Re-run the schema push so the project is in sync.
    await spawnInherit("npx", ["convex", "deploy", "-y"], { cwd: opts.cwd });
    convexUrl = readEnvVar(opts.cwd, "VITE_CONVEX_URL") ?? "";
    if (!convexUrl) {
      p.log.error(
        "VITE_CONVEX_URL not found in your .env — run `npx convex dev` once " +
          "to populate it, then re-run this CLI.",
      );
      process.exit(1);
    }
  } else {
    convexUrl = await installConvex({
      cwd: opts.cwd,
      packageRoot: opts.packageRoot,
      mode: convexMode as "new" | "link",
    });
  }

  // ---- Provider ----
  if (provider === "hosted") await installHosted({ cwd: opts.cwd });
  else if (provider === "modal")
    await installModal({ cwd: opts.cwd, packageRoot: opts.packageRoot });
  else await installLocal({ cwd: opts.cwd, packageRoot: opts.packageRoot });

  // ---- Companion files ----
  copyEnvExample(opts.packageRoot, opts.cwd);
  ensureGitignore(opts.cwd, [".env", ".env.local"]);
  addPackageScripts(opts.cwd);

  // ---- Outro ----
  p.outro(chalk.green("Ponder configured."));
  printNextSteps({ provider, convexUrl });
}

function copyEnvExample(packageRoot: string, cwd: string): void {
  const src = join(packageRoot, "templates", "env.example");
  const dst = join(cwd, ".env.example");
  if (existsSync(src) && !existsSync(dst)) {
    copyFileSync(src, dst);
  }
}

function addPackageScripts(cwd: string): void {
  const path = join(cwd, "package.json");
  if (!existsSync(path)) return;
  const pkg = JSON.parse(readFileSync(path, "utf-8")) as {
    scripts?: Record<string, string>;
  };
  pkg.scripts = pkg.scripts ?? {};
  pkg.scripts["ponder:dev"] = pkg.scripts["ponder:dev"] ?? "ponder dev";
  pkg.scripts["ponder:doctor"] = pkg.scripts["ponder:doctor"] ?? "ponder doctor";
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
}

function readEnvVar(cwd: string, key: string): string | null {
  for (const file of [".env", ".env.local"]) {
    const path = join(cwd, file);
    if (!existsSync(path)) continue;
    const match = readFileSync(path, "utf-8")
      .split(/\r?\n/)
      .find((l) => l.startsWith(`${key}=`));
    if (match) return match.slice(key.length + 1).trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

function printNextSteps({
  provider,
  convexUrl,
}: {
  provider: string;
  convexUrl: string;
}): void {
  console.log();
  console.log(chalk.bold("Next steps:"));
  console.log("  1. " + chalk.cyan("npx convex dev") + "    keep this running in a separate terminal");
  console.log("  2. " + chalk.cyan("npx ponder dev") + "    starts the watcher for your dispatch code");
  console.log();
  console.log(chalk.bold("Onboard a customer:"));
  console.log(
    "  Send them this link — clicking it from any browser configures their " +
      "Ponder desktop app:",
  );
  console.log(
    "  " + chalk.green(`ponder://configure?convex=${encodeURIComponent(convexUrl)}`),
  );
  console.log();
  console.log(
    chalk.dim(
      `Active provider: ${provider}. Switch later with ` +
        chalk.bold("npx ponder set-provider <hosted|modal|local>") +
        ".",
    ),
  );
}
