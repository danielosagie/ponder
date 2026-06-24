/** Deterministic test: when the recorded ref is stale AND refLabel can't heal,
 *  withHealedRef falls back to LABEL-ANCHORED resolution via browser.evaluate
 *  (find the control next to the "Title" label, tag it, type into it).
 *  Run: tsx bench/recipe-fieldlabel-smoke.ts */
import { replayRecipe } from "../src/cli/sdk";
import type { RecordedRecipe } from "../src/agent/recorder";

const typed: Array<{ ref: string; text: string }> = [];
let evalCalls = 0;

const mockBrowser = {
  async navigate() {},
  async type(ref: string, text: string) {
    if (ref === "STALE") throw new Error("stale ref — element not found");
    typed.push({ ref, text });
  },
  async evaluate(_expr: string) { evalCalls++; return true; }, // simulate found + tagged
  async snapshot() { return { url: "", title: "", ax: '[e1] button "irrelevant"' }; }, // no refLabel match
  async click() {},
  async readText() { return ""; },
  async scrollPage() {},
  async listTabs() { return []; },
  async switchTab() { return { index: 0, url: "", title: "", isCurrent: true }; },
} as unknown as Parameters<typeof replayRecipe>[1]["browser"];

const recipe: RecordedRecipe = {
  task: "field-label fallback",
  startedAt: new Date().toISOString(),
  steps: [
    {
      t: 0,
      executed: { type: "browser_type", payload: { ref: "STALE", text: "{{title}}", fieldLabel: "Title" } },
      refLabel: { role: "textbox", name: "no-such-name-zzz" }, // won't heal
    },
  ],
};

let fail = 0;
const check = (n: string, ok: boolean, got?: unknown) => {
  console.log(`  ${ok ? "ok " : "FAIL"} ${n}${ok ? "" : " — got " + JSON.stringify(got)}`);
  if (!ok) fail++;
};

async function main() {
  const r = await replayRecipe(recipe, {
    browser: mockBrowser,
    stepDelayMs: 0,
    params: { title: "Walnut Couch" },
  });
  check("replay ok (recovered via field label)", r.ok, r.error);
  check("evaluate was called for label anchor", evalCalls >= 1, evalCalls);
  check("typed into the tagged control (__holo_heal)", typed[0]?.ref === "__holo_heal", typed[0]?.ref);
  check("with substituted text", typed[0]?.text === "Walnut Couch", typed[0]?.text);
  console.log(`\n${fail === 0 ? "=== PASS" : "=== FAIL"} — ${4 - fail}/4 ok ===`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("FAIL:", e instanceof Error ? e.message : e); process.exit(1); });
