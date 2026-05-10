import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import {
  commandExists,
  spawnInherit,
  spawnSpinner,
} from "../utils/exec";
import { readManagedEnv, writeManagedEnv } from "../utils/env";

interface ModalInstallerOpts {
  cwd: string;
  packageRoot: string;
}

/**
 * Self-host Holo3 on Modal. Walks the user through:
 *   1. Verifying `modal` is installed (and authed via `modal token current`).
 *   2. Generating a random bearer token and creating the `holo3-agent-auth`
 *      Modal secret (or reusing an existing one).
 *   3. `modal deploy modal_app.py` — output streamed live so the user sees the
 *      ~3-minute image build the first time.
 *   4. Parsing the deploy output to extract the base URL, then writing
 *      MODAL_BASE_URL + MODAL_BEARER_TOKEN to .env.
 */
export async function installModal(opts: ModalInstallerOpts): Promise<void> {
  if (!(await commandExists("modal"))) {
    p.log.error("`modal` CLI not found. Install it with:  pipx install modal");
    p.log.info("Then re-run `npx ponder set-provider modal`.");
    throw new Error("modal CLI missing");
  }

  const modalAppPath = join(opts.packageRoot, "modal_app.py");
  if (!existsSync(modalAppPath)) {
    throw new Error(
      `modal_app.py not found at ${modalAppPath} — package install may be corrupt`,
    );
  }

  // Make sure the user is authed.
  try {
    await spawnSpinner(
      "Checking Modal auth (modal token current)",
      "modal",
      ["token", "current"],
    );
  } catch {
    p.log.warn(
      "No Modal auth token. Running `modal token new` (this opens a browser)…",
    );
    await spawnInherit("modal", ["token", "new"]);
  }

  const existingEnv = readManagedEnv(join(opts.cwd, ".env"));
  const bearer = existingEnv.MODAL_BEARER_TOKEN || randomBytes(32).toString("hex");

  // Idempotent: `modal secret create` errors if it already exists; we tolerate
  // that and trust the user's existing token. Tell them so they know.
  try {
    await spawnSpinner(
      "Creating Modal secret holo3-agent-auth",
      "modal",
      ["secret", "create", "holo3-agent-auth", `TOKEN=${bearer}`],
    );
  } catch {
    p.log.warn(
      "Modal secret holo3-agent-auth already exists — keeping the existing TOKEN. " +
        "If you need to rotate it, run `modal secret delete holo3-agent-auth` first.",
    );
  }

  p.log.info("Deploying modal_app.py — this can take a few minutes the first time.");
  const deployOutput = await spawnDeploy(modalAppPath);
  const baseUrl = parseBaseUrl(deployOutput);
  if (!baseUrl) {
    p.log.warn(
      "Could not auto-detect the deployment URL. Open https://modal.com/apps " +
        "and paste the base URL when prompted.",
    );
    const manual = (await p.text({
      message: "Modal deployment base URL",
      placeholder: "https://you--holo3-agent",
    })) as string;
    if (p.isCancel(manual) || !manual) throw new Error("cancelled");
    writeManagedEnv(join(opts.cwd, ".env"), {
      ...existingEnv,
      MODAL_BASE_URL: manual,
      MODAL_BEARER_TOKEN: bearer,
      PONDER_PROVIDER: "remote",
    });
    return;
  }

  writeManagedEnv(join(opts.cwd, ".env"), {
    ...existingEnv,
    MODAL_BASE_URL: baseUrl,
    MODAL_BEARER_TOKEN: bearer,
    PONDER_PROVIDER: "remote",
  });
  p.log.success(`Modal deployed at ${baseUrl}`);
}

async function spawnDeploy(modalAppPath: string): Promise<string> {
  // We need both: stream output to the user AND capture it to parse the URL.
  // execa supports `all: true` + `stdout: ["pipe", "inherit"]` style multiplex
  // — easier: run inherit, then re-run a brief `modal app list` to look up the
  // URL. But `modal app list --json` would be cleaner. Use the latter.
  await spawnInherit("modal", ["deploy", modalAppPath]);
  try {
    const { stdout } = await spawnSpinner(
      "Looking up deployed URL",
      "modal",
      ["app", "list", "--json"],
    );
    return stdout;
  } catch {
    return "";
  }
}

/**
 * Pull the holo3-agent app's web URL from `modal app list --json`. Modal's
 * web endpoints follow the pattern `https://<workspace>--holo3-agent-<func>.modal.run`;
 * we want the base prefix `https://<workspace>--holo3-agent` (the remote
 * provider appends per-endpoint suffixes).
 */
function parseBaseUrl(jsonOutput: string): string | null {
  try {
    const parsed = JSON.parse(jsonOutput) as Array<{
      Name?: string;
      "App Name"?: string;
      "Created at"?: string;
      Description?: string;
      State?: string;
    }>;
    if (!Array.isArray(parsed)) return null;
    const app = parsed.find((a) => {
      const name = a.Name ?? a["App Name"] ?? "";
      return name === "holo3-agent" || name.startsWith("holo3-agent");
    });
    if (!app) return null;
  } catch {
    // Older modal CLIs print non-JSON; fall through to regex extraction.
  }

  const match = jsonOutput.match(
    /https:\/\/([a-z0-9-]+)--holo3-agent[a-z0-9-]*\.modal\.run/i,
  );
  if (!match) return null;
  const workspace = match[1];
  return `https://${workspace}--holo3-agent`;
}
