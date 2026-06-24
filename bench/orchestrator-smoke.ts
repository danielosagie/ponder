/**
 * Smoke test for src/agent/orchestrator.ts — the long-task control-flow core.
 * Mock executors (no live browser/LLM) prove: cheapest-first routing
 * (replay→coarse→agent), checkpointing, resume (skip done sub-tasks), and the
 * agent-call budget governor.
 *
 * Run: tsx bench/orchestrator-smoke.ts
 */
import { runLongTask, type OrchestratorDeps, type Subtask } from "../src/agent/orchestrator";
import { RUNS_DIR } from "../src/agent/scratchpad";
import { unlinkSync } from "node:fs";
import { join } from "node:path";

let failed = false;
const check = (name: string, cond: boolean): void => {
  console.log(`  ${cond ? "OK " : "FAIL"}  ${name}`);
  if (!cond) failed = true;
};

const SUBTASKS: Subtask[] = [
  { id: "a", description: "saved-recipe task" },
  { id: "b", description: "extract task", kind: "extract" },
  { id: "c", description: "novel agent task" },
];

let decomposeCalls = 0;
let agentCalls = 0;
const via: Record<string, string> = {};

function makeDeps(): OrchestratorDeps {
  return {
    decompose: async () => { decomposeCalls++; return SUBTASKS; },
    replay: async (st) => (st.id === "a" ? { status: "done", rows: [["Apt", "$30"]], headers: ["Item", "Price"] } : null),
    coarse: async (st) => (st.id === "b" ? { status: "done", rows: [["Bike", "$50"]] } : null),
    agent: async (st) => { agentCalls++; return { status: "done", rows: [["Car", "$2500"]] }; },
    onProgress: (ev) => { via[ev.subtask.id] = ev.via; },
  };
}

async function main(): Promise<void> {
  const RUN = "zzz-orch-smoke-1";
  const RUN2 = "zzz-orch-smoke-2";

  // ---- Run 1: fresh ----
  const r1 = await runLongTask("smoke goal", makeDeps(), { runId: RUN });
  check("decompose called once", decomposeCalls === 1);
  check("routed a→replay", via["a"] === "replay");
  check("routed b→coarse", via["b"] === "coarse");
  check("routed c→agent", via["c"] === "agent");
  check("exactly 1 agent call (cheapest-first)", agentCalls === 1);
  check("status completed", r1.status === "completed");
  check("done 3/3", r1.done === 3 && r1.total === 3);
  check("accumulated 3 rows", r1.rows.length === 3);

  // ---- Run 2: resume same runId ----
  decomposeCalls = 0; agentCalls = 0;
  const r2 = await runLongTask("smoke goal", makeDeps(), { runId: RUN });
  check("resume does NOT re-decompose (cached plan)", decomposeCalls === 0);
  check("resume skips done → 0 agent calls", agentCalls === 0);
  check("resume still completed, 3 rows", r2.status === "completed" && r2.rows.length === 3);

  // ---- Budget: cap agent calls to 0 → c can't run ----
  agentCalls = 0;
  const r3 = await runLongTask("smoke goal", makeDeps(), { runId: RUN2, budget: { maxAgentCalls: 0 } });
  check("budget aborts on agent cap", r3.status === "aborted" && /maxAgentCalls/.test(r3.reason ?? ""));
  check("budget: a,b done before abort", r3.done === 2);
  check("budget: no agent calls made", agentCalls === 0);

  for (const id of [RUN, RUN2]) {
    try { unlinkSync(join(RUNS_DIR, `${id}.json`)); } catch { /* ignore */ }
  }

  console.log(failed ? "\nORCHESTRATOR SMOKE: FAILED" : "\nORCHESTRATOR SMOKE: ALL OK");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("[orch] error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
