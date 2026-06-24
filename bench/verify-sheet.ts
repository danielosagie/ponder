/** Raise Chrome (showing the just-created Sheet tab) and screenshot it so we can
 *  visually confirm the paste landed. Run: tsx bench/verify-sheet.ts */
import * as screen from "../src/screen";
import { writeFileSync } from "node:fs";

async function main(): Promise<void> {
  await screen.raiseMacApp("Google Chrome").catch(() => {});
  await new Promise((r) => setTimeout(r, 1800));
  const shot = await screen.screenshot();
  writeFileSync("/tmp/sheet-verify.png", shot.png);
  console.log(`saved /tmp/sheet-verify.png (${shot.width}x${shot.height})`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
