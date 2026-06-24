/**
 * Live FB Marketplace: benchmark WITH Playwriter (browser_read + extract on the
 * logged-in page) vs WITHOUT (Firecrawl, no session), then DO the task —
 * extract listings → clipboard (TSV, paste into a Sheet) + CSV file.
 *
 * Drives the user's REAL logged-in Chrome via the Playwriter relay: run this,
 * then click the green Playwriter icon on the Facebook Marketplace tab.
 *
 * Run: tsx bench/fb-benchmark.ts
 */
import { config } from "dotenv";
config();
config({ path: "../sssync-bknd/.env" }); // FIRECRAWL_API_KEY
import { createPlaywriterClient } from "../src/agent/browser/playwriter";
import { extractRows } from "../src/agent/extract";
import { toTsv, writeCsvFile, copyToClipboard } from "../src/agent/export";

const FB_URL = "https://www.facebook.com/marketplace/you/selling";
const COLS = ["Item", "Current Price", "Status", "Listed On"];
const FC_KEY = process.env.FIRECRAWL_API_KEY;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function firecrawlScrape(url: string): Promise<{ markdown: string; ms: number }> {
  const t0 = Date.now();
  const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${FC_KEY}` },
    body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
  });
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error(`firecrawl ${res.status}: ${(await res.text()).slice(0, 140)}`);
  const j = (await res.json()) as { data?: { markdown?: string }; markdown?: string };
  return { markdown: j.data?.markdown ?? j.markdown ?? "", ms };
}

async function main(): Promise<void> {
  const browser = await createPlaywriterClient({ onStatus: (t) => console.log(`[browser] ${t}`) });
  console.log("\n→ Click the GREEN Playwriter icon on your Facebook Marketplace tab. Waiting up to 120s…\n");
  let page: unknown = null;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    page = await browser.rawPage?.().catch(() => null);
    if (page) break;
    await sleep(2000);
  }
  if (!page) {
    console.error("No tab attached — did you click the green Playwriter icon?");
    process.exit(1);
  }
  console.log("[browser] attached.\n");

  // Make sure we're on the listings page (logged-in session).
  let text = await browser.readText().catch(() => "");
  if (!/your listings|marketplace/i.test(text)) {
    await browser.navigate(FB_URL).catch(() => {});
    await sleep(3000);
    text = await browser.readText().catch(() => "");
  }

  // ---- Lane A: WITH Playwriter (browser_read + extract) ----
  const rA0 = Date.now();
  const pageText = await browser.readText();
  const readMs = Date.now() - rA0;
  const eA0 = Date.now();
  const A = await extractRows({ pageText, columns: COLS });
  const aExtractMs = Date.now() - eA0;

  // ---- Lane B: WITHOUT Playwriter (Firecrawl, no logged-in session) ----
  let B = { rows: 0, ms: 0, chars: 0, note: "" };
  try {
    const { markdown, ms } = await firecrawlScrape(FB_URL);
    const r = await extractRows({ pageText: markdown, columns: COLS });
    const loginWall = /log in|sign up|you must log in|create new account/i.test(markdown);
    B = { rows: r.rows.length, ms, chars: markdown.length, note: loginWall ? "LOGIN WALL (no session)" : "" };
  } catch (e) {
    B.note = (e as Error).message;
  }

  // ---- DO THE TASK with Lane A's rows → clipboard (TSV) + CSV ----
  let csvPath = "";
  if (A.rows.length) {
    copyToClipboard(toTsv({ headers: A.headers, rows: A.rows }));
    csvPath = writeCsvFile({ headers: A.headers, rows: A.rows });
  }

  // ---- report ----
  console.log("\n=== FB Marketplace: WITH vs WITHOUT Playwriter ===\n");
  console.log("lane".padEnd(26), "fetch/read".padStart(11), "extract".padStart(9), "rows".padStart(6), "  note");
  console.log(
    "WITH playwriter (browser_read)".padEnd(26),
    `${readMs}ms`.padStart(11),
    `${aExtractMs}ms`.padStart(9),
    String(A.rows.length).padStart(6),
    "  live logged-in page",
  );
  console.log(
    "WITHOUT (firecrawl)".padEnd(26),
    `${B.ms}ms`.padStart(11),
    "-".padStart(9),
    String(B.rows).padStart(6),
    `  ${B.note}`,
  );

  console.log(`\n=== Your listings (extracted via Playwriter) — ${A.rows.length} rows ===`);
  console.log([A.headers, ...A.rows].map((r) => r.join("  |  ")).join("\n"));

  if (A.rows.length) {
    console.log(`\nTASK DONE: ${A.rows.length} rows copied to clipboard as TSV — paste into a Google Sheet (click A1, Cmd+V).`);
    console.log(`           CSV also written to: ${csvPath}`);
  } else {
    console.log("\nNo rows extracted — the page text may not have loaded; scroll the listings and re-run.");
  }

  await browser.close().catch(() => {});
  process.exit(0);
}

main().catch((e) => {
  console.error("[fb-bench] fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
