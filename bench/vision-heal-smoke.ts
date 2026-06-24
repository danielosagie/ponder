/**
 * Smoke test for the per-step VISION SELF-HEAL tier (sdk.ts).
 *
 * "Recipe is the cache, vision is the compiler." Vision fires ONLY when every
 * deterministic resolver (recorded ref → refLabel heal → {{param}} → fieldLabel)
 * has missed; it grounds against a BROWSER screenshot, acts on the located
 * element, and PERSISTS a durable locator back into the step so the next replay
 * is deterministic again.
 *
 * Unit-testable WITHOUT live vision (mock provider.ground + mock browser):
 *   A. buildVisionIntent — intent string per step type.
 *   B. visionCoordsToCss — device-px → CSS-px scaling math + guards.
 *   C. End-to-end persist — a drifted click step that no deterministic resolver
 *      can fix gets vision-healed; step.refLabel is rewritten, ctx.dirty set,
 *      persist() fired with the mutated recipe, healed count == 1.
 *   D. End-to-end persist for a TYPE step — also writes payload.fieldLabel.
 *   E. NO-PROVIDER graceful-degrade — without a provider the step fail-stops
 *      (the existing throw), nothing is healed/persisted.
 *   F. FILE-INPUT skip — a browser_set_input_files step never invokes vision.
 *
 * NOT covered (can't be unit-tested): the live model grounding itself — whether
 * Holo actually returns the right pixel for a real drifted FB step. That needs a
 * bridge restart + a real drifted recipe (see report).
 *
 * Run: tsx bench/vision-heal-smoke.ts
 */
import {
  replayRecipe,
  buildVisionIntent,
  visionCoordsToCss,
} from "../src/cli/sdk";
import type { RecordedRecipe, RecordedStep } from "../src/agent/recorder";
import type { BrowserClient } from "../src/agent/browser/types";
import type { ProviderClient, GroundResult } from "../src/agent/types";

let failed = false;
const check = (name: string, cond: boolean): void => {
  console.log(`  ${cond ? "OK  " : "FAIL"}  ${name}`);
  if (!cond) failed = true;
};

// A snapshot whose refs DON'T match the recorded refLabel — forces healRef to
// miss so the deterministic ladder falls all the way through to vision.
const NO_MATCH_AX =
  '[e0] link "Unrelated"\n[e1] button "Nothing here"\n[e2] textbox "Other"';

/** Mock provider: returns a fixed coord; records the intent it was asked. */
function mockProvider(coord: { x: number; y: number }): {
  provider: ProviderClient;
  intents: string[];
} {
  const intents: string[] = [];
  const provider = {
    name: "hcompany",
    async warm() {
      return { ready: true };
    },
    async plan() {
      return { action: "" };
    },
    async ground(args: { instruction: string }): Promise<GroundResult> {
      intents.push(args.instruction);
      return { x: coord.x, y: coord.y };
    },
  } as unknown as ProviderClient;
  return { provider, intents };
}

/** Mock browser whose recorded refs all throw (stale), snapshot never matches,
 *  but screenshot + evaluate(tagScript) succeed so vision-heal can land. */
function mockBrowser(opts: {
  tagResult: { ok: boolean; role?: string; name?: string; fieldText?: string };
  imgW?: number;
  imgH?: number;
  innerW?: number;
}): { browser: BrowserClient; ran: string[]; evals: string[] } {
  const ran: string[] = [];
  const evals: string[] = [];
  const imgW = opts.imgW ?? 2560; // device px (Retina 2×)
  const imgH = opts.imgH ?? 1440;
  const innerW = opts.innerW ?? 1280; // CSS px
  const browser = {
    async snapshot() {
      return { ax: NO_MATCH_AX, url: "https://fb.example/edit", title: "Edit" };
    },
    async click(ref: string) {
      // Recorded/heal refs (eN) are stale → throw; the vision-tagged ref works.
      if (ref.startsWith("__holo_vision")) {
        ran.push(`click:${ref}`);
        return;
      }
      throw new Error(`locator.click: Timeout (stale ${ref})`);
    },
    async type(ref: string) {
      if (ref.startsWith("__holo_vision")) {
        ran.push(`type:${ref}`);
        return;
      }
      throw new Error(`locator.fill: Timeout (stale ${ref})`);
    },
    async setInputFiles() {
      throw new Error("setInputFiles should NOT be reached for file-input skip");
    },
    async screenshot() {
      return { pngB64: "AAAA", width: imgW, height: imgH };
    },
    async evaluate(expr: string) {
      evals.push(expr);
      if (/window\.innerWidth/.test(expr)) return innerW;
      // The tag script (elementFromPoint + roleOf/nameOf) — return the mock.
      if (/elementFromPoint/.test(expr)) return opts.tagResult;
      return null;
    },
  } as unknown as BrowserClient;
  return { browser, ran, evals };
}

function clickStep(): RecordedStep {
  return {
    t: 0,
    intent: "click the Category dropdown",
    executed: { type: "browser_click", payload: { ref: "e5" } },
    refLabel: { role: "button", name: "Category" }, // won't match NO_MATCH_AX
    url: "https://fb.example/edit",
  };
}

function typeStep(): RecordedStep {
  return {
    t: 0,
    intent: "type the title",
    executed: { type: "browser_type", payload: { ref: "e7", text: "My Item" } },
    refLabel: { role: "textbox", name: "Title" },
    url: "https://fb.example/edit",
  };
}

async function testA(): Promise<void> {
  console.log("A. buildVisionIntent (intent string per step type)");
  check(
    "click step → '...the Category button'",
    buildVisionIntent(clickStep()) === "the Category button",
  );
  check(
    "type step → '...the Title input field'",
    buildVisionIntent(typeStep()) === "the Title input field",
  );
  const combo: RecordedStep = {
    t: 0,
    executed: { type: "browser_click", payload: { ref: "e1" } },
    refLabel: { role: "combobox", name: "Condition" },
  };
  check(
    "combobox click → '...the Condition combobox'",
    buildVisionIntent(combo) === "the Condition combobox",
  );
  const param: RecordedStep = {
    t: 0,
    executed: { type: "browser_click", payload: { ref: "e1" } },
    refLabel: { role: "option", name: "{{condition}}" },
  };
  check(
    "parameterized click w/ nameOverride substitutes the run value",
    buildVisionIntent(param, { condition: "Used - Good" }, "Used - Good") ===
      "the Used - Good option",
  );
  const typeFieldLabel: RecordedStep = {
    t: 0,
    executed: { type: "browser_type", payload: { ref: "e2", fieldLabel: "Price" } },
  };
  check(
    "type w/ fieldLabel only → '...the Price input field'",
    buildVisionIntent(typeFieldLabel) === "the Price input field",
  );
}

async function testB(): Promise<void> {
  console.log("\nB. visionCoordsToCss (device-px → CSS-px scaling + guards)");
  // Retina 2×: img 2560 wide, innerWidth 1280 → scale 2 → halve coords.
  const r1 = visionCoordsToCss(1000, 600, 2560, 1280);
  check("Retina 2× halves coords (1000,600 → 500,300)", r1?.cssX === 500 && r1?.cssY === 300);
  // 1× display: img 1280 wide, innerWidth 1280 → scale 1 → identity.
  const r2 = visionCoordsToCss(400, 250, 1280, 1280);
  check("1× display is identity (400,250 → 400,250)", r2?.cssX === 400 && r2?.cssY === 250);
  check("zero imgW → null (no clicking at 0,0)", visionCoordsToCss(10, 10, 0, 1280) === null);
  check("zero innerW → null", visionCoordsToCss(10, 10, 2560, 0) === null);
  check("NaN coord → null", visionCoordsToCss(NaN, 10, 2560, 1280) === null);
}

async function testC(): Promise<void> {
  console.log("\nC. end-to-end vision-heal + persist (CLICK step)");
  const recipe: RecordedRecipe = {
    task: "click category",
    startedAt: "2026-06-23T00:00:00.000Z",
    steps: [clickStep()],
  };
  const { provider, intents } = mockProvider({ x: 1000, y: 600 });
  const { browser, ran, evals } = mockBrowser({
    tagResult: { ok: true, role: "button", name: "Category & subcategory", fieldText: "" },
  });
  let persisted: RecordedRecipe | null = null;
  const res = await replayRecipe(recipe, {
    browser,
    provider,
    persist: async (r) => {
      persisted = r;
    },
  });
  console.log(
    `   ok=${res.ok} failed=${res.failed} healed=${res.healed} ran=${JSON.stringify(ran)} intent=${JSON.stringify(intents)}`,
  );
  check("step succeeded (ok=1, failed=0)", res.ok === 1 && res.failed === 0);
  check("grounded the right intent", intents[0] === "the Category button");
  check("acted on the vision-tagged ref", ran.length === 1 && ran[0]!.includes("__holo_vision"));
  check("scaled coords before elementFromPoint (innerWidth read)", evals.some((e) => /window\.innerWidth/.test(e)));
  check("reported 1 heal", res.healed === 1);
  check(
    "persisted durable refLabel (Category → Category & subcategory)",
    recipe.steps[0]!.refLabel?.role === "button" &&
      recipe.steps[0]!.refLabel?.name === "Category & subcategory",
  );
  check("persist() fired with the mutated recipe", persisted === recipe);
}

async function testD(): Promise<void> {
  console.log("\nD. end-to-end vision-heal + persist (TYPE step → fieldLabel)");
  const recipe: RecordedRecipe = {
    task: "type title",
    startedAt: "2026-06-23T00:00:00.000Z",
    steps: [typeStep()],
  };
  const { provider } = mockProvider({ x: 800, y: 400 });
  const { browser, ran } = mockBrowser({
    tagResult: { ok: true, role: "textbox", name: "", fieldText: "Title" },
  });
  let persisted: RecordedRecipe | null = null;
  const res = await replayRecipe(recipe, {
    browser,
    provider,
    persist: async (r) => {
      persisted = r;
    },
  });
  check("type step succeeded", res.ok === 1 && res.failed === 0);
  check("acted on vision-tagged ref via type()", ran.length === 1 && ran[0]! === "type:__holo_vision");
  check(
    "persisted payload.fieldLabel = 'Title' (durable anchor)",
    (recipe.steps[0]!.executed.payload as Record<string, unknown>).fieldLabel === "Title",
  );
  check("persist fired", persisted === recipe);
}

async function testE(): Promise<void> {
  console.log("\nE. NO PROVIDER → graceful fail-stop (no heal, no persist)");
  const recipe: RecordedRecipe = {
    task: "click category",
    startedAt: "2026-06-23T00:00:00.000Z",
    steps: [clickStep()],
  };
  const { browser } = mockBrowser({
    tagResult: { ok: true, role: "button", name: "Category" },
  });
  let persisted = false;
  const res = await replayRecipe(recipe, {
    browser,
    provider: null, // <- no provider: vision tier must early-return
    persist: async () => {
      persisted = true;
    },
  });
  check("step fail-stopped (ok=0, failed=1)", res.ok === 0 && res.failed === 1);
  check("nothing healed", res.healed === 0);
  check("persist NOT fired (no dirty)", persisted === false);
}

async function testF(): Promise<void> {
  console.log("\nF. FILE-INPUT step SKIPS vision (native picker can't be driven)");
  const recipe: RecordedRecipe = {
    task: "upload photo",
    startedAt: "2026-06-23T00:00:00.000Z",
    steps: [
      {
        t: 0,
        intent: "upload the photo",
        executed: { type: "browser_set_input_files", payload: { ref: "e9", paths: ["/tmp/a.png"] } },
        refLabel: { role: "file-input", name: "file" },
      },
    ],
  };
  const { provider, intents } = mockProvider({ x: 100, y: 100 });
  // setInputFiles throws (stale) → heal/fieldLabel miss → vision MUST be skipped.
  const { browser } = mockBrowser({ tagResult: { ok: true, role: "button", name: "x" } });
  const res = await replayRecipe(recipe, { browser, provider, persist: async () => {} });
  check("file-input step fail-stopped (ok=0, failed=1)", res.ok === 0 && res.failed === 1);
  check("vision was NEVER grounded for the file-input", intents.length === 0);
}

async function main(): Promise<void> {
  await testA();
  await testB();
  await testC();
  await testD();
  await testE();
  await testF();
  console.log(failed ? "\nVISION-HEAL SMOKE: FAILED" : "\nVISION-HEAL SMOKE: ALL OK");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("[vision-heal] error:", e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
