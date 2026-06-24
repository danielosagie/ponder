/**
 * A/B the combined /step endpoint's COORDINATES against the validated
 * /ground reference on the same frozen screenshot. /ground is the 8/8
 * ~5px baseline (bench/vision-precision.ts); if /step's coords agree
 * within ~12px, combined mode grounds soundly and the loop can use it.
 *
 * Usage: npx tsx bench/probe-step-combined.ts
 */
import * as path from "node:path";
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: path.join(__dirname, "..", ".env") });

async function main(): Promise<void> {
  const screen = await import("../src/screen");
  const { maybeCropToTargetApp } = await import("../src/agent/loop");
  const { makeProvider, computeDefaultProvider } = await import(
    "../src/agent/factory"
  );
  const provider = makeProvider(computeDefaultProvider());
  if (!provider.step) {
    console.error("provider has no step() — wrong provider?");
    process.exit(2);
  }
  await provider.warm().catch(() => {});
  const shot = await maybeCropToTargetApp(
    await screen.screenshot(),
    "Calculator",
  );
  const b64 = shot.png.toString("base64");
  const dims: [number, number] = [shot.width, shot.height];
  console.log(
    `image: ${shot.width}x${shot.height} @(${shot.offsetX},${shot.offsetY}) sf=${shot.scaleFactor}`,
  );

  const targets = [
    "the 7 button",
    "the 9 button",
    "the AC / C clear button",
    "the = equals button",
  ];
  let agree = 0;
  for (const t of targets) {
    const tStep = Date.now();
    const s = await provider.step({
      task: `click ${t} on the calculator`,
      history: [],
      screenshotB64: b64,
      screen: dims,
    });
    const stepMs = Date.now() - tStep;
    const tGround = Date.now();
    const g = await provider.ground({
      instruction: `click ${t} on the calculator`,
      screenshotB64: b64,
      screen: dims,
    });
    const groundMs = Date.now() - tGround;
    const d =
      s.x !== null && s.y !== null
        ? Math.round(Math.hypot(s.x - g.x, s.y - g.y))
        : null;
    const ok = d !== null && d <= 12;
    if (ok) agree++;
    console.log(
      `${ok ? "✓" : "✗"} ${t}: step=(${s.x},${s.y}) [${stepMs}ms, action="${s.action.slice(0, 50)}"] vs ground=(${g.x},${g.y}) [${groundMs}ms] — Δ${d ?? "n/a"}px`,
    );
  }
  // Keyboard verb must yield null coords.
  const kb = await provider.step({
    task: "press escape to close the popover",
    history: [],
    screenshotB64: b64,
    screen: dims,
  });
  const kbOk = kb.x === null && kb.y === null;
  console.log(
    `${kbOk ? "✓" : "✗"} keyboard verb: action="${kb.action.slice(0, 50)}" coords=(${kb.x},${kb.y}) — expected null`,
  );
  console.log(`${agree}/${targets.length} coordinate agreements ≤12px`);
  process.exit(agree === targets.length && kbOk ? 0 : 1);
}
main().catch((e) => {
  console.error("FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
