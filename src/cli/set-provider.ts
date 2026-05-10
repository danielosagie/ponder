import * as p from "@clack/prompts";
import chalk from "chalk";
import { installHosted } from "./installers/hosted";
import { installLocal } from "./installers/local";
import { installModal } from "./installers/modal";

interface SetProviderOpts {
  cwd: string;
  packageRoot: string;
  /** "hosted" | "modal" | "local" — when omitted, prompts. */
  name?: string;
}

const VALID = new Set(["hosted", "modal", "local"]);

export async function runSetProvider(opts: SetProviderOpts): Promise<void> {
  let name = opts.name?.toLowerCase();
  if (!name || !VALID.has(name)) {
    if (name) {
      p.log.error(
        `Unknown provider "${name}". Valid: hosted, modal, local.`,
      );
    }
    name = (await p.select({
      message: "Switch to which provider?",
      options: [
        { value: "hosted", label: "Hosted (H Company)" },
        { value: "modal", label: "Self-hosted on Modal" },
        { value: "local", label: "Local (Ollama)" },
      ],
    })) as string;
    if (p.isCancel(name)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
  }

  if (name === "hosted") await installHosted({ cwd: opts.cwd });
  else if (name === "modal")
    await installModal({ cwd: opts.cwd, packageRoot: opts.packageRoot });
  else if (name === "local")
    await installLocal({ cwd: opts.cwd, packageRoot: opts.packageRoot });

  p.outro(chalk.green(`Provider switched to ${name}.`));
}
