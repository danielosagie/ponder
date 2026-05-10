import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Mark workers offline if their last heartbeat is older than 45s, and
// release any session they were holding back to "pending" so another worker
// can claim it. Runs every 30s, which gives us at most one missed heartbeat
// before failover (15s heartbeat + 30s sweep + 45s timeout = ~30s P95 detect).
crons.interval(
  "reap offline workers",
  { seconds: 30 },
  internal.workers.reapOfflineWorkers,
);

export default crons;
