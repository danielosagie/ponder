/**
 * Smoke test for self-healing recipe write-back (sdk.ts).
 * Simulates a platform RENAMING a button ("Submit" → "Submit order") on a
 * reloaded page (refs renumbered too) and verifies replay:
 *   1. heals the stale ref via the refLabel (tier-3 contains match),
 *   2. clicks the right element,
 *   3. rewrites the step's refLabel to the new name,
 *   4. calls persist() with the mutated recipe (so it self-heals on disk).
 *
 * Run: tsx bench/heal-smoke.ts
 */
import { replayRecipe } from "../src/cli/sdk";
import type { RecordedRecipe } from "../src/agent/recorder";
import type { BrowserClient } from "../src/agent/browser/types";

const recipe: RecordedRecipe = {
  task: "click submit",
  startedAt: "2026-06-21T00:00:00.000Z",
  steps: [
    {
      t: 0,
      intent: "click the Submit button",
      executed: { type: "browser_click", payload: { ref: "e5" } }, // stale ref
      refLabel: { role: "button", name: "Submit" }, // recorded name (now drifted)
      url: "https://shop.example/checkout",
    },
  ],
};

// Reloaded page: refs renumbered, and "Submit" is now "Submit order".
const AX = '[e0] link "Home"\n[e1] button "Submit order"\n[e2] textbox "Email"';
let clickedRef: string | null = null;
const browser = {
  async snapshot() {
    return { ax: AX, url: "https://shop.example/checkout" };
  },
  async click(ref: string) {
    if (ref === "e5") throw new Error("locator.click: Timeout (stale ref e5)");
    clickedRef = ref;
  },
} as unknown as BrowserClient;

async function main(): Promise<void> {
  let persisted: RecordedRecipe | null = null;
  const res = await replayRecipe(recipe, {
    browser,
    persist: async (r) => {
      persisted = r;
    },
  });

  console.log(
    `[heal] ok=${res.ok} failed=${res.failed} healed=${res.healed} clicked=${clickedRef}`,
  );
  console.log(`[heal] step.refLabel now: ${JSON.stringify(recipe.steps[0]!.refLabel)}\n`);

  let failed = false;
  const check = (name: string, cond: boolean): void => {
    console.log(`  ${cond ? "OK " : "FAIL"}  ${name}`);
    if (!cond) failed = true;
  };
  check("step succeeded (ok=1, failed=0)", res.ok === 1 && res.failed === 0);
  check("clicked the healed ref e1, not stale e5", clickedRef === "e1");
  check("reported 1 heal", res.healed === 1);
  check("refLabel drifted Submit → Submit order", recipe.steps[0]!.refLabel?.name === "Submit order");
  check("persist fired with the mutated recipe", persisted === recipe);

  console.log(failed ? "\nHEAL SMOKE: FAILED" : "\nHEAL SMOKE: ALL OK");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("[heal] error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
