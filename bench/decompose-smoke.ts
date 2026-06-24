/**
 * Smoke test for decomposeGoal (orchestrator-deps) — goal → ordered sub-tasks.
 * One real OpenRouter call. Run: tsx bench/decompose-smoke.ts
 */
import "dotenv/config";
import { decomposeGoal } from "../src/agent/orchestrator-deps";

async function main(): Promise<void> {
  const goal = "List my Facebook Marketplace items with their prices and status into a Google Sheet";
  const t0 = Date.now();
  const subs = await decomposeGoal(goal);
  console.log(`[decompose] ${Date.now() - t0}ms → ${subs.length} sub-tasks\n`);
  for (const s of subs) {
    console.log(`  ${s.id} [${s.kind}] ${s.description}${s.params ? `  ${JSON.stringify(s.params)}` : ""}`);
  }
  console.log("");

  let failed = false;
  const check = (name: string, cond: boolean): void => {
    console.log(`  ${cond ? "OK " : "FAIL"}  ${name}`);
    if (!cond) failed = true;
  };
  const kinds = new Set(["navigate", "extract", "write", "agent"]);
  check("≥2 sub-tasks", subs.length >= 2);
  check("all have a description", subs.every((s) => !!s.description));
  check("all have a valid kind", subs.every((s) => kinds.has(s.kind as string)));
  check("ids are unique", new Set(subs.map((s) => s.id)).size === subs.length);
  check("plan involves extraction", subs.some((s) => s.kind === "extract" || /extract|list|pull|scrape/i.test(s.description)));

  console.log(failed ? "\nDECOMPOSE SMOKE: FAILED" : "\nDECOMPOSE SMOKE: ALL OK");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("[decompose] error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
