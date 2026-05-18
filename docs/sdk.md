# Ponder SDK

The TypeScript SDK is the in-process API. Single import path:

```ts
import {
  defineRecipe,
  ensureAttached,
  connectToUserChrome,
  loadRecipe,
  replayRecipe,
  saveRecipe,
  listRecipes,
  createPonderClient,
  PonderError,
} from "ponder";
```

## defineRecipe — author a flow

```ts
import { defineRecipe } from "ponder";

export default defineRecipe({
  task: "Open Google and search",
  async run({ page, screen }) {
    await page.goto("https://google.com");
    await page.getByRole("textbox", { name: "Search" }).fill("ponder");
    await page.keyboard.press("Enter");
  },
});
```

Running it: `npx tsx <file>.recipe.ts`. The script auto-runs when invoked as the entry point — `import.meta.main` style. Imported from another module, `defineRecipe` returns a `{ task, execute }` object you call yourself.

## ensureAttached — Chrome cold-start helper

```ts
import { ensureAttached } from "ponder";

const { url, title } = await ensureAttached({ url: "https://example.com" });
```

Equivalent to the `ponder_browser_ensure` MCP tool: launches Chrome if needed, vision-clicks the green Playwriter icon when no tab is attached, navigates/switches when a URL is requested. Throws `PonderError("BROWSER_NOT_ATTACHED")` on failure.

## connectToUserChrome — get a Playwright Page

```ts
import { connectToUserChrome } from "ponder";

const { page, browser, close } = await connectToUserChrome();
try {
  await page.goto("https://google.com");
  // ... stock Playwright APIs ...
} finally {
  await close();
}
```

Underneath: connects to the Playwriter relay over CDP. Same Chrome, same cookies, same extensions. If the relay isn't ready, throws `PonderError("BROWSER_NOT_ATTACHED")`.

## Recipes — load / save / replay / list

```ts
import { loadRecipe, replayRecipe, saveRecipe, listRecipes } from "ponder";

const entries = await listRecipes();             // newest first
const recipe = await loadRecipe(entries[0].id);
const result = await replayRecipe(recipe!, { reground: true });
// result: { ok, failed, durationMs, failureScreenshotPath? }

await saveRecipe(recipe!);                       // round-trip — useful when you mutated the manifest
```

## createPonderClient — HTTP bridge client

When your code runs in a *separate* Node process from Ponder, use the HTTP client:

```ts
import { createPonderClient } from "ponder";

const client = createPonderClient({
  url: "http://127.0.0.1:7900",        // default
  token: process.env.PONDER_KEY,       // pndr_live_… from `ponder grant`
  session: "default",                  // optional Ponder session name
});

await client.health();                            // bridge alive?
await client.ensureAttached({ url: "https://example.com" });
const snap = await client.browser.snapshot();
await client.browser.click("e12");
await client.browser.type("e15", "ponder", { submit: true });

const saved = await client.recipe.save({ task: "my flow" });
const replay = await client.recipe.run(saved.id, { reground: true });
```

Every error from the bridge surfaces as a `PonderError` with the same `{ code, message, hint, docs_url }` envelope you'd see from in-process calls.

## Typed errors

```ts
import { PonderError } from "ponder";

try {
  await client.browser.click("e999");
} catch (e) {
  if (e instanceof PonderError && e.code === "REF_NOT_FOUND") {
    // refresh the snapshot
  }
}
```

Stable codes:

```
BROWSER_NOT_ATTACHED       BROWSER_TAB_MISMATCH       BROWSER_EXTENSION_MISSING
CHROME_NOT_RUNNING         REF_NOT_FOUND              GROUNDING_FAILED
RECIPE_NOT_FOUND           RECIPE_SAVE_FAILED         RECIPE_EMPTY
PROVIDER_NOT_CONFIGURED    PERMISSION_DENIED          BRIDGE_UNREACHABLE
INVALID_KEY                MISSING_AUTH               FORBIDDEN_SCOPE
RATE_LIMITED               TIMEOUT                    INTERNAL_ERROR
```

## Trace buffer

The process-wide trace buffer feeds both the per-flow `RecipeRecorder` (used by `agent_do`) and the new `ponder_recipe_save` tool.

```ts
import {
  recordAction,
  snapshotTrace,
  buildRecipeFromTrace,
  startNewTrace,
  onTraceStep,
} from "ponder";

startNewTrace({ task: "my flow" });
// ...drive some tools...
const steps = snapshotTrace();        // current buffer
const recipe = buildRecipeFromTrace({ task: "my flow" });
const unsub = onTraceStep((step) => console.log(step.executed.type));
```

Direct `recordAction` calls are how the HTTP bridge feeds external consumer activity into the same buffer.
