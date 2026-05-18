/**
 * examples/drive-via-bridge.ts
 *
 * Anorha-style consumer: drive Ponder from a separate Node process
 * via the localhost HTTP bridge. Requires:
 *
 *   1. The Holo3 Electron app running (starts the bridge on :7900).
 *   2. A key issued via `ponder grant my-app --scopes browser:*,recipe:*`.
 *      Copy the printed `pndr_live_...` key and pass it as
 *      PONDER_KEY=... when running this script.
 *
 * Run with:  PONDER_KEY=pndr_live_... npx tsx examples/drive-via-bridge.ts
 */

import { createPonderClient } from "../src/cli/sdk";

async function main(): Promise<void> {
  const token = process.env.PONDER_KEY;
  if (!token) {
    console.error(
      "Set PONDER_KEY=<key>. Mint a key with: ponder grant my-app --scopes browser:*,recipe:*",
    );
    process.exit(2);
  }

  const client = createPonderClient({ token });

  if (!(await client.health())) {
    console.error(
      "Bridge not reachable. Start the Holo3 Electron app — it spawns the :7900 bridge.",
    );
    process.exit(1);
  }

  console.log(`Bridge alive at ${client.url}.`);

  // 1. Make sure a Chrome tab is attached and on example.com.
  const attached = await client.ensureAttached({ url: "https://example.com" });
  console.log(`Attached: ${attached.url} (${attached.title})`);

  // 2. Snapshot the page so we can see the refs.
  const snap = await client.browser.snapshot();
  console.log(`Snapshot URL: ${snap.url}\n${snap.ax.slice(0, 240)}…`);

  // 3. Save the trace as a recipe so the next time we run this flow we
  //    can replay it deterministically without the LLM.
  const saved = await client.recipe.save({
    task: "navigate to example.com via the bridge",
  });
  console.log(
    `Saved recipe: ${saved.id}\n  code: ${saved.recipePath}\n  json: ${saved.jsonPath}`,
  );

  // 4. Show that we can fetch what we just saved.
  const recipes = await client.recipe.list();
  console.log(`\nTotal recipes: ${recipes.length}.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  process.exit(1);
});
