/**
 * Long-task orchestrator — the layer that makes multi-hundred-step tasks
 * survivable (see docs/LONG-TASK-SETUP.md).
 *
 * It does NOT plan every step with an LLM. It decomposes the goal ONCE, then
 * runs each sub-task through the cheapest capable executor:
 *
 *     recipe replay  (0 LLM, self-healing)   ›   coarse tool (extract/write)
 *                                            ›   agent (the slow vision/AGP loop)
 *
 * Progress + accumulated rows are checkpointed to a durable Scratchpad after
 * every sub-task, so a crash/restart resumes where it left off. A budget caps
 * sub-tasks, expensive agent calls, and wall-clock.
 *
 * Executors are INJECTED (OrchestratorDeps) so this control-flow core is unit-
 * testable with no live browser/LLM; the real wiring (LLM decompose, recipe
 * replay, extract/write, AGP agent) is layered on top.
 */

import { Scratchpad } from "./scratchpad";

export interface Subtask {
  /** Stable id — used to skip already-done sub-tasks on resume. */
  id: string;
  description: string;
  /** Routing hint; the router still tries replay→coarse→agent regardless. */
  kind?: "navigate" | "extract" | "write" | "agent";
  params?: Record<string, unknown>;
}

export interface SubtaskResult {
  status: "done" | "failed" | "skipped";
  rows?: string[][];
  headers?: string[];
  note?: string;
}

/** An executor returns a result, or null to "fall through" to the next tier. */
export type Executor = (st: Subtask) => Promise<SubtaskResult | null>;

export interface OrchestratorDeps {
  /** Split the goal into ordered sub-tasks (one strong-model call). */
  decompose: (goal: string) => Promise<Subtask[]>;
  /** Tier 1 — replay a saved automation if one matches (cheapest). */
  replay?: Executor;
  /** Tier 2 — a coarse tool (navigate → extract → write). */
  coarse?: Executor;
  /** Tier 3 — the agent (AGP/vision loop). Last resort; never returns null. */
  agent: (st: Subtask) => Promise<SubtaskResult>;
  onProgress?: (ev: {
    index: number;
    total: number;
    subtask: Subtask;
    via: "replay" | "coarse" | "agent" | "resumed";
    result: SubtaskResult;
  }) => void;
}

export interface Budget {
  /** Stop after this many sub-tasks (default: all). */
  maxSubtasks?: number;
  /** Cap on the EXPENSIVE agent path (the cost/drift governor). */
  maxAgentCalls?: number;
  /** Wall-clock deadline in ms. */
  deadlineMs?: number;
}

export interface OrchestratorResult {
  runId: string;
  goal: string;
  status: "completed" | "partial" | "aborted";
  rows: string[][];
  headers: string[];
  done: number;
  total: number;
  agentCalls: number;
  /** Why it stopped early, if it did. */
  reason?: string;
}

export interface RunLongTaskOpts {
  /** Provide to RESUME a prior run (skips completed sub-tasks). */
  runId?: string;
  budget?: Budget;
  signal?: AbortSignal;
}

export async function runLongTask(
  goal: string,
  deps: OrchestratorDeps,
  opts: RunLongTaskOpts = {},
): Promise<OrchestratorResult> {
  const budget = opts.budget ?? {};
  const { pad } = opts.runId
    ? Scratchpad.open(goal, opts.runId)
    : { pad: Scratchpad.create(goal) };
  const runId = pad.state.runId;

  // Decompose ONCE — cache the plan on the scratchpad so resume reuses it.
  let subtasks = pad.get<Subtask[]>("subtasks");
  if (!subtasks) {
    subtasks = await deps.decompose(goal);
    pad.put("subtasks", subtasks);
  }

  const startedAt = Date.now();
  let agentCalls = 0;
  let abortReason: string | undefined;

  for (let i = 0; i < subtasks.length; i++) {
    const st = subtasks[i]!;

    if (opts.signal?.aborted) { abortReason = "interrupted"; break; }
    if (budget.maxSubtasks != null && i >= budget.maxSubtasks) { abortReason = "maxSubtasks reached"; break; }
    if (budget.deadlineMs != null && Date.now() - startedAt > budget.deadlineMs) { abortReason = "deadline reached"; break; }

    if (pad.isDone(st.id)) {
      deps.onProgress?.({ index: i, total: subtasks.length, subtask: st, via: "resumed", result: { status: "done" } });
      continue;
    }

    // Route cheapest-first.
    let result: SubtaskResult | null = null;
    let via: "replay" | "coarse" | "agent" = "agent";

    if (deps.replay) {
      result = await deps.replay(st).catch(() => null);
      if (result) via = "replay";
    }
    if (!result && deps.coarse) {
      result = await deps.coarse(st).catch(() => null);
      if (result) via = "coarse";
    }
    if (!result) {
      if (budget.maxAgentCalls != null && agentCalls >= budget.maxAgentCalls) {
        abortReason = "maxAgentCalls reached";
        break;
      }
      agentCalls++;
      via = "agent";
      result = await deps
        .agent(st)
        .catch((e) => ({ status: "failed" as const, note: e instanceof Error ? e.message : String(e) }));
    }

    if (result.rows?.length) pad.addRows(result.rows, result.headers);
    pad.markDone(st.id, result.status, `${via}${result.note ? `: ${result.note}` : ""}`);
    deps.onProgress?.({ index: i, total: subtasks.length, subtask: st, via, result });
  }

  const done = subtasks.filter((s) => pad.isDone(s.id)).length;
  const status: OrchestratorResult["status"] = abortReason
    ? "aborted"
    : done === subtasks.length
      ? "completed"
      : "partial";

  return {
    runId,
    goal,
    status,
    rows: pad.rows,
    headers: pad.state.headers,
    done,
    total: subtasks.length,
    agentCalls,
    ...(abortReason ? { reason: abortReason } : {}),
  };
}
