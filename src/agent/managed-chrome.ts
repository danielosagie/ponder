/**
 * Managed Chrome — the zero-touch browser path.
 *
 * The Playwriter EXTENSION relay needs a per-tab user gesture (clicking the
 * green icon) because of Chrome's debugger-attach security model. To make the
 * agent zero-touch, we instead drive a Chrome that the AGENT launches with a
 * remote-debugging port and a PERSISTENT profile, and connect over CDP — no
 * extension, no click, ever. The user signs into their channels in this managed
 * browser ONCE (the only unavoidable auth); every run after is gesture-free.
 *
 * This is also the right foundation for long-running tasks: the orchestrator
 * always has an attachable browser without waiting on a human.
 */

import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

const CHROME_BIN =
  process.env.HOLO_CHROME_BIN ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Persistent profile so logins survive across launches. */
export const MANAGED_PROFILE =
  process.env.HOLO_CHROME_PROFILE ?? path.join(os.homedir(), ".holo-agent-chrome");

/** Fixed debug port the agent always connects to. */
export const MANAGED_PORT = Number(process.env.HOLO_CHROME_PORT ?? 9222);

export interface ManagedChrome {
  cdpUrl: string;
  port: number;
  /** True if this call launched Chrome (vs found one already up). */
  launched: boolean;
}

async function cdpAlive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface EnsureOpts {
  port?: number;
  profileDir?: string;
  /** Open this URL on launch (e.g. a channel sign-in, or the task's start page). */
  startUrl?: string;
  /** Max ms to wait for the debug endpoint after launch. */
  timeoutMs?: number;
}

/**
 * Ensure a CDP-attachable Chrome is running (persistent profile, debug port),
 * launching it if needed. Returns the cdpUrl to hand to
 * createPlaywriterClient({ cdpUrl }). ZERO user gesture.
 *
 * If a debug Chrome is already up on the port, reuses it (idempotent) — so
 * repeated tasks share one managed browser and one logged-in session.
 */
export async function ensureManagedChrome(opts: EnsureOpts = {}): Promise<ManagedChrome> {
  const port = opts.port ?? MANAGED_PORT;
  const profileDir = opts.profileDir ?? MANAGED_PROFILE;

  if (await cdpAlive(port)) {
    return { cdpUrl: `http://127.0.0.1:${port}`, port, launched: false };
  }

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-allow-origins=*",
    "--restore-last-session",
    opts.startUrl ?? "about:blank",
  ];
  const child = spawn(CHROME_BIN, args, { detached: true, stdio: "ignore" });
  child.unref();

  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  while (Date.now() < deadline) {
    if (await cdpAlive(port)) {
      return { cdpUrl: `http://127.0.0.1:${port}`, port, launched: true };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `Managed Chrome did not expose CDP on :${port} in time (binary: ${CHROME_BIN}).`,
  );
}
