/** Deterministic test: replayRecipe substitutes {{token}} params into typed
 *  text, urls, file paths, AND click targets (refLabel name → resolve by the
 *  substituted accessible name). No browser/network — a mock records calls.
 *  Run: tsx bench/recipe-params-smoke.ts */
import { replayRecipe } from "../src/cli/sdk";
import type { RecordedRecipe } from "../src/agent/recorder";

const calls = { navigate: [] as string[], type: [] as string[], files: [] as string[][], click: [] as string[] };

// A snapshot whose AX tree has the dropdown options + per-item delete buttons,
// so resolveByLabel can find the parameterized targets.
const AX = [
  '[e10] textbox "text"',
  '[e11] option "New"',
  '[e12] option "Used - Like New"',
  '[e13] option "Used - Good"',
  '[e14] option "Used - Fair"',
  '[e20] button "Delete listing Couch"',
  '[e21] button "Delete listing Lamp"',
].join("\n");

const mockBrowser = {
  async navigate(url: string) { calls.navigate.push(url); },
  async type(_ref: string, text: string) { calls.type.push(text); },
  async setInputFiles(_ref: string, paths: string[]) { calls.files.push(paths); },
  async click(ref: string) { calls.click.push(ref); },
  async snapshot() { return { url: "", title: "", ax: AX }; },
  async readText() { return ""; },
  async scrollPage() {},
  async scrollElement() {},
  async listTabs() { return []; },
  async switchTab() { return { index: 0, url: "", title: "", isCurrent: true }; },
} as unknown as Parameters<typeof replayRecipe>[1]["browser"];

const recipe: RecordedRecipe = {
  task: "create + parameterized clicks",
  startedAt: new Date().toISOString(),
  steps: [
    { t: 0, executed: { type: "browser_navigate", payload: { url: "https://x/marketplace/{{path}}" } } },
    { t: 100, executed: { type: "browser_type", payload: { ref: "e10", text: "{{title}}" } } },
    { t: 150, executed: { type: "browser_type", payload: { ref: "e10", text: "{{sku}}", fieldLabel: "SKU" } } },
    { t: 200, executed: { type: "browser_type", payload: { ref: "e10", text: "${{price}}" } } },
    { t: 300, executed: { type: "browser_set_input_files", payload: { ref: "e10", paths: ["{{photoPaths}}"] } } },
    // parameterized dropdown option (recorded against "New", reused for any condition)
    { t: 400, executed: { type: "browser_click", payload: { ref: "e99" } }, refLabel: { role: "option", name: "{{condition}}" } },
    // parameterized delete target (recorded against some other item)
    { t: 500, executed: { type: "browser_click", payload: { ref: "e98" } }, refLabel: { role: "button", name: "Delete listing {{title}}" } },
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
    params: { path: "create/item", title: "Couch", sku: "838993ae", price: 450, photoPaths: ["/a.jpg", "/b.jpg"], condition: "Used - Good" },
  });
  check("replay ok", r.ok, r.error);
  check("navigate substituted", calls.navigate[0] === "https://x/marketplace/create/item", calls.navigate[0]);
  check("title substituted", calls.type[0] === "Couch", calls.type[0]);
  // {{sku}} types the native (private) SKU value into the SKU field — NOT the
  // description. Proves the new fb-create-listing SKU step substitutes its token.
  check("sku substituted into SKU step text", calls.type[1] === "838993ae", calls.type[1]);
  check("price substituted", calls.type[2] === "$450", calls.type[2]);
  check("photoPaths expanded", JSON.stringify(calls.files[0]) === JSON.stringify(["/a.jpg", "/b.jpg"]), calls.files[0]);
  check("dropdown option resolved by {{condition}} → e13", calls.click[0] === "e13", calls.click[0]);
  check("delete target resolved by {{title}} → e20", calls.click[1] === "e20", calls.click[1]);
  console.log(`\n${fail === 0 ? "=== PASS" : "=== FAIL"} — ${8 - fail}/8 ok ===`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("FAIL:", e instanceof Error ? e.message : e); process.exit(1); });
