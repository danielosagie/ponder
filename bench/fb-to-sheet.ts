/**
 * FULL zero-touch e2e (TIMED): Facebook Marketplace → a new Google Sheet.
 *   attach (agent vision-clicks Playwriter) → extract (own tab, scroll-load,
 *   chunked) → open new Sheet → click A1 + OS Cmd+V → screenshot-verify.
 * Reports per-phase timing + total. Run: tsx bench/fb-to-sheet.ts
 */
import { config } from "dotenv";
config();
config({ path: "../sssync-bknd/.env" });
import { createPlaywriterClient } from "../src/agent/browser/playwriter";
import { autoAttachPlaywriter } from "../src/agent/auto-attach";
import { scrollToLoadAll } from "../src/agent/scroll-load";
import { extractRows } from "../src/agent/extract";
import { toTsv, writeCsvFile, copyToClipboard } from "../src/agent/export";
import { makeProvider, computeDefaultProvider } from "../src/agent/factory";
import * as screen from "../src/screen";
import { writeFileSync } from "node:fs";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const FB_URL = "https://www.facebook.com/marketplace/you/selling";
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

async function pageUrl(browser: { rawPage?(): Promise<unknown> }): Promise<string> {
  try {
    const p = (await browser.rawPage?.()) as { url?: () => string } | null;
    return p?.url?.() ?? "";
  } catch {
    return "";
  }
}

async function main(): Promise<void> {
  const T0 = Date.now();
  const t: Record<string, number> = {};
  const browser = await createPlaywriterClient({ onStatus: (s) => console.log(`[browser] ${s}`) });

  // 1. attach (zero-touch vision click)
  let m = Date.now();
  const at = await autoAttachPlaywriter(browser);
  if (!at.attached) {
    console.error(`auto-attach failed: ${at.note}`);
    process.exit(1);
  }
  t.attach = Date.now() - m;

  // 2. extract (own tab → scroll-load-all → chunked extract → clipboard + CSV)
  m = Date.now();
  await browser.newTab?.(FB_URL).catch(() => {});
  await sleep(3500);
  await scrollToLoadAll(browser);
  const text = await browser.readText();
  const { headers, rows } = await extractRows({
    pageText: text,
    columns: ["Item", "Current Price", "Status", "Listed On"],
  });
  if (!rows.length) {
    console.error("No listings extracted — aborting.");
    process.exit(1);
  }
  copyToClipboard(toTsv({ headers, rows }));
  const csv = writeCsvFile({ headers, rows });
  t.extract = Date.now() - m;

  // 3. open a new Google Sheet
  m = Date.now();
  await browser.newTab?.("https://sheets.new").catch(() => {});
  await sleep(900);
  try {
    const p = (await browser.rawPage?.()) as { bringToFront?: () => Promise<void> } | null;
    await p?.bringToFront?.();
  } catch {
    /* ignore */
  }
  await screen.raiseMacApp("Google Chrome").catch(() => {});
  await sleep(6500);
  const sheetUrl = await pageUrl(browser);
  t.sheet = Date.now() - m;

  // 4. click A1 + OS Cmd+V
  m = Date.now();
  try {
    const provider = makeProvider(computeDefaultProvider());
    await provider.warm?.().catch(() => {});
    const shot = await screen.screenshot();
    const g = (await provider
      .ground({
        instruction: "cell A1 — the top-left data cell of the spreadsheet grid",
        screenshotB64: shot.png.toString("base64"),
        screen: [shot.width, shot.height],
      })
      .catch(() => null)) as { x: number; y: number; error?: string } | null;
    if (g && !g.error) {
      await screen.click(g.x + shot.offsetX, g.y + shot.offsetY);
      await sleep(700);
    }
  } catch {
    /* blind paste fallback */
  }
  await screen.pressCombo("cmd+v");
  await sleep(3000);
  t.paste = Date.now() - m;

  // 5. verify screenshot
  const v = await screen.screenshot();
  writeFileSync("/tmp/fb-sheet-final.png", v.png);
  const total = Date.now() - T0;

  console.log(`\n=== ${rows.length} listings · TOTAL ${secs(total)} ===`);
  console.log(
    `  attach ${secs(t.attach!)}  ·  extract ${secs(t.extract!)}  ·  open sheet ${secs(t.sheet!)}  ·  paste ${secs(t.paste!)}`,
  );
  console.log(`  sheet: ${sheetUrl || "(new tab)"}`);
  console.log(`  clipboard + CSV: ${csv}`);
  console.log(`  verify: /tmp/fb-sheet-final.png`);
  await browser.close().catch(() => {});
  process.exit(0);
}

main().catch((e) => {
  console.error("[fb-to-sheet] fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
