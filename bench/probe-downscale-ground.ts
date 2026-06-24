/** Click-free sanity: does grounding hold on a logical-downscaled full
 *  frame? Grounds the Apple menu (top-left, expected ~(15-35, 8-16))
 *  on native vs downscaled versions of the same capture. */
import * as path from "node:path";
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: path.join(__dirname, "..", ".env") });
async function main(): Promise<void> {
  const screen = await import("../src/screen");
  const { cropAndScalePng, pngDimensions } = await import("../src/agent/imageops");
  const { makeProvider, computeDefaultProvider } = await import("../src/agent/factory");
  const provider = makeProvider(computeDefaultProvider());
  await provider.warm().catch(() => {});
  const shot = await screen.screenshot();
  const dims = pngDimensions(shot.png)!;
  const down = await cropAndScalePng(shot.png, { x: 0, y: 0, w: dims.width, h: dims.height }, shot.width / dims.width);
  console.log(`native ${dims.width}x${dims.height} ${shot.png.length}b → logical ${shot.width}x${shot.height} ${down.length}b`);
  const target = "the Apple logo menu item at the far top-left corner of the menu bar";
  for (const [name, png] of [["native", shot.png], ["downscaled", down]] as const) {
    const t0 = Date.now();
    const r = await provider.ground({ instruction: target, screenshotB64: png.toString("base64"), screen: [shot.width, shot.height] });
    console.log(`${name}: (${r.x},${r.y}) in ${Date.now() - t0}ms${r.error ? ` ERROR ${r.error}` : ""}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error("FAIL:", e?.message ?? e); process.exit(1); });
