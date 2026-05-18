/**
 * examples/replay-via-sdk.ts
 *
 * Load the most recent saved recipe and replay it without the LLM in
 * the loop. Equivalent to `ponder run` from the CLI, just from a
 * different Node program.
 *
 * Run with:  npx tsx examples/replay-via-sdk.ts [recipe-id]
 */

import {
  listRecipes,
  loadRecipe,
  replayRecipe,
} from "../src/cli/sdk";

async function main(): Promise<void> {
  const argId = process.argv[2];

  let id: string | undefined = argId;
  if (!id) {
    const entries = await listRecipes();
    if (entries.length === 0) {
      console.error(
        "No recipes recorded yet. Run examples/record-a-flow.ts first.",
      );
      process.exit(1);
    }
    id = entries[0]!.id;
    console.log(`(no id given → using latest: ${id})`);
  }

  const recipe = await loadRecipe(id);
  if (!recipe) {
    console.error(`Recipe "${id}" not found.`);
    process.exit(1);
  }

  console.log(`Replaying "${recipe.task}" (${recipe.steps.length} steps)…`);
  const result = await replayRecipe(recipe, {
    reground: true,
    onStep: ({ index, step, status, error, ms }) => {
      const label = step.intent ?? step.executed.type;
      if (status === "ok") {
        console.log(`  ✓ ${index + 1}. ${label} (${ms}ms)`);
      } else {
        console.log(`  ✗ ${index + 1}. ${label} — ${error}`);
      }
    },
  });

  console.log(
    `\nResult: ok=${result.ok}, failed=${result.failed}, ` +
      `duration=${(result.durationMs / 1000).toFixed(1)}s`,
  );
  if (result.failureScreenshotPath) {
    console.log(`Failure screenshot: ${result.failureScreenshotPath}`);
  }
  process.exit(result.failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
