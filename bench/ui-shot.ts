/** Raise the Anorha (Electron dev) window and screenshot it. Run: tsx bench/ui-shot.ts */
import * as screen from "../src/screen";
import { writeFileSync } from "node:fs";

async function main(): Promise<void> {
  await screen.raiseMacApp("Electron").catch(() => {});
  await new Promise((r) => setTimeout(r, 1800));
  const shot = await screen.screenshot();
  writeFileSync("/tmp/ui-shot.png", shot.png);
  console.log(`saved /tmp/ui-shot.png (${shot.width}x${shot.height})`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
