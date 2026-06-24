/**
 * Scratchpad — durable, structured working memory for long (multi-hundred-step)
 * tasks. The original failure mode was "read 15 items, then forget them": the
 * agent kept everything in the LLM context, which both bloats cost at step 200
 * and evaporates on a re-plan. The scratchpad fixes that:
 *
 *   • accumulated ROWS (deduped) — the data the task is gathering
 *   • free-form FACTS (key/value) — small state the task carries
 *   • DONE sub-tasks — so a crashed/restarted run resumes where it left off
 *   • a LOG — for observability
 *
 * Persisted to ~/.ponder/runs/<runId>.json after every mutation (crash-safe via
 * atomic write). Pure Node — importable from the MCP server, the Electron main,
 * or a CLI. The orchestrator (src/agent/orchestrator.ts) owns one per run.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const RUNS_DIR = path.join(os.homedir(), ".ponder", "runs");

export interface ScratchpadState {
  runId: string;
  goal: string;
  startedAt: string;
  updatedAt: string;
  /** Accumulated table headers (first non-empty set wins). */
  headers: string[];
  /** Accumulated rows, deduped by cell-tuple. */
  rows: string[][];
  /** Small free-form state the task carries across steps. */
  facts: Record<string, unknown>;
  /** Completed sub-task ids → outcome, so resume skips them. */
  done: Record<string, { at: string; status: string; note?: string }>;
  /** Append-only outcome log (observability). */
  log: Array<{ at: string; subtask: string; status: string; note?: string }>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeRunId(goal: string): string {
  const slug =
    goal
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task";
  return `${nowIso().replace(/[:.]/g, "-").slice(0, 19)}-${slug}`;
}

const rowKey = (r: string[]): string => r.join("").toLowerCase();

export class Scratchpad {
  readonly state: ScratchpadState;
  private readonly file: string;
  private readonly seen = new Set<string>();

  private constructor(state: ScratchpadState) {
    this.state = state;
    this.file = path.join(RUNS_DIR, `${state.runId}.json`);
    for (const r of state.rows) this.seen.add(rowKey(r));
  }

  /** Start a new run (or adopt a caller-supplied stable runId). */
  static create(goal: string, runId?: string): Scratchpad {
    const at = nowIso();
    return new Scratchpad({
      runId: runId ?? makeRunId(goal),
      goal,
      startedAt: at,
      updatedAt: at,
      headers: [],
      rows: [],
      facts: {},
      done: {},
      log: [],
    });
  }

  /** Resume a run from disk, or null if it doesn't exist / is corrupt. */
  static load(runId: string): Scratchpad | null {
    try {
      const raw = fs.readFileSync(path.join(RUNS_DIR, `${runId}.json`), "utf-8");
      const state = JSON.parse(raw) as ScratchpadState;
      if (!state?.runId) return null;
      return new Scratchpad(state);
    } catch {
      return null;
    }
  }

  /** create-or-resume: load by runId if present, else start fresh with that id. */
  static open(goal: string, runId: string): { pad: Scratchpad; resumed: boolean } {
    const existing = Scratchpad.load(runId);
    if (existing) return { pad: existing, resumed: true };
    return { pad: Scratchpad.create(goal, runId), resumed: false };
  }

  get rows(): string[][] {
    return this.state.rows;
  }

  /** Append rows, deduped. Returns how many were actually new. */
  addRows(rows: string[][], headers?: string[]): number {
    if (headers?.length && !this.state.headers.length) this.state.headers = headers;
    let added = 0;
    for (const r of rows) {
      const k = rowKey(r);
      if (this.seen.has(k)) continue;
      this.seen.add(k);
      this.state.rows.push(r);
      added++;
    }
    if (added) this.save();
    return added;
  }

  put(key: string, value: unknown): void {
    this.state.facts[key] = value;
    this.save();
  }

  get<T = unknown>(key: string): T | undefined {
    return this.state.facts[key] as T | undefined;
  }

  isDone(subtaskId: string): boolean {
    return !!this.state.done[subtaskId];
  }

  markDone(subtaskId: string, status: string, note?: string): void {
    const at = nowIso();
    this.state.done[subtaskId] = { at, status, ...(note ? { note } : {}) };
    this.state.log.push({ at, subtask: subtaskId, status, ...(note ? { note } : {}) });
    this.save();
  }

  /** Atomic write (tmp + rename) so a crash mid-write can't corrupt the file. */
  save(): void {
    this.state.updatedAt = nowIso();
    try {
      fs.mkdirSync(RUNS_DIR, { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf-8");
      fs.renameSync(tmp, this.file);
    } catch {
      // best-effort durability; never throw mid-task over a disk hiccup
    }
  }

  get path(): string {
    return this.file;
  }
}
