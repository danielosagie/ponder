import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { commandExists } from "./exec";

export interface ProjectDetection {
  cwd: string;
  hasPackageJson: boolean;
  packageName?: string;
  hasConvexFolder: boolean;
  hasEnv: boolean;
  hasEnvLocal: boolean;
  modalInstalled: boolean;
  ollamaInstalled: boolean;
}

export async function detectProject(cwd: string): Promise<ProjectDetection> {
  const pkgPath = join(cwd, "package.json");
  const hasPackageJson = existsSync(pkgPath);
  let packageName: string | undefined;
  if (hasPackageJson) {
    try {
      const parsed = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        name?: string;
      };
      packageName = parsed.name;
    } catch {
      // ignore — left undefined
    }
  }

  const [modalInstalled, ollamaInstalled] = await Promise.all([
    commandExists("modal"),
    commandExists("ollama"),
  ]);

  return {
    cwd,
    hasPackageJson,
    packageName,
    hasConvexFolder: existsSync(join(cwd, "convex")),
    hasEnv: existsSync(join(cwd, ".env")),
    hasEnvLocal: existsSync(join(cwd, ".env.local")),
    modalInstalled,
    ollamaInstalled,
  };
}

/**
 * Resolve the package's own root (where the templates and convex schema
 * files live) so installers can copy them into the consumer's cwd. When the
 * CLI is invoked via `npx ponder` this is `node_modules/ponder/`; in dev
 * mode (`npm link` or `node dist/cli/index.js` from the repo) it walks up
 * from the bundled CLI file.
 */
export function packageRoot(importMetaUrl: string): string {
  const filePath = new URL(importMetaUrl).pathname;
  // dist/cli/index.js → walk up two levels to the package root.
  const dist = filePath.split("/dist/")[0];
  return dist;
}
