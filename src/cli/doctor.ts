import { existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { readEnvFile } from "./utils/env";

interface DoctorOpts {
  cwd: string;
}

interface CheckResult {
  label: string;
  ok: boolean;
  detail?: string;
}

export async function runDoctor(opts: DoctorOpts): Promise<void> {
  const checks: CheckResult[] = [];

  // 1. .env parses + has either VITE_CONVEX_URL or CONVEX_URL.
  const envPath = join(opts.cwd, ".env");
  const envLocalPath = join(opts.cwd, ".env.local");
  const env = { ...readEnvFile(envPath), ...readEnvFile(envLocalPath) };
  const hasEnvFile = existsSync(envPath) || existsSync(envLocalPath);
  checks.push({
    label: ".env / .env.local present",
    ok: hasEnvFile,
    detail: hasEnvFile ? `${Object.keys(env).length} vars` : "no env files found",
  });

  const convexUrl = env.VITE_CONVEX_URL ?? env.CONVEX_URL;
  checks.push({
    label: "VITE_CONVEX_URL set",
    ok: !!convexUrl,
    detail: convexUrl ?? "missing",
  });

  // 2. Convex deployment reachable.
  if (convexUrl) {
    const reach = await ping(convexUrl);
    checks.push({
      label: "Convex deployment reachable",
      ok: reach.ok,
      detail: reach.detail,
    });
  }

  // 3. Active provider has credentials.
  const activeProvider = env.PONDER_PROVIDER ?? guessProvider(env);
  checks.push({
    label: `Provider configured (${activeProvider ?? "none"})`,
    ok: !!activeProvider && providerCredsValid(activeProvider, env),
    detail: providerDetail(activeProvider, env),
  });

  // 4. convex/ folder has schema files.
  const convexDir = join(opts.cwd, "convex");
  const schemaPresent = existsSync(join(convexDir, "schema.ts"));
  const sessionsPresent = existsSync(join(convexDir, "sessions.ts"));
  const stepsPresent = existsSync(join(convexDir, "steps.ts"));
  checks.push({
    label: "convex/ schema files",
    ok: schemaPresent && sessionsPresent && stepsPresent,
    detail: [
      schemaPresent ? "schema.ts" : "no schema.ts",
      sessionsPresent ? "sessions.ts" : "no sessions.ts",
      stepsPresent ? "steps.ts" : "no steps.ts",
    ].join(", "),
  });

  // ---- Print results ----
  console.log(chalk.bold("ponder doctor"));
  console.log();
  for (const c of checks) {
    const icon = c.ok ? chalk.green("✓") : chalk.red("✗");
    const detail = c.detail ? chalk.dim(`  ${c.detail}`) : "";
    console.log(`  ${icon} ${c.label}${detail}`);
  }
  console.log();
  const failures = checks.filter((c) => !c.ok).length;
  if (failures > 0) {
    console.log(chalk.red(`${failures} check${failures === 1 ? "" : "s"} failed.`));
    process.exit(1);
  } else {
    console.log(chalk.green("All checks passed."));
  }
}

async function ping(
  url: string,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(url, { method: "GET" });
    return {
      ok: res.status < 500,
      detail: `HTTP ${res.status}`,
    };
  } catch (e) {
    return {
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

function guessProvider(env: Record<string, string>): string | null {
  if (env.HAI_API_KEY ?? env.HCOMPANY_API_KEY) return "hcompany";
  if (env.MODAL_BASE_URL && env.MODAL_BEARER_TOKEN) return "remote";
  if (env.OLLAMA_HOST || env.OLLAMA_MODEL) return "local";
  return null;
}

function providerCredsValid(
  provider: string | null,
  env: Record<string, string>,
): boolean {
  if (!provider) return false;
  if (provider === "hcompany")
    return !!(env.HAI_API_KEY ?? env.HCOMPANY_API_KEY);
  if (provider === "remote" || provider === "modal")
    return !!(env.MODAL_BASE_URL && env.MODAL_BEARER_TOKEN);
  if (provider === "local") return !!env.OLLAMA_MODEL;
  return false;
}

function providerDetail(
  provider: string | null,
  env: Record<string, string>,
): string {
  if (!provider) return "no provider env vars detected";
  if (provider === "hcompany")
    return env.HAI_API_KEY ? "HAI_API_KEY set" : "HAI_API_KEY missing";
  if (provider === "remote" || provider === "modal")
    return env.MODAL_BASE_URL
      ? `MODAL_BASE_URL=${env.MODAL_BASE_URL}`
      : "MODAL_BASE_URL missing";
  if (provider === "local")
    return env.OLLAMA_MODEL
      ? `OLLAMA_MODEL=${env.OLLAMA_MODEL}`
      : "OLLAMA_MODEL missing";
  return "";
}
