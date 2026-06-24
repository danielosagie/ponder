/** Click-delivery probe: does a cliclick CGEvent actually register on
 *  Calculator? Window-capture before/after a click on "4" and compare. */
import * as path from "node:path";
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: path.join(__dirname, "..", ".env") });
async function main(): Promise<void> {
  const screen = await import("../src/screen");
  const { writeFile } = await import("node:fs/promises");
  await screen.raiseMacApp("Calculator");
  await screen.sleep(400);
  const before = await screen.captureWindowDirect("Calculator");
  if (!before) { console.log("no window"); process.exit(2); }
  console.log(`window @(${before.offsetX},${before.offsetY}) ${before.width}x${before.height} occluders=[${before.occluders.join("; ")}]`);
  // "4" button: local (33,265) for the 230x408 window layout
  const x = before.offsetX + 33, y = before.offsetY + 265;
  console.log(`clicking (${x},${y}) via screen.click (cliclick background path)`);
  await screen.click(x, y, {});
  await screen.sleep(700);
  const after = await screen.captureWindowDirect("Calculator");
  if (!after) { console.log("no window after"); process.exit(2); }
  const changed = !before.png.equals(after.png);
  await writeFile(path.join(__dirname, "results", "delivery-before.png"), before.png);
  await writeFile(path.join(__dirname, "results", "delivery-after.png"), after.png);
  console.log(`screen changed after click: ${changed ? "YES — click registered" : "NO — click did NOT register"}`);
  process.exit(changed ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
