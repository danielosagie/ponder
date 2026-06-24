/**
 * Smoke test for findRecipeByTask (the matcher behind recipe-first auto-replay).
 * Saves a throwaway recipe, matches it exact + normalized, confirms non-matches
 * and post-delete behavior, then cleans up its files.
 *
 * Run: tsx bench/auto-replay-smoke.ts
 */
import { saveRecipe, findRecipeByTask } from "../src/agent/recorder";
import type { RecordedRecipe } from "../src/agent/recorder";
import { unlinkSync } from "node:fs";

const TASK = "zzz smoke automation 9f3a list items"; // unique → can't collide with real recipes

async function main(): Promise<void> {
  const recipe: RecordedRecipe = {
    task: TASK,
    startedAt: "2099-01-01T00:00:00.000Z",
    outcome: "done",
    steps: [{ t: 0, executed: { type: "browser_navigate", payload: { url: "https://example.com" } } }],
  };
  const saved = await saveRecipe(recipe);
  if (!saved) {
    console.error("saveRecipe failed");
    process.exit(1);
  }

  let failed = false;
  const check = (name: string, cond: boolean): void => {
    console.log(`  ${cond ? "OK " : "FAIL"}  ${name}`);
    if (!cond) failed = true;
  };

  const exact = await findRecipeByTask(TASK);
  check("exact match found", exact?.id === saved.id);

  const normalized = await findRecipeByTask(`  ZZZ   Smoke Automation 9F3A   List Items  `);
  check("case/whitespace-normalized match found", normalized?.id === saved.id);

  const miss = await findRecipeByTask("buy a 1997 camry");
  check("non-matching task → null", miss === null);

  try {
    unlinkSync(saved.jsonPath);
    unlinkSync(saved.recipePath);
  } catch {
    /* ignore */
  }

  const afterDelete = await findRecipeByTask(TASK);
  check("gone after delete", afterDelete === null);

  console.log(failed ? "\nAUTO-REPLAY MATCH: FAILED" : "\nAUTO-REPLAY MATCH: ALL OK");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("[auto-replay] error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
