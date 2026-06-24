/**
 * Real executors for the long-task orchestrator (src/agent/orchestrator.ts).
 *
 * Turns the injectable OrchestratorDeps into concrete capabilities:
 *   decompose — one LLM call splits the goal into ordered sub-tasks
 *   replay    — a saved automation that matches (cheapest, self-healing)
 *   coarse    — navigate → extract → write, in one shot (no per-row clicking)
 *   agent     — the AGP server brain for genuinely interactive sub-tasks
 *
 * The core stays mock-testable; this module is the live wiring. decomposeGoal
 * is exported separately so it can be smoke-tested without a browser.
 */

import { plannerConfigFromEnv } from "./providers/planner";
import { extractRows } from "./extract";
import { scrollToLoadAll } from "./scroll-load";
import { copyTableToClipboard, writeCsvFile } from "./export";
import { findRecipeByTask, saveRecipe } from "./recorder";
import { runAgpTask } from "./agp/loop";
import type { AgpClient } from "./agp/client";
import type { BrowserClient } from "./browser/types";
import type { OrchestratorDeps, Subtask, SubtaskResult } from "./orchestrator";

const DECOMPOSE_SYSTEM = `You break a high-level browser-automation goal into an ordered list of CONCRETE sub-tasks.
Return ONLY JSON: {"subtasks":[{"id":"s1","description":"...","kind":"navigate|extract|write|agent","params":{}}]}.
Rules:
- id: short unique ("s1","s2",...). description: ONE concrete action.
- kind: "navigate" (params.url) · "extract" (pull rows from the current/﻿given page; params.url?, params.columns?[], params.to? "clipboard"|"csv") · "write" · "agent" (anything interactive that needs the full agent).
- Prefer FEW coarse sub-tasks over many tiny clicks — e.g. one "extract" beats 20 "read a row".
- Output the JSON object only. No prose, no code fences.`;

/** One LLM call: goal → ordered sub-tasks. Reuses the planner text endpoint. */
export async function decomposeGoal(goal: string, signal?: AbortSignal): Promise<Subtask[]> {
  const cfg = plannerConfigFromEnv();
  if (!cfg) {
    // No planner configured → degrade to a single agent sub-task.
    return [{ id: "s1", description: goal, kind: "agent" }];
  }
  const ep = cfg.text;
  const res = await (cfg.fetchImpl ?? fetch)(`${ep.apiBase}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ep.apiKey}`,
      ...(ep.apiBase.includes("openrouter.ai")
        ? { "HTTP-Referer": "https://holo.company", "X-Title": "holo3-agent" }
        : {}),
    },
    body: JSON.stringify({
      model: ep.model,
      messages: [
        { role: "system", content: DECOMPOSE_SYSTEM },
        { role: "user", content: goal },
      ],
      temperature: 0,
      max_tokens: 1500,
      response_format: { type: "json_object" },
    }),
    signal,
  });
  if (!res.ok) return [{ id: "s1", description: goal, kind: "agent" }];
  const out = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  let raw = (out.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    const obj = JSON.parse(raw) as { subtasks?: Array<Partial<Subtask>> };
    const list = Array.isArray(obj.subtasks) ? obj.subtasks : [];
    const subtasks = list
      .filter((s) => s && typeof s.description === "string" && s.description.trim())
      .map((s, i) => ({
        id: typeof s.id === "string" && s.id ? s.id : `s${i + 1}`,
        description: s.description!.trim(),
        kind: (["navigate", "extract", "write", "agent"] as const).includes(s.kind as never)
          ? (s.kind as Subtask["kind"])
          : "agent",
        ...(s.params && typeof s.params === "object" ? { params: s.params } : {}),
      }));
    return subtasks.length ? subtasks : [{ id: "s1", description: goal, kind: "agent" }];
  } catch {
    return [{ id: "s1", description: goal, kind: "agent" }];
  }
}

export interface BuildDepsOpts {
  browser: BrowserClient;
  agpClient: AgpClient;
  signal?: AbortSignal;
}

export function buildOrchestratorDeps(opts: BuildDepsOpts): OrchestratorDeps {
  const { browser, agpClient, signal } = opts;
  const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

  return {
    decompose: (goal) => decomposeGoal(goal, signal),

    // Tier 1 — replay a matching saved automation (self-healing, ~0 LLM).
    replay: async (st: Subtask): Promise<SubtaskResult | null> => {
      const match = await findRecipeByTask(st.description).catch(() => null);
      if (!match || !match.recipe.steps.length) return null;
      const { replayRecipe } = await import("../cli/sdk.js");
      const res = await replayRecipe(match.recipe, {
        browser,
        reground: true,
        persist: (r) => saveRecipe(r),
      });
      return {
        status: res.failed > 0 ? "failed" : "done",
        note: `replayed ${res.ok} step(s)${res.healed ? `, adapted ${res.healed}` : ""}`,
      };
    },

    // Tier 2 — coarse navigate/extract/write (no per-row clicking).
    coarse: async (st: Subtask): Promise<SubtaskResult | null> => {
      const p = (st.params ?? {}) as Record<string, unknown>;
      const url = str(p.url);
      if (st.kind === "navigate" && url) {
        await browser.navigate(url);
        return { status: "done", note: `navigated ${url}` };
      }
      if (st.kind === "extract") {
        if (url) {
          await browser.navigate(url);
          await new Promise((r) => setTimeout(r, 1200));
        }
        await scrollToLoadAll(browser).catch(() => {}); // load all lazy items
        const text = await browser.readText();
        if (!text || !text.trim()) return { status: "failed", note: "no page text" };
        const columns = Array.isArray(p.columns) ? (p.columns as unknown[]).map(String) : undefined;
        const { headers, rows } = await extractRows({ pageText: text, columns, signal });
        const to = str(p.to);
        if (to === "clipboard" && rows.length) copyTableToClipboard({ rows, headers });
        if (to === "csv" && rows.length) writeCsvFile({ rows, headers });
        return { status: "done", rows, headers, note: `extracted ${rows.length} row(s)${to ? ` → ${to}` : ""}` };
      }
      return null; // not coarse-shaped → fall through to the agent
    },

    // Tier 3 — the AGP server brain (last resort).
    agent: async (st: Subtask): Promise<SubtaskResult> => {
      const r = await runAgpTask({ task: st.description, client: agpClient, browser, signal });
      const failed = r.status === "failed" || r.status === "error" || r.status === "timed_out";
      return { status: failed ? "failed" : "done", note: r.answer ?? r.status };
    },
  };
}
