/**
 * ZERO-TOUCH FB run: the agent vision-clicks the Playwriter icon itself
 * (no debug port, no human gesture), then extracts your listings →
 * clipboard (TSV) + CSV.
 *
 * Run: tsx bench/fb-autoattach.ts
 */
import { config } from "dotenv";
config();
config({ path: "../sssync-bknd/.env" });
import { createPlaywriterClient } from "../src/agent/browser/playwriter";
import { autoAttachPlaywriter } from "../src/agent/auto-attach";
import { scrollToLoadAll } from "../src/agent/scroll-load";
import { extractRows } from "../src/agent/extract";
import { toTsv, writeCsvFile, copyToClipboard } from "../src/agent/export";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const FB_URL = "https://www.facebook.com/marketplace/you/selling";

async function main(): Promise<void> {
  const browser = await createPlaywriterClient({ onStatus: (t) => console.log(`[browser] ${t}`) });

  console.log("\n[auto-attach] agent is vision-clicking the Playwriter icon — NO user action…");
  const t0 = Date.now();
  const res = await autoAttachPlaywriter(browser);
  console.log(`[auto-attach] ${res.attached ? "ATTACHED" : "FAILED"} in ${Math.round((Date.now() - t0) / 1000)}s — ${res.note}`);
  if (!res.attached) {
    console.error("Zero-touch attach did not connect. (Icon may be in the overflow menu — pin it, or use the content-script extension path.)");
    await browser.close().catch(() => {});
    process.exit(2);
  }

  // Open the agent's OWN tab at the listings page — do NOT clobber the user's
  // tabs (the borrow-the-active-tab bug from the last run).
  await browser.newTab?.(FB_URL).catch(() => {});
  await sleep(3500);
  await scrollToLoadAll(browser); // FB lazy-loads listings on scroll → load them all
  const text = await browser.readText().catch(() => "");

  const { headers, rows } = await extractRows({ pageText: text, columns: ["Item", "Current Price", "Status"] });
  console.log(`\n=== Extracted ${rows.length} listings (zero touch) ===`);
  console.log([headers, ...rows].map((r) => r.join("  |  ")).join("\n"));

  if (rows.length) {
    copyToClipboard(toTsv({ headers, rows }));
    const csv = writeCsvFile({ headers, rows });
    console.log(`\nDONE — ${rows.length} rows on the clipboard (paste into a Sheet, A1) + CSV: ${csv}`);
  }

  await browser.close().catch(() => {});
  process.exit(0);
}

main().catch((e) => {
  console.error("[fb-autoattach] fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
