/**
 * AGP liveness check — READ-ONLY. Confirms the H-company key authenticates
 * and reports remaining trajectory quota WITHOUT creating a trajectory (so it
 * burns nothing). Use this before building on the AGP thin-driver path.
 *
 * Run: tsx bench/agp-liveness.ts        (reads HAI_API_KEY from .env)
 */

import "dotenv/config";
import { AgpClient } from "../src/agent/agp/client";

async function main(): Promise<void> {
  const client = new AgpClient();
  console.log(`[agp] base = ${client.baseUrl}`);
  console.log(`[agp] key configured = ${client.configured}`);
  if (!client.configured) {
    console.error("No HAI_API_KEY / HCOMPANY_API_KEY in .env — cannot probe.");
    process.exit(1);
  }
  try {
    const quota = await client.getQuota();
    if (quota) {
      console.log(
        `[agp] quota OK → available ${quota.available}/${quota.limit} (active ${quota.active}, scope ${quota.scope})`,
      );
    } else {
      console.log("[agp] quota endpoint returned empty (auth worked, no body).");
    }
  } catch (e) {
    console.error(`[agp] quota check FAILED: ${(e as Error).message}`);
    process.exit(2);
  }
  // Best-effort: does the org expose the default Holo 3.1 agent? (Public/shared
  // agents may not appear under owner=organization — absence here is NOT fatal.)
  try {
    const agents = (await client.listAgents(1, 50, "holo-tab-holo3-1-flash-visual")) as {
      items?: Array<{ id?: string; name?: string }>;
    } | null;
    const items = agents?.items ?? [];
    console.log(`[agp] org agents matching "holo-tab-holo3-1-flash-visual": ${items.length}`);
    for (const a of items.slice(0, 5)) console.log(`        · ${a.id ?? a.name}`);
  } catch (e) {
    console.log(`[agp] agent list skipped (${(e as Error).message})`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("[agp] liveness fatal:", e);
  process.exit(1);
});
