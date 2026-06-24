/** Click each sidebar nav item and screenshot the main pane. Run: tsx bench/click-tabs.ts */
import * as screen from "../src/screen";
import { writeFileSync } from "node:fs";

const NAV_X = 300; // logical x inside the sidebar
// vertical nav rows (logical y), anchored to window top ~65
const TABS: Array<{ name: string; y: number }> = [
  { name: "history", y: 247 },
  { name: "automations", y: 286 },
  { name: "settings", y: 780 },
];

async function shot(tag: string): Promise<void> {
  const s = await screen.screenshot();
  writeFileSync(`/tmp/v-${tag}.png`, s.png);
  console.log(`  shot v-${tag}.png`);
}

async function main(): Promise<void> {
  await screen.raiseMacApp("Electron").catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
  for (const t of TABS) {
    await screen.click(NAV_X, t.y);
    await new Promise((r) => setTimeout(r, 700));
    await shot(t.name);
  }
  await screen.click(NAV_X, 208); // restore Run
  console.log("done");
  process.exit(0);
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
