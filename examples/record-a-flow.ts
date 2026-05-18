/**
 * examples/record-a-flow.ts
 *
 * Drive Ponder through the SDK, then snapshot the rolling trace buffer
 * into a saved recipe — same artifact you'd get from `ponder_recipe_save`
 * called via the MCP.
 *
 * Run with:  npx tsx examples/record-a-flow.ts
 */

import {
  ensureAttached,
  connectToUserChrome,
  startNewTrace,
  buildRecipeFromTrace,
  saveRecipe,
  recordAction,
} from "../src/cli/sdk";

async function main(): Promise<void> {
  // 1. Make sure Chrome + extension + a green tab are ready.
  await ensureAttached({ url: "https://www.google.com" });

  // 2. Mark the start of a clean recording window.
  startNewTrace({ task: "Search Google for 'ponder'" });

  // 3. Drive a Playwright Page and manually feed each action into the
  //    trace buffer. (When you drive via MCP/HTTP, recordAction is
  //    called automatically inside each browser_* handler.)
  const { page, close } = await connectToUserChrome();
  try {
    await page.goto("https://www.google.com");
    recordAction({
      type: "browser_navigate",
      payload: { url: "https://www.google.com" },
    });

    const search = page.getByRole("combobox", { name: "Search" });
    await search.fill("ponder");
    recordAction({
      type: "browser_type",
      payload: { ref: "manual", text: "ponder" },
      intent: "type 'ponder' into the search box",
    });

    await search.press("Enter");
    recordAction({
      type: "key",
      payload: { combo: "Enter" },
      intent: "submit the search",
    });

    await page.waitForLoadState("domcontentloaded");
  } finally {
    await close();
  }

  // 4. Build a recipe from the trace and persist it.
  const recipe = buildRecipeFromTrace({
    task: "Search Google for 'ponder'",
    outcome: "done",
  });
  const saved = await saveRecipe(recipe);
  if (!saved) {
    console.error("saveRecipe failed");
    process.exit(1);
  }
  console.log(`Saved recipe: ${saved.id}`);
  console.log(`  code:     ${saved.recipePath}`);
  console.log(`  manifest: ${saved.jsonPath}`);
  console.log(`\nReplay later with: ponder run ${saved.id}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
