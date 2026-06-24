/**
 * AGP protocol-capture probe.
 *
 * Creates ONE short-lived server-side trajectory and observes the exact
 * wire protocol the H-company brain drives: which driver commands it emits
 * (names + arg shapes + ordering) and which observation format it expects.
 * We answer each driver command with a SYNTHETIC result (no real browser
 * actions run) purely to keep the brain advancing so we can see more of the
 * vocabulary. Bounded by time / command count, then stop + delete.
 *
 * Run: HAI_API_KEY=... tsx bench/agp-protocol-probe.ts
 *      (or rely on .env). Optional args:
 *        --task "..."   the user instruction (default: read the heading)
 *        --url  "..."   start_url (default https://example.com)
 *        --max  N       stop after N driver commands (default 10)
 *        --secs N       overall time budget seconds (default 90)
 */

import "dotenv/config";
import { AgpClient, type DriverCommand } from "../src/agent/agp/client";
import {
  AGP_LONG_POLL_SECONDS,
  AGP_TERMINAL_STATUSES,
  DRIVER_LONG_POLL_SECONDS,
} from "../src/agent/agp/constants";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const TASK = arg("task", "What is the main heading shown on this page? Then you're done.");
const START_URL = arg("url", "https://example.com");
const AGENT = arg("agent", "surfer-h-pro");
const MAX_CMDS = Number(arg("max", "10"));
const TIME_BUDGET_MS = Number(arg("secs", "90")) * 1000;

const SYNTH_META = {
  url: START_URL,
  title: "Example Domain",
  viewport: [1280, 800] as [number, number],
  scroll: [0, 0] as [number, number],
  page_height: 1200,
};

// Extension-format a11y snapshot (what the real driver will produce).
const SYNTH_SNAPSHOT = [
  '- page "Example Domain":',
  '  - heading (h1) "Example Domain"',
  '  - text: "This domain is for use in illustrative examples in documents."',
  '  - link "More information..." [ref=e0]',
].join("\n");

// 1x1 transparent PNG — enough to satisfy a screenshot request shape.
const SYNTH_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** Produce a plausible result for a driver command so the brain advances. */
function synthResult(cmd: DriverCommand): unknown {
  const n = cmd.name;
  switch (n) {
    case "observe":
      return {
        snapshot: SYNTH_SNAPSHOT,
        is_diff: false,
        meta: SYNTH_META,
        has_visual_content: false,
      };
    case "observe_with_tabs":
      return {
        observe: { snapshot: SYNTH_SNAPSHOT, is_diff: false, meta: SYNTH_META, has_visual_content: false },
        tabs: ["1"],
        active_tab: "1",
      };
    case "get_a11y_snapshot":
    case "get_html":
    case "get_viewport_html":
    case "reader_mode":
    case "extract_markdown":
      return SYNTH_SNAPSHOT;
    case "screenshot_png_bytes":
      return SYNTH_PNG_B64;
    case "screenshot_and_metadata":
      return { screenshot_b64: SYNTH_PNG_B64, metadata: synthWebpageMeta() };
    case "webpage_metadata":
      return synthWebpageMeta();
    case "get_screen_size":
      return [1280, 800];
    case "get_mouse_position":
      return [0, 0];
    case "current_url":
      return START_URL;
    case "get_active_tab":
      return "1";
    case "get_tabs":
      return ["1"];
    case "get_tab_title":
      return SYNTH_META.title;
    default:
      // navigation / clicks / typing / scroll / etc. → "success, no payload"
      return null;
  }
}

function synthWebpageMeta() {
  return {
    mouse_position: [0, 0],
    screen_size: [1280, 800],
    tabs: ["1"],
    active_tab: "1",
    url: START_URL,
    title: SYNTH_META.title,
    page_size: [1280, 1200],
    scroll_position: [0, 0],
  };
}

function short(v: unknown, max = 300): string {
  let s: string;
  try {
    s = typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  return s.length > max ? s.slice(0, max) + "…" : s;
}

async function main(): Promise<void> {
  const client = new AgpClient();
  if (!client.configured) {
    console.error("No HAI_API_KEY / HCOMPANY_API_KEY in env. Aborting.");
    process.exit(1);
  }
  console.log(`[probe] base=${client.baseUrl}`);
  const quota = await client.getQuota();
  console.log(`[probe] quota=${short(quota)}`);

  console.log(`[probe] agent=${AGENT} start_url=${START_URL}`);
  const traj = await client.createTrajectory(
    AGENT,
    START_URL,
    { source: "holo3-agent-probe" },
    { idleTimeoutS: 120, deleteAfterMin: 5 },
  );
  if (!traj?.id) throw new Error("createTrajectory returned no id");
  const id = traj.id;
  console.log(`[probe] trajectory=${id} status=${traj.status ?? "?"}`);

  // Send the task.
  await client.sendBatchInteraction(id, [{ type: "user_message", message: TASK, caller_id: "user" }]);
  console.log(`[probe] sent task: "${TASK}"`);

  const deadline = Date.now() + TIME_BUDGET_MS;
  const abort = new AbortController();
  let cmdCount = 0;
  let done = false;

  const stop = (why: string): void => {
    if (done) return;
    done = true;
    console.log(`[probe] stopping (${why})`);
    abort.abort();
  };

  // --- Event stream poller ---
  const eventLoop = (async () => {
    let from = 0;
    while (!done && Date.now() < deadline) {
      try {
        const changes = await client.getTrajectoryChanges(id, from, {
          signal: abort.signal,
          waitForSeconds: AGP_LONG_POLL_SECONDS,
        });
        if (!changes) continue;
        const evs = changes.new_events ?? [];
        for (const e of evs) {
          const ev = e as { kind?: string; event?: { kind?: string }; type?: string };
          const kind = ev.kind || ev.event?.kind || ev.type || "?";
          console.log(`[event #${from}] kind=${kind}  ${short(e, 400)}`);
          from++;
        }
        if (changes.status && AGP_TERMINAL_STATUSES.includes(changes.status as never)) {
          console.log(`[probe] terminal status=${changes.status} error=${changes.error ?? "none"}`);
          stop(`terminal:${changes.status}`);
        }
      } catch (e) {
        if (abort.signal.aborted) break;
        console.warn(`[event] poll error: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  })();

  // --- Driver command poller ---
  const driverLoop = (async () => {
    while (!done && Date.now() < deadline) {
      let cmds: DriverCommand[] | null = null;
      try {
        cmds = await client.getDriverCommands(id, DRIVER_LONG_POLL_SECONDS, abort.signal);
      } catch (e) {
        if (abort.signal.aborted) break;
        console.warn(`[driver] poll error: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      if (!cmds || cmds.length === 0) continue;
      for (const cmd of cmds) {
        cmdCount++;
        console.log(
          `\n[CMD #${cmdCount}] name=${cmd.name}  uid=${cmd.command_uid ?? "?"}\n         args=${short(cmd.args, 600)}`,
        );
        const result = synthResult(cmd);
        try {
          await client.postDriverResult(cmd.id, cmd.command_uid, { result, error: null }, abort.signal);
          console.log(`         → posted result: ${short(result, 120)}`);
        } catch (e) {
          console.warn(`         → post failed: ${(e as Error).message}`);
        }
        if (cmd.name === "destroy") stop("brain sent destroy");
        if (cmdCount >= MAX_CMDS) stop(`hit max ${MAX_CMDS} commands`);
        if (done) break;
      }
    }
  })();

  // Time budget watchdog.
  const watchdog = (async () => {
    while (!done && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
    stop("time budget");
  })();

  await Promise.allSettled([eventLoop, driverLoop, watchdog]);

  // Cleanup: stop the server loop and delete the trajectory.
  try {
    await client.sendFlowControl(id, "stop", "probe_cleanup");
    console.log("[probe] sent flow_control stop");
  } catch (e) {
    console.warn(`[probe] stop failed: ${(e as Error).message}`);
  }
  try {
    await client.deleteTrajectory(id);
    console.log(`[probe] deleted trajectory ${id}`);
  } catch (e) {
    console.warn(`[probe] delete failed: ${(e as Error).message}`);
  }
  console.log(`\n[probe] done — ${cmdCount} driver commands observed.`);
  process.exit(0);
}

main().catch((e) => {
  console.error("[probe] fatal:", e);
  process.exit(1);
});
