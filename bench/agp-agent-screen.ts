/**
 * AGP agent screener — find a CLIENT-DRIVEN agent with a LIVE model backend.
 *
 * For each candidate agent: create a trajectory, send a trivial task, answer
 * up to a few driver commands with synthetic data, and classify:
 *   • "client-driven + alive" — emits driver commands AND produces a
 *     policy_event / answer_event / >0 model tokens.
 *   • "client-driven + DEAD"  — emits driver commands then error_event with
 *     0 tokens (the surfer-h-pro / holo-tab-sandbox failure mode).
 *   • "server-driven"         — answers without sending any driver command.
 * Runs candidates concurrently; ~70s budget each. Cleans up every trajectory.
 */

import "dotenv/config";
import { AgpClient, type DriverCommand } from "../src/agent/agp/client";

const CANDIDATES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "surfer-h-flash",
      "surfer-h-ultra",
      "holo-tab-h-deterministic-latency-base",
      "eval-holo-tab-holo-35b-7500-hybrid-20260410-1018",
      "holo-tab-holo3-pro-visual-20260405-1838",
      "remote_desktop_holo3_122b_2026_04_14",
    ];

const SYNTH_META = {
  mouse_position: [0, 0],
  screen_size: [1280, 800],
  tabs: ["1"],
  active_tab: "1",
  url: "https://example.com",
  title: "Example Domain",
  page_size: [1280, 1200],
  scroll_position: [0, 0],
};
// A real (tiny) solid-white 64x64 PNG so visual agents have *something* valid.
const PNG_64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAH0lEQVR42u3BMQEAAADCoPVPbQ0PoAAAAAAAAAAAAL4GQ8AAAfqEYDoAAAAASUVORK5CYII=";

function synth(cmd: DriverCommand): unknown {
  switch (cmd.name) {
    case "screenshot_png_bytes":
      return PNG_64;
    case "screenshot_and_metadata":
      return { screenshot_b64: PNG_64, metadata: SYNTH_META };
    case "webpage_metadata":
      return SYNTH_META;
    case "current_url":
      return "https://example.com";
    case "observe":
      return { snapshot: '- heading (h1) "Example Domain"', is_diff: false, meta: { url: "https://example.com", title: "Example Domain", viewport: [1280, 800], scroll: [0, 0], page_height: 1200 }, has_visual_content: false };
    case "get_a11y_snapshot":
      return '- heading (h1) "Example Domain"';
    case "get_screen_size":
      return [1280, 800];
    default:
      return null;
  }
}

interface Verdict {
  agent: string;
  driverCmds: number;
  cmdNames: string[];
  policy: boolean;
  answer: string | null;
  error: string | null;
  inputTokens: number;
  classification: string;
}

async function screen(client: AgpClient, agent: string): Promise<Verdict> {
  const v: Verdict = { agent, driverCmds: 0, cmdNames: [], policy: false, answer: null, error: null, inputTokens: 0, classification: "?" };
  let id: string | null = null;
  const abort = new AbortController();
  const deadline = Date.now() + 70_000;
  try {
    const traj = await client.createTrajectory(agent, "https://example.com", { source: "holo3-screen" }, { idleTimeoutS: 100, deleteAfterMin: 3 });
    if (!traj?.id) throw new Error("no id");
    id = traj.id;
    await client.sendBatchInteraction(id, [{ type: "user_message", message: "What is the main heading? Then you're done.", caller_id: "user" }]);

    const events = (async () => {
      let from = 0;
      while (Date.now() < deadline && !abort.signal.aborted) {
        const ch = await client.getTrajectoryChanges(id!, from, { signal: abort.signal, waitForSeconds: 20 }).catch(() => null);
        if (!ch) continue;
        for (const e of ch.new_events ?? []) {
          from++;
          const inner = ((e as Record<string, unknown>).data as Record<string, unknown>)?.event as Record<string, unknown> | undefined;
          const kind = inner?.kind;
          if (kind === "policy_event") v.policy = true;
          if (kind === "answer_event") { v.answer = String(inner?.answer ?? "").slice(0, 80); abort.abort(); }
          if (kind === "error_event") v.error = String(inner?.error ?? "Error");
          const m = (e as Record<string, unknown>).type === "MetricsUpdateEvent" ? ((e as Record<string, unknown>).data as Record<string, unknown>)?.metrics as Record<string, unknown> : null;
          if (m) {
            const cpm = (m.cost_per_model as Array<Record<string, number>>) ?? [];
            v.inputTokens = Math.max(v.inputTokens, ...cpm.map((c) => c.input_tokens ?? 0), 0);
          }
        }
        if (ch.status && ["completed", "failed", "timed_out", "interrupted"].includes(ch.status)) break;
      }
    })();

    const driver = (async () => {
      while (Date.now() < deadline && !abort.signal.aborted) {
        const cmds = await client.getDriverCommands(id!, 20, abort.signal).catch(() => null);
        if (!cmds?.length) continue;
        for (const c of cmds) {
          v.driverCmds++;
          if (v.cmdNames.length < 8) v.cmdNames.push(c.name);
          await client.postDriverResult(c.id, c.command_uid, { result: synth(c), error: null }, abort.signal).catch(() => {});
        }
      }
    })();

    const watchdog = new Promise<void>((r) => setTimeout(() => { abort.abort(); r(); }, 70_000));
    await Promise.race([Promise.allSettled([events, driver]), watchdog]);
  } catch (e) {
    v.error = (e as Error).message;
  } finally {
    abort.abort();
    if (id) {
      await client.sendFlowControl(id, "stop", "screen").catch(() => {});
      await client.deleteTrajectory(id).catch(() => {});
    }
  }
  v.classification =
    v.answer || v.policy || v.inputTokens > 0
      ? v.driverCmds > 0
        ? "✅ CLIENT-DRIVEN + ALIVE"
        : "🟡 server-driven (alive, own browser)"
      : v.driverCmds > 0
        ? "❌ client-driven + DEAD backend"
        : "⚪ no activity";
  return v;
}

async function main(): Promise<void> {
  const client = new AgpClient();
  if (!client.configured) { console.error("no key"); process.exit(1); }
  console.log(`Screening ${CANDIDATES.length} agents (concurrent, ~70s)…\n`);
  const results = await Promise.all(CANDIDATES.map((a) => screen(client, a)));
  console.log("\n=== RESULTS ===");
  for (const r of results) {
    console.log(`${r.classification}  ${r.agent}`);
    console.log(`   driverCmds=${r.driverCmds} [${r.cmdNames.join(",")}] policy=${r.policy} inTok=${r.inputTokens} answer=${r.answer ?? "-"} error=${r.error ?? "-"}`);
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
