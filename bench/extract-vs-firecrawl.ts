/**
 * #6 A/B benchmark: browser_read vs Firecrawl, SAME extractor.
 *
 * Holds the extraction constant (src/agent/extract.ts → extractRows) and varies
 * only the page-text SOURCE:
 *   Lane A — Firecrawl /v2/scrape (server-side, bulk) → extractRows
 *   Lane B — browser_read over a live Chrome (CDP) → extractRows
 * Reports latency (scrape/read + extract) and row count per public list page.
 *
 * Reuses the anorha hosted Firecrawl key (../sssync-bknd/.env) and holo3-agent's
 * OPENROUTER key (.env). Needs a Chrome on --cdp-url (default 127.0.0.1:9224).
 *
 * Run: tsx bench/extract-vs-firecrawl.ts
 */
import { config } from "dotenv";
config(); // holo3-agent/.env → OPENROUTER_API_KEY (for extractRows)
config({ path: "../sssync-bknd/.env" }); // anorha backend → FIRECRAWL_API_KEY
import { extractRows } from "../src/agent/extract";
import { createPlaywriterClient } from "../src/agent/browser/playwriter";

const FC_KEY = process.env.FIRECRAWL_API_KEY;
const CDP = process.env.CDP_URL || "http://127.0.0.1:9224";

const TARGETS: Array<{ url: string; columns: string[] }> = [
  { url: "https://news.ycombinator.com", columns: ["Rank", "Title", "Points"] },
  {
    url: "https://en.wikipedia.org/wiki/List_of_largest_companies_in_the_United_States_by_revenue",
    columns: ["Rank", "Name", "Industry", "Revenue (USD millions)"],
  },
];

const ms = (t0: number): number => Date.now() - t0;

async function firecrawlScrape(url: string): Promise<{ markdown: string; ms: number }> {
  const t0 = Date.now();
  const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${FC_KEY}` },
    body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
  });
  const took = ms(t0);
  if (!res.ok) throw new Error(`firecrawl ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = (await res.json()) as { data?: { markdown?: string }; markdown?: string };
  return { markdown: j.data?.markdown ?? j.markdown ?? "", ms: took };
}

interface Row {
  url: string;
  lane: string;
  fetchMs: number;
  extractMs: number;
  rows: number;
  chars: number;
  note: string;
}

async function main(): Promise<void> {
  if (!FC_KEY) {
    console.error("No FIRECRAWL_API_KEY (looked in ../sssync-bknd/.env).");
    process.exit(1);
  }
  console.log(`[bench] firecrawl key fc-…${FC_KEY.slice(-4)} · cdp ${CDP}\n`);

  const browser = await createPlaywriterClient({ cdpUrl: CDP, onStatus: () => {} });
  // Wait for the CDP page to attach.
  let page: unknown = null;
  for (let i = 0; i < 15; i++) {
    page = await browser.rawPage?.().catch(() => null);
    if (page) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!page) {
    console.error(`No Chrome tab on ${CDP}. Launch one with --remote-debugging-port.`);
    process.exit(1);
  }

  const results: Row[] = [];
  for (const t of TARGETS) {
    // ---- Lane A: Firecrawl scrape → extract ----
    try {
      const { markdown, ms: fcMs } = await firecrawlScrape(t.url);
      const e0 = Date.now();
      const { rows } = await extractRows({ pageText: markdown, columns: t.columns });
      results.push({ url: t.url, lane: "firecrawl", fetchMs: fcMs, extractMs: ms(e0), rows: rows.length, chars: markdown.length, note: "" });
    } catch (e) {
      results.push({ url: t.url, lane: "firecrawl", fetchMs: 0, extractMs: 0, rows: 0, chars: 0, note: (e as Error).message });
    }

    // ---- Lane B: browser_read → extract ----
    try {
      const r0 = Date.now();
      await browser.navigate(t.url);
      await new Promise((r) => setTimeout(r, 1500)); // settle
      const text = await browser.readText();
      const rMs = ms(r0);
      const e0 = Date.now();
      const { rows } = await extractRows({ pageText: text, columns: t.columns });
      results.push({ url: t.url, lane: "browser_read", fetchMs: rMs, extractMs: ms(e0), rows: rows.length, chars: text.length, note: "" });
    } catch (e) {
      results.push({ url: t.url, lane: "browser_read", fetchMs: 0, extractMs: 0, rows: 0, chars: 0, note: (e as Error).message });
    }
  }

  await browser.close().catch(() => {});

  // ---- report ----
  console.log("\n=== browser_read vs Firecrawl (same extractor) ===\n");
  const host = (u: string): string => u.replace(/^https?:\/\//, "").split("/")[0]!;
  console.log("page".padEnd(20), "lane".padEnd(14), "fetch".padStart(8), "extract".padStart(8), "total".padStart(8), "rows".padStart(6), "chars".padStart(8));
  for (const r of results) {
    const total = r.fetchMs + r.extractMs;
    console.log(
      host(r.url).slice(0, 19).padEnd(20),
      r.lane.padEnd(14),
      `${r.fetchMs}ms`.padStart(8),
      `${r.extractMs}ms`.padStart(8),
      `${total}ms`.padStart(8),
      String(r.rows).padStart(6),
      String(r.chars).padStart(8),
      r.note ? `  ${r.note}` : "",
    );
  }
  console.log("");
  process.exit(0);
}

main().catch((e) => {
  console.error("[bench] fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
