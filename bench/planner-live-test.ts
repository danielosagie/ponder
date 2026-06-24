/**
 * Live test of the composite planner against the real OpenRouter models
 * configured in .env. Confirms the DeepSeek text lane and Gemini vision lane
 * both return usable actions. Run: tsx bench/planner-live-test.ts
 */
import "dotenv/config";
import { plannerConfigFromEnv, createCompositeProvider } from "../src/agent/providers/planner";

const WHITE_64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAH0lEQVR42u3BMQEAAADCoPVPbQ0PoAAAAAAAAAAAAL4GQ8AAAfqEYDoAAAAASUVORK5CYII=";

async function main(): Promise<void> {
  const cfg = plannerConfigFromEnv();
  if (!cfg) {
    console.error("plannerConfigFromEnv() returned null — PONDER_PLANNER off or no key.");
    process.exit(1);
  }
  console.log(`text lane:   ${cfg.text.model} @ ${cfg.text.apiBase}`);
  console.log(`vision lane: ${cfg.vision.model} @ ${cfg.vision.apiBase}\n`);

  const executor = {
    name: "holo",
    warm: async () => {},
    plan: async () => ({ action: "DONE" }),
    ground: async () => ({ x: 0, y: 0 }),
  } as unknown as Parameters<typeof createCompositeProvider>[0];
  const comp = createCompositeProvider(executor, cfg);

  console.log("— A) DOM step (should use DeepSeek text, no image) —");
  const a = await comp.plan({
    task:
      "[CHROME ACTIVE]\n- searchbox \"Search\" [ref=e2]\n- button \"Submit\" [ref=e5]\nGoal: search for 'running shoes'.",
    history: [],
    screenshotB64: "",
    screen: [1280, 800],
  });
  console.log("   action:", a.action, "\n");

  console.log("— B) visual step (should use Gemini vision, with image) —");
  const b = await comp.plan({
    task: "The macOS Calculator app is open. Goal: press the 7 key on the keypad.",
    history: [],
    screenshotB64: WHITE_64,
    screen: [1280, 800],
  });
  console.log("   action:", b.action, "\n");

  console.log(a.action && b.action ? "✅ both lanes returned actions" : "❌ a lane returned empty");
  process.exit(a.action && b.action ? 0 : 1);
}

main().catch((e) => {
  console.error("live test error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
