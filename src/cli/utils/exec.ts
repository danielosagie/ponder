import { execa, type Options as ExecaOptions } from "execa";
import ora, { type Ora } from "ora";

/**
 * Run a command with a spinner; on failure, surface stderr/stdout to the user
 * and rethrow. The spinner stops on SIGINT (so ^C feels right) — execa already
 * forwards the signal to the child.
 */
export async function spawnSpinner(
  label: string,
  command: string,
  args: string[] = [],
  options: ExecaOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const spinner: Ora = ora(label).start();
  try {
    const result = await execa(command, args, {
      stdio: "pipe",
      ...options,
    });
    spinner.succeed(label);
    return {
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
    };
  } catch (err) {
    spinner.fail(label);
    const e = err as { stdout?: string; stderr?: string; message?: string };
    if (e.stderr) console.error(e.stderr);
    else if (e.stdout) console.error(e.stdout);
    else console.error(e.message ?? String(err));
    throw err;
  }
}

/**
 * Run a command with stdio inherited (the user sees its output live). For
 * long-running commands that print progress (modal deploy, setup-local.sh,
 * convex dev). No spinner — the command prints its own.
 */
export async function spawnInherit(
  command: string,
  args: string[] = [],
  options: ExecaOptions = {},
): Promise<void> {
  await execa(command, args, { stdio: "inherit", ...options });
}

/** Returns true iff `which <bin>` succeeds. */
export async function commandExists(bin: string): Promise<boolean> {
  try {
    await execa("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
