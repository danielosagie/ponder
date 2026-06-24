/**
 * agenticLoop (AGP thin-driver mode).
 *
 * Orchestrates a browser task entirely on H-company's server-side brain:
 * create a trajectory, run the dual long-pollers (event stream +
 * driver command queue), feed the task in, and block until the brain
 * answers or the trajectory terminates. holo3-agent contributes only the
 * EXECUTION of driver commands against the user's real Chrome — no
 * client-side planning/grounding. Port of the extension's
 * `lib/agent/agentic-loop.js` lifecycle.
 */

import { AgpClient } from "./client";
import { CommandExecutor, type DriverBrowser, type CommandExecutorOpts } from "./browser-driver";
import { TrajectoryPoller, type NormalizedEvent } from "./events";
import { AGP_TRAJECTORY_IDLE_TIMEOUT_S, MAX_RUN_STEPS } from "./constants";

export interface RunAgpTaskOpts {
  task: string;
  /** Agent id — must be a CLIENT-DRIVEN agent (surfer-h-*). */
  agentId?: string;
  /** Initial URL the brain should start on. */
  startUrl?: string | null;
  client?: AgpClient;
  browser: DriverBrowser;
  /** Narration from the event stream. */
  onEvent?: (ev: NormalizedEvent) => void;
  /** Trace of executed driver commands. */
  onCommand?: CommandExecutorOpts["onCommand"];
  /** Overall wall-clock budget; default 10 min. */
  timeoutMs?: number;
  /** Driver command cap (runaway backstop); default MAX_RUN_STEPS. */
  maxCommands?: number;
  /** External cancel. */
  signal?: AbortSignal;
  /** Delete the server trajectory when done (default true). */
  cleanup?: boolean;
}

export interface RunAgpTaskResult {
  trajectoryId: string | null;
  status: "completed" | "failed" | "timed_out" | "interrupted" | "answered" | "error";
  answer: string | null;
  error: string | null;
  commandCount: number;
}

/**
 * Default AGP agent: the live Holo 3.1 HoloTab agent on the EU region.
 * Verified 2026-06-18 end-to-end (createTrajectory → drove real Chrome →
 * read the screenshot → correct answer). It is a `holo3-1-flash-visual`
 * agent — same Holo 3.1 family the user benchmarked.
 *
 * Region matters: this agent lives on agp.eu.hcompany.ai (the default base —
 * see client.ts resolveBaseUrl). The US/production public agents
 * (surfer-h-*, eval-holo-tab-*, holo-tab-holo3-pro-*) have DEAD model
 * backends on this account (0 tokens → "Error"). Re-screen any candidate
 * with `AGP_ENVIRONMENT=eu tsx bench/agp-agent-screen.ts <agent-id>`.
 */
const DEFAULT_AGENT = process.env.AGP_AGENT || "holo-tab-holo3-1-flash-visual-20260601-1612";

export async function runAgpTask(opts: RunAgpTaskOpts): Promise<RunAgpTaskResult> {
  const client = opts.client ?? new AgpClient();
  if (!client.configured) {
    return { trajectoryId: null, status: "error", answer: null, error: "No AGP API key (set HAI_API_KEY).", commandCount: 0 };
  }

  const agentId = opts.agentId ?? DEFAULT_AGENT;
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;

  // Create the server trajectory.
  let trajectoryId: string;
  try {
    const traj = await client.createTrajectory(
      agentId,
      opts.startUrl ?? null,
      { source: "holo3-agent" },
      { idleTimeoutS: AGP_TRAJECTORY_IDLE_TIMEOUT_S },
    );
    if (!traj?.id) throw new Error("createTrajectory returned no id");
    trajectoryId = traj.id;
  } catch (e) {
    return { trajectoryId: null, status: "error", answer: null, error: `createTrajectory failed: ${(e as Error).message}`, commandCount: 0 };
  }

  const poller = new TrajectoryPoller(client, trajectoryId, { onEvent: opts.onEvent });
  const executor = new CommandExecutor(client, opts.browser, trajectoryId, {
    onCommand: opts.onCommand,
    maxCommands: opts.maxCommands ?? MAX_RUN_STEPS,
  });

  // Wire external cancellation.
  const onAbort = (): void => {
    poller.stop();
    executor.stop();
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    poller.stop();
    executor.stop();
  }, timeoutMs);

  try {
    poller.start(0);
    executor.start();
    // Feed the task in. The brain begins emitting driver commands shortly
    // after (cold start ~40s on a fresh agent container).
    await client.sendBatchInteraction(trajectoryId, [
      { type: "user_message", message: opts.task, caller_id: "user" },
    ]);
    await poller.waitUntilDone();
  } catch (e) {
    poller.lastError ??= (e as Error).message;
  } finally {
    clearTimeout(watchdog);
    executor.stop();
    poller.stop();
    opts.signal?.removeEventListener("abort", onAbort);
  }

  // Best-effort stop the server loop + clean up.
  try {
    await client.sendFlowControl(trajectoryId, "stop", "loop_cleanup");
  } catch {
    /* ignore */
  }
  if (opts.cleanup !== false) {
    try {
      await client.deleteTrajectory(trajectoryId);
    } catch {
      /* ignore */
    }
  }

  const status: RunAgpTaskResult["status"] = timedOut
    ? "timed_out"
    : opts.signal?.aborted
      ? "interrupted"
      : poller.terminalStatus === "failed"
        ? "failed"
        : poller.answer
          ? "answered"
          : poller.terminalStatus === "completed"
            ? "completed"
            : poller.lastError
              ? "error"
              : "completed";

  return {
    trajectoryId,
    status,
    answer: poller.answer,
    error: poller.lastError,
    commandCount: executor.commandCount,
  };
}
