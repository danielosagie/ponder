import { existsSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { commandExists, spawnInherit } from "../utils/exec";
import { readManagedEnv, writeManagedEnv } from "../utils/env";

interface LocalInstallerOpts {
  cwd: string;
  packageRoot: string;
}

const TIERS = [
  { value: "I-Mini", hint: "14 GB — 16 GB M1 (tight)" },
  { value: "I-Compact", hint: "17 GB — Windows + 32 GB RAM, or 24 GB GPU (default)" },
  { value: "I-Quality", hint: "23 GB — A10G/L40S or 32 GB+ unified" },
];

/**
 * Run `scripts/setup-local.sh` from the package tarball with the chosen tier
 * environment variable set. Streams the script's output (huggingface-cli +
 * ollama create) so the user can see the multi-GB download progress.
 */
export async function installLocal(opts: LocalInstallerOpts): Promise<void> {
  if (!(await commandExists("ollama"))) {
    p.log.error(
      "`ollama` not found. Install from https://ollama.com/download and re-run.",
    );
    throw new Error("ollama missing");
  }
  if (!(await commandExists("huggingface-cli"))) {
    p.log.error(
      "`huggingface-cli` not found. Install with:  pipx install huggingface_hub",
    );
    throw new Error("huggingface-cli missing");
  }

  const tier = (await p.select({
    message: "Holo3 GGUF tier",
    options: TIERS.map((t) => ({ value: t.value, label: t.value, hint: t.hint })),
    initialValue: "I-Compact",
  })) as string;
  if (p.isCancel(tier)) throw new Error("cancelled");

  const script = join(opts.packageRoot, "scripts", "setup-local.sh");
  if (!existsSync(script)) {
    throw new Error(
      `scripts/setup-local.sh not found at ${script} — package install may be corrupt`,
    );
  }

  p.log.info("Downloading Holo3 GGUF + importing into Ollama. This is multi-GB.");
  await spawnInherit("bash", [script], {
    cwd: opts.cwd,
    env: { ...process.env, TIER: tier },
  });

  const existing = readManagedEnv(join(opts.cwd, ".env"));
  writeManagedEnv(join(opts.cwd, ".env"), {
    ...existing,
    OLLAMA_HOST: existing.OLLAMA_HOST ?? "http://127.0.0.1:11434",
    OLLAMA_MODEL: existing.OLLAMA_MODEL ?? "holo3",
    PONDER_PROVIDER: "local",
  });
  p.log.success("Local Holo3 installed.");
}
