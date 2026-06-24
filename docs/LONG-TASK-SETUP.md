# Long-running, multi-hundred-step task setup

How to make holo3-agent reliably run tasks that are hundreds of steps long —
maximizing **resources, speed, accuracy, and capability**. This is the synthesis
of everything built in the 2026-06-21/22 push plus the orchestration layer still
to build.

## The failure mode we're designing against

The original "List my FB Marketplace items in a Google Sheet" run (see the
pasted log) is the canonical disaster: the naive vision loop took a screenshot
(~500 KB) and made a 5–9s plan call **every step**, bounced between tabs, never
kept the data it read, and after 13 steps had accomplished nothing. Scale that
to 200 steps and it's hours of wall-clock, dollars of tokens, compounding drift,
and no way to resume after a crash.

## The one principle

> **Minimize the number of LLM-planned steps.** Every step that is a recipe
> replay (0 LLM calls) or a coarse tool (one call that does the work of 75) is a
> step you don't pay for in time, money, or drift. The expensive vision loop is
> the *last* resort, never the default.

A 200-step task should almost never be 200 LLM steps. It should be ~5–20
LLM decisions wrapping a lot of deterministic replay and bulk operations.

## The five layers

| Layer | Status | What it buys a long task |
|---|---|---|
| 1. Coarse tools (`extract`, `copy_table`, `write_csv`) | **DONE** | Collapses N clicks into 1 call. The single biggest step-count reducer. |
| 2. Recipe-first replay + self-heal | **DONE** | Known sub-flows run deterministically (0 LLM) and adapt when the site changes. |
| 3. AGP server brain | **DONE** | Server-side plan+ground, no per-step client screenshots, a11y-tree based — fast + cheap per step. |
| 4. **Long-task orchestrator** | **TO BUILD** | Decompose → route → checkpoint → accumulate → govern. The piece that makes 100s of steps *survivable*. |
| 5. Governor + observability | **PARTIAL** | Budget/tripwires (some in `loop.ts`), live progress view. |

Layers 1–3 already exist (`src/agent/extract.ts`, `src/agent/export.ts`,
`src/cli/sdk.ts` replay + heal, `src/agent/agp/*`). Layer 4 is the new work.

## Layer 4 — the orchestrator (the missing piece)

A durable, resumable loop that sits *above* the agent:

```
goal
 └─ decompose()            once, by a strong planner → ordered sub-tasks
     └─ for each sub-task:
         route():
           1. recipe replay  (exact-match saved automation, self-healing)  ← cheapest
           2. coarse tool     (navigate → extract → write)                  ← cheap
           3. AGP agent       (only for the genuinely novel/interactive bit) ← last resort
         checkpoint()        persist {done sub-tasks, scratchpad} to disk/Convex
         scratchpad.merge()  accumulate extracted rows in STRUCTURED memory, not LLM context
         govern()            step/cost/time budget + anti-loop tripwire; abort cleanly
     resume()                on restart, skip completed sub-tasks, reload scratchpad
```

Key properties:

- **Decompose once, not per step.** One planning call splits the goal; execution
  is then mostly deterministic. (Builds on the existing `PONDER_DECOMPOSE` path.)
- **Route cheapest-first.** Replay beats coarse beats agent. Most sub-tasks
  resolve before the vision loop is ever touched.
- **Durable checkpoint.** After each sub-task, persist progress so a 200-step
  run survives a crash/restart and resumes where it left off (the Workflow
  tool's resume model, applied to agent runs).
- **Structured scratchpad, not context bloat.** The original bug was "read 15
  items then forgot them." Extracted data lives in a typed store (the AGP driver
  already has `memory_*`); the LLM context stays small and cheap even at step 200.
- **Self-heal, don't restart.** A broken step heals (recipe) or re-plans (agent)
  *that step only*, persists the fix, and continues — never restarts the task.
- **Parallelize independent sub-tasks.** Extract from 10 pages at once
  (the chunked `extractRows` already parallelizes within one page).

## The four levers, mapped

**Resources (do less expensive work):**
- AGP server brain offloads planning/grounding compute off the machine.
- Recipe replay = 0 LLM calls for known flows.
- Coarse tools = 1 call instead of dozens.
- Cheap extractor model (DeepSeek-flash) + bounded concurrency (4).
- API-first provider default (no Modal cold starts).

**Speed (lower wall-clock):**
- replay > coarse > agent routing — skip the slow loop whenever possible.
- Parallel chunked extraction (done) — long lists in parallel, not sequentially.
- AGP a11y-tree reads instead of 500 KB screenshots every step.
- Prefetch next observation during the inter-step pause (already in `loop.ts`).

**Accuracy (get it right at scale):**
- Structured `extract` (schema/columns) instead of vision-reading prose — the
  benchmark showed it nails current-vs-strikethrough price, status, etc.
- Chunk-and-merge so long lists are *complete*, not truncated.
- Verify-after-each-sub-task; self-heal on drift; auto-confirm only on strong signal.

**Capability (do things a single loop can't):**
- Hierarchical decomposition → tasks far bigger than one context window.
- Durable resume → tasks longer than one session.
- Scratchpad memory → tasks that accumulate lots of data.
- Parallel sub-tasks → fan-out work (cross-post to 5 channels, scrape 50 pages).

## Build order (next loop iterations)

1. **Scratchpad store** — a typed, persisted key/value + rows accumulator
   (`src/agent/scratchpad.ts`), backed by disk now, Convex later.
2. **Orchestrator core** — `src/agent/orchestrator.ts`: decompose → route →
   checkpoint loop, reusing replay (`sdk.ts`), coarse tools (`extract`/`export`),
   and the AGP loop.
3. **Governor** — step/cost/time budget + tripwires (lift the anti-loop guards
   out of `loop.ts` into a reusable governor).
4. **Resume** — checkpoint file per run; `--resume <runId>` skips done sub-tasks.
5. **Observability** — the renderer's live data-table + a sub-task checklist view.

## North star

A 300-step "reprice and cross-post my 40 listings across eBay + Poshmark" task
becomes: decompose into 40 item-sub-tasks → each is a saved recipe (replay,
self-healing) + an `extract`/`write` for the data → checkpointed → resumable →
~40 cheap decisions, not 300 vision steps. That's the setup.
