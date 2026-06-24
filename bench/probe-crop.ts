/**
 * Offline probe for the native-res crop path (NEXT-WORK Item 1).
 *
 * Validates maybeCropToTargetApp geometry WITHOUT a live agent run:
 *   1. raises the target app (default Calculator),
 *   2. takes a real screen.screenshot(),
 *   3. runs the production crop,
 *   4. prints reported-vs-IHDR dims + scaleFactor at each stage,
 *   5. writes the cropped PNG to bench/results/probe-crop.png for
 *      visual inspection (the crop must show the target window's
 *      content, sharp, at native pixel density).
 *
 * Usage:  npx tsx bench/probe-crop.ts [AppName]
 */
import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as screen from "../src/screen";
import { maybeCropToTargetApp } from "../src/agent/loop";
import { pngDimensions } from "../src/agent/imageops";

const app = process.argv[2] || "Calculator";

function describe(label: string, s: screen.Screenshot): void {
  const dims = pngDimensions(s.png);
  console.log(
    `[probe] ${label}: reported ${s.width}×${s.height} @(${s.offsetX},${s.offsetY}) ` +
      `scaleFactor=${s.scaleFactor} | PNG ${dims?.width}×${dims?.height} ` +
      `(${s.png.length} bytes) | true scale ${dims ? (dims.width / s.width).toFixed(2) : "?"}`,
  );
}

(async () => {
  const shot = await screen.screenshot();
  describe("full frame", shot);

  const cropped = await maybeCropToTargetApp(shot, app);
  if (cropped === shot) {
    console.log("[probe] crop did NOT fire (see [loop] log lines above).");
    process.exit(2);
  }
  describe(`cropped to ${app}`, cropped);

  const dims = pngDimensions(cropped.png);
  const expectW = Math.round(cropped.width * cropped.scaleFactor);
  const expectH = Math.round(cropped.height * cropped.scaleFactor);
  const ok =
    dims !== null &&
    Math.abs(dims.width - expectW) <= 2 &&
    Math.abs(dims.height - expectH) <= 2;
  console.log(
    `[probe] geometry ${ok ? "OK" : "MISMATCH"}: PNG ${dims?.width}×${dims?.height} vs expected ${expectW}×${expectH} (logical ${cropped.width}×${cropped.height} × sf=${cropped.scaleFactor})`,
  );

  const out = path.join(__dirname, "results", "probe-crop.png");
  await writeFile(out, cropped.png);
  console.log(`[probe] wrote ${out} — inspect: should be the ${app} window, sharp.`);
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("[probe] FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
