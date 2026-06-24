/**
 * Smoke test for src/agent/extract.ts — the read half of a data task.
 * Feeds the REAL Facebook Marketplace text (from the original failure log)
 * through extractRows and checks it returns clean structured rows.
 * Makes one real OpenRouter call (uses OPENROUTER_API_KEY from .env).
 *
 * Run: tsx bench/extract-smoke.ts
 */
import "dotenv/config";
import { extractRows } from "../src/agent/extract";
import { toTsv } from "../src/agent/export";

// Verbatim-ish slice of what browser_read returned on the marketplace page.
const PAGE = `Your listings

Pokémon Bulbasaur Mega Evolution Card #133
$30
SoldListed on 5/6
Listed on Marketplace
0 clicks on listing

1998 Honda CR-V · EX Sport Utility 4D
$2,500$4,000
SoldListed on 10/11/2025
Listed on Marketplace

Osmo Pocket 3 Creator Combo
$700
SoldListed on 10/6/2025

General Electric Commercial Freezer
$300$350
SoldListed on 4/14/2025

Single-Sided Gondola Shelving (Whole Set)
$20$300
SoldListed on 3/25/2025

24X36 Swinging Chalkboard Granite Legs
$50$700
ActiveListed on 3/26/2025

2 for 1 - One-Sided Store Fixtures 4ft x 6ft
$500$1,000
SoldListed on 3/11/2025`;

async function main(): Promise<void> {
  const t0 = Date.now();
  const { headers, rows } = await extractRows({
    pageText: PAGE,
    columns: ["Item", "Current Price", "Status"],
  });
  const ms = Date.now() - t0;

  console.log(`[extract] ${ms}ms → ${rows.length} rows, headers: ${JSON.stringify(headers)}\n`);
  console.log(toTsv({ headers, rows }));

  let failed = false;
  const check = (name: string, cond: boolean): void => {
    console.log(`  ${cond ? "OK " : "FAIL"}  ${name}`);
    if (!cond) failed = true;
  };
  check("got >= 6 rows", rows.length >= 6);
  check("3 columns", headers.length === 3);
  check("every row has 3 cells", rows.every((r) => r.length === 3));
  const flat = rows.flat().join(" | ");
  check("found the Honda listing", /Honda CR-V/i.test(flat));
  check("kept the $2,500 price", /2,?500/.test(flat));
  check("captured Active vs Sold status", /active/i.test(flat) && /sold/i.test(flat));
  // No fabrication: the model must not invent items not on the page.
  check("no fabricated rows (<= 8)", rows.length <= 8);

  console.log(failed ? "\nEXTRACT SMOKE: FAILED" : "\nEXTRACT SMOKE: ALL OK");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("[extract] error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
