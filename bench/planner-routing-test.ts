/**
 * Unit test for the dual-model composite planner routing (no network):
 * a DOM/a11y step → text lane (DeepSeek), no image; a visual step → vision
 * lane (Gemini), image attached. Run: tsx bench/planner-routing-test.ts
 */
import { createCompositeProvider } from "../src/agent/providers/planner";

const calls: Array<{ model: string; hasImage: boolean }> = [];

const mockFetch = (async (_url: string, opts: { body: string }) => {
  const body = JSON.parse(opts.body);
  const userMsg = body.messages[1].content;
  calls.push({ model: body.model, hasImage: Array.isArray(userMsg) });
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: "click the blue button" } }] }),
    text: async () => "",
  };
}) as unknown as typeof fetch;

const cfg = {
  text: { apiKey: "k", apiBase: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-chat" },
  vision: { apiKey: "k", apiBase: "https://openrouter.ai/api/v1", model: "google/gemini-2.5-flash" },
  fetchImpl: mockFetch,
};

const executor = {
  name: "holo",
  warm: async () => {},
  plan: async () => ({ action: "fallback" }),
  ground: async () => ({ x: 0, y: 0 }),
} as unknown as Parameters<typeof createCompositeProvider>[0];

async function main(): Promise<void> {
  const comp = createCompositeProvider(executor, cfg);
  const base = { history: [] as string[], screenshotB64: "QQ==", screen: [1280, 800] as [number, number] };

  // A: browser DOM context present + image available → TEXT lane, no image.
  await comp.plan({ task: "[CHROME ACTIVE]\n- button \"Buy\" [ref=e1]\nGoal: click buy", ...base });
  // B: native/visual surface (no DOM) + image → VISION lane, image attached.
  await comp.plan({ task: "Click the orange = key on the Calculator keypad", ...base });
  // C: no image at all (verifier withheld) → TEXT lane.
  await comp.plan({ task: "Click something", history: [], screenshotB64: "", screen: [1280, 800] });
  // D: meta verifier WITH image → VISION lane (judges rendered state).
  await comp.plan({ task: "VERIFICATION CHECK: is the form submitted?", ...base });

  const expect = [
    { label: "A DOM+img → text/no-img", model: "deepseek/deepseek-chat", hasImage: false },
    { label: "B visual+img → gemini/img", model: "google/gemini-2.5-flash", hasImage: true },
    { label: "C no-img → text", model: "deepseek/deepseek-chat", hasImage: false },
    { label: "D meta+img → gemini/img", model: "google/gemini-2.5-flash", hasImage: true },
  ];
  let pass = 0;
  for (let i = 0; i < expect.length; i++) {
    const got = calls[i]!;
    const e = expect[i]!;
    const ok = got.model === e.model && got.hasImage === e.hasImage;
    if (ok) pass++;
    console.log(`${ok ? "✅" : "❌"} ${e.label}  →  model=${got.model} image=${got.hasImage}`);
  }
  console.log(`\n${pass}/${expect.length} routing cases correct`);
  process.exit(pass === expect.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
