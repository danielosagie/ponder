/** Focused paste-retry into the already-open Google Sheet: raise Chrome →
 *  vision-click A1 (focus the grid) → OS Cmd+V → screenshot to verify.
 *  Run: tsx bench/paste-retry.ts */
import "dotenv/config";
import * as screen from "../src/screen";
import { makeProvider, computeDefaultProvider } from "../src/agent/factory";
import { writeFileSync } from "node:fs";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  await screen.raiseMacApp("Google Chrome").catch(() => {});
  await sleep(1600);

  const provider = makeProvider(computeDefaultProvider());
  await provider.warm?.().catch(() => {});
  const shot = await screen.screenshot();
  writeFileSync("/tmp/paste-before.png", shot.png);
  const g = await provider
    .ground({
      instruction:
        "cell A1 — the top-left data cell of the spreadsheet grid (just below the 'A' column header, right of the '1' row header)",
      screenshotB64: shot.png.toString("base64"),
      screen: [shot.width, shot.height],
    })
    .catch((e) => ({ error: String(e) }) as { error: string });
  if (!("error" in g) || !g.error) {
    const gg = g as { x: number; y: number };
    await screen.click(gg.x + shot.offsetX, gg.y + shot.offsetY);
    console.log(`clicked A1 at (${gg.x}, ${gg.y})`);
    await sleep(700);
  } else {
    console.log(`could not ground A1: ${(g as { error: string }).error}`);
  }

  await screen.pressCombo("cmd+v");
  await sleep(3200);

  const after = await screen.screenshot();
  writeFileSync("/tmp/paste-after.png", after.png);
  console.log("saved /tmp/paste-before.png + /tmp/paste-after.png");
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
