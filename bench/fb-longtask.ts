/**
 * Full long_task e2e on the live logged-in Chrome: FB Marketplace listings →
 * a new Google Sheet. Exercises the whole setup — decompose → route
 * (coarse extract for the data, AGP agent for nav + sheet-create/paste) →
 * checkpoint. This is the "best way" showcase + the AGP-via-relay comparison.
 *
 * Run this, then re-click the green Playwriter icon on the FB tab.
 * Run: tsx bench/fb-longtask.ts
 */
import { config } from "dotenv";
config();
config({ path: "../sssync-bknd/.env" });
import { createPlaywriterClient } from "../src/agent/browser/playwriter";
import { AgpClient } from "../src/agent/agp/client";
import { runLongTask } from "../src/agent/orchestrator";
import { buildOrchestratorDeps } from "../src/agent/orchestrator-deps";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const GOAL =
  "Collect my Facebook Marketplace listings (item name, current price, status) and put them into a new Google Sheet";

async function main(): Promise<void> {
  const client = new AgpClient();
  const quota = await client.getQuota().catch(() => null);
  console.log(`[agp] quota=${quota ? `${quota.available}/${quota.limit}` : "?"}`);

  const browser = await createPlaywriterClient({ onStatus: (t) => console.log(`[browser] ${t}`) });
  console.log("\n→ Re-click the GREEN Playwriter icon on your Facebook Marketplace tab. Waiting up to 120s…\n");
  let page: unknown = null;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    page = await browser.rawPage?.().catch(() => null);
    if (page) break;
    await sleep(2000);
  }
  if (!page) {
    console.error("No tab attached — click the green Playwriter icon.");
    process.exit(1);
  }
  console.log("[browser] attached.\n");

  const deps = buildOrchestratorDeps({ browser, agpClient: client });
  const t0 = Date.now();
  const result = await runLongTask(
    GOAL,
    {
      ...deps,
      onProgress: (ev) =>
        console.log(
          `  [${ev.index + 1}/${ev.total}] via ${ev.via} · ${ev.subtask.description}` +
            (ev.result.note ? `\n        → ${ev.result.note}` : ""),
        ),
    },
    { budget: { maxAgentCalls: 4, deadlineMs: 300_000 } },
  );

  console.log(
    `\n=== long_task ${result.status} in ${Math.round((Date.now() - t0) / 1000)}s — ` +
      `${result.done}/${result.total} sub-tasks, ${result.agentCalls} agent call(s), ${result.rows.length} rows ===`,
  );
  if (result.reason) console.log(`stopped: ${result.reason}`);
  if (result.rows.length) {
    console.log(`headers: ${result.headers.join(" | ")}`);
    console.log(result.rows.slice(0, 20).map((r) => r.join("  |  ")).join("\n"));
  }
  console.log(`\nrunId (resume with this): ${result.runId}`);

  await browser.close().catch(() => {});
  process.exit(0);
}

main().catch((e) => {
  console.error("[fb-longtask] fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
