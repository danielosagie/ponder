import { join } from "node:path";
import * as p from "@clack/prompts";
import { readManagedEnv, writeManagedEnv } from "../utils/env";

interface HostedInstallerOpts {
  cwd: string;
  /** When true, probe the H Company API to verify the key works. */
  probe?: boolean;
}

const DEFAULT_MODEL = "holo3-35b-a3b";

export async function installHosted(opts: HostedInstallerOpts): Promise<void> {
  const apiKey = (await p.password({
    message: "H Company API key (HAI_API_KEY)",
  })) as string;
  if (p.isCancel(apiKey)) throw new Error("cancelled");
  if (!apiKey) throw new Error("HAI_API_KEY is required for the hosted provider");

  if (opts.probe ?? true) {
    const ok = await probeHosted(apiKey);
    if (!ok) {
      const proceed = await p.confirm({
        message: "Could not validate API key against api.hcompany.ai. Continue anyway?",
        initialValue: false,
      });
      if (p.isCancel(proceed) || !proceed) throw new Error("cancelled");
    }
  }

  const envPath = join(opts.cwd, ".env");
  const existing = readManagedEnv(envPath);
  writeManagedEnv(envPath, {
    ...existing,
    HAI_API_KEY: apiKey,
    HCOMPANY_MODEL: existing.HCOMPANY_MODEL ?? DEFAULT_MODEL,
    PONDER_PROVIDER: "hcompany",
  });
}

async function probeHosted(apiKey: string): Promise<boolean> {
  const spinner = p.spinner();
  spinner.start("Validating H Company API key…");
  try {
    const res = await fetch("https://api.hcompany.ai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) {
      spinner.stop("Key validated.");
      return true;
    }
    spinner.stop(`api.hcompany.ai responded ${res.status}.`);
    return false;
  } catch (e) {
    spinner.stop(
      `Could not reach api.hcompany.ai: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}
