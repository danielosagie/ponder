/**
 * Smoke: the browser-jobs consumer READ path end-to-end.
 * A synthetic scrape_inventory job → PonderExecutor.execute → bridge /extract
 * → structured rows. Proves the exact code the phone-dispatched consumer runs.
 * Requires the Ponder app (bridge :7900) up + Chrome on Facebook.
 *
 * Run: tsx bench/browser-jobs-extract-smoke.ts
 */
import { PonderExecutor, extractSpecForJob, type BrowserJob } from "../src/agent/browser-jobs/ponder-executor";

async function main(): Promise<void> {
  const job: BrowserJob = {
    _id: "smoke-scrape-1",
    userId: "smoke",
    orgId: "smoke",
    platform: "facebook_marketplace",
    type: "scrape_inventory",
    payload: {},
  };

  const spec = extractSpecForJob(job);
  console.log("extractSpecForJob →", JSON.stringify(spec));
  if (!spec) throw new Error("expected an extract spec for scrape_inventory");

  const exec = new PonderExecutor({ bridgePort: 7900 });
  if (!(await exec.bridgeAvailable())) throw new Error("bridge :7900 not reachable — open the Ponder app");

  const t0 = Date.now();
  const out = await exec.execute(job);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  const rows = (out.result?.rows as unknown[]) ?? [];
  console.log(`execute() → success=${out.success} via=${out.result?.via} count=${out.result?.count} (${secs}s)`);
  console.log("first 3 rows:", JSON.stringify(rows.slice(0, 3)));
  console.log("artifacts:", JSON.stringify((out.artifacts ?? []).map((a: any) => ({ kind: a?.kind, rows: a?.rows?.length }))));

  if (!out.success) throw new Error(`execute failed: ${out.error}`);
  if (rows.length < 1) throw new Error("execute returned no rows");
  console.log(`\n=== PASS — consumer read path returned ${rows.length} rows via "${out.result?.via}" ===`);
  process.exit(0);
}
main().catch((e) => {
  console.error("FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
