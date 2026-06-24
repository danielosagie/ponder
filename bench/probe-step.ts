/**
 * Bounded live-step probe (NEXT-WORK Item 1, validation #2).
 *
 * Runs the REAL agent loop for a maximum of 2 steps against Calculator
 * and reports per-phase latency from the loop's own log lines. The
 * thing to look for in the output:
 *   - "🪟 cropped to Calculator (… scaleFactor=2, native 460×816px)"
 *   - "🧠 plan (…ms)" and "🎯 ground (…ms)" in the LOW SECONDS,
 *     not the ~10-11s full-frame Modal numbers.
 *
 * Usage:  npx tsx bench/probe-step.ts ["task text"] [maxSteps]
 *
 * Set PONDER_PROBE_DECOMPOSE=1 (with PONDER_DECOMPOSE=on) to exercise
 * the Item-2 decomposition path: one strong-model plan call, then
 * verify-advance through the steps.
 */
import * as path from "node:path";
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: path.join(__dirname, "..", ".env") });
loadDotenv({ path: path.join(__dirname, "..", ".env.local"), override: false });

async function main(): Promise<void> {
  const { runTask } = await import("../src/agent/loop");
  const { computeDefaultProvider, humanProviderLabel, makeProvider } =
    await import("../src/agent/factory");

  const task = process.argv[2] ?? "click the 7 button on the calculator";
  const maxSteps = Number(process.argv[3] ?? 2);
  const decompose = process.env.PONDER_PROBE_DECOMPOSE === "1";
  const providerName = computeDefaultProvider();
  console.log(`[probe-step] provider: ${humanProviderLabel(providerName)}`);
  const provider = makeProvider(providerName);
  const tWarm = Date.now();
  await provider.warm().catch((e) => {
    console.warn(`[probe-step] warm failed (non-fatal): ${e?.message ?? e}`);
  });
  console.log(`[probe-step] warm: ${Date.now() - tWarm}ms`);

  const t0 = Date.now();
  const outcome = await runTask({
    task,
    provider,
    flat: true,
    maxSteps,
    ...(decompose ? { decompose: true } : {}),
    browser: null,
    router: null,
    events: {
      onThought: () => {},
      onGround: () => {},
      onAction: () => {},
      onScreenshot: () => {},
      onError: (m) => console.error(`[probe-step] error: ${m}`),
      onStatus: () => {},
    },
  });
  console.log(
    `[probe-step] outcome=${outcome} total=${((Date.now() - t0) / 1000).toFixed(1)}s (maxSteps=${maxSteps}${decompose ? ", decompose" : ""})`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("[probe-step] FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
