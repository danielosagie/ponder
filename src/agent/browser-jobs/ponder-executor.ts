/**
 * Ponder executor for browser jobs.
 *
 * Maps a Convex `browserJob` (type + platform + payload) onto a Ponder
 * action and runs it through the local Electron bridge (:7900):
 *   1. Recipe-first — if a recorded recipe is mapped for this job type
 *      (PONDER_BROWSER_JOBS_RECIPE_<TYPE>), replay it deterministically via
 *      POST /recipe/run. This is the preferred, fast, self-healing path.
 *   2. Otherwise build a natural-language goal from the documented Facebook
 *      Marketplace CRUD playbook and run it via POST /agent_do (vision).
 *
 * As FB recipes get recorded ("all-in on Ponder"), set the env mapping and
 * the same jobs flip from vision to deterministic replay with no code change.
 */

export interface BrowserJob {
  _id: string;
  userId: string;
  orgId: string;
  platform: string;
  type: string;
  payload?: Record<string, unknown>;
  workflowKey?: string;
  operation?: string;
  runtime?: string;
  queuedAt?: number;
  agentSessionId?: string;
  threadId?: string;
  pendingActionId?: string;
}

export interface BrowserJobExecutionResult {
  success: boolean;
  result?: Record<string, unknown>;
  error?: string;
  requiresHuman?: boolean;
  artifacts?: unknown[];
}

const FB = "facebook_marketplace";

function str(payload: Record<string, unknown> | undefined, key: string): string {
  return String(payload?.[key] ?? "").trim();
}

function listingRef(job: BrowserJob): string {
  const p = job.payload || {};
  return (
    str(p as any, "url") ||
    str(p as any, "listingId") ||
    str(p as any, "platformListingId") ||
    str(p as any, "title") ||
    "the listing"
  );
}

/**
 * Turn a job into a natural-language goal for the Ponder agent. These goals
 * are the NL form of holo3-agent/docs/PONDER-MARKETPLACE-CRUD.md.
 */
export function goalForJob(job: BrowserJob): string {
  const p = job.payload || {};
  const onFb = job.platform === FB;
  const place = onFb ? "Facebook Marketplace" : job.platform || "the marketplace";

  switch (job.type) {
    case "create_listing": {
      const parts = [
        `On ${place}, create a new listing.`,
        str(p, "title") && `Title: ${str(p, "title")}.`,
        str(p, "price") && `Price: ${str(p, "price")}.`,
        str(p, "category") && `Category: ${str(p, "category")}.`,
        str(p, "condition") && `Condition: ${str(p, "condition")}.`,
        str(p, "description") && `Description: ${str(p, "description")}.`,
        str(p, "location") && `Location: ${str(p, "location")}.`,
        Array.isArray((p as any).photoPaths) && (p as any).photoPaths.length
          ? `Upload these photos: ${((p as any).photoPaths as string[]).join(", ")}.`
          : "",
        "Then publish the listing and confirm it posted.",
      ].filter(Boolean);
      return parts.join(" ");
    }
    case "update_listing": {
      const changes = [
        str(p, "price") && `price to ${str(p, "price")}`,
        str(p, "title") && `title to "${str(p, "title")}"`,
        str(p, "description") && `description to "${str(p, "description")}"`,
        str(p, "category") && `category to ${str(p, "category")}`,
      ].filter(Boolean);
      const change = changes.length ? `Update ${changes.join(", ")}.` : "Apply the requested changes.";
      return `On ${place}, open my listing ${listingRef(job)} and edit it. ${change} Save the changes and confirm.`;
    }
    case "delete_listing":
      return `On ${place}, find my listing ${listingRef(job)}, then delete it (or mark it sold if delete is unavailable). Confirm it was removed.`;
    case "scrape_inventory":
      return `On ${place}, open "Your listings"/"Selling". Scroll to load every active listing, then extract them as a table with columns: Title, Price, Status, Views. Skip sold and draft items. Return the table.`;
    case "check_messages":
      return `On ${place}, open the inbox. List the recent message threads, each with the buyer name and the latest message. Return them as a list.`;
    case "send_message": {
      const msg = str(p, "message") || str(p, "text");
      const who = str(p, "buyer") || str(p, "thread") || "the buyer";
      return `On ${place}, open the conversation with ${who} and send this message: "${msg}". Confirm it sent.`;
    }
    case "sync_listing_state":
      return `On ${place}, open my listing ${listingRef(job)} and read its current state: title, price, status (active/sold/pending), and view count. Return those fields.`;
    default: {
      const goal = str(p, "goal") || str(p, "task") || job.workflowKey || "";
      return goal
        ? `On ${place}: ${goal}`
        : `On ${place}, perform a ${job.operation || job.type} operation using the provided details: ${JSON.stringify(p)}`;
    }
  }
}

/** Recipe id mapped for this job type, if the operator recorded one. */
export function mappedRecipeId(job: BrowserJob): string {
  const key = `PONDER_BROWSER_JOBS_RECIPE_${String(job.type || "").toUpperCase()}`;
  return String(process.env[key] || "").trim();
}

export interface PonderExecutorOptions {
  bridgePort: number;
  /** Timeout per job in ms (default 10 min — CRUD flows are multi-step). */
  timeoutMs?: number;
}

export class PonderExecutor {
  private readonly base: string;
  private readonly timeoutMs: number;

  constructor(opts: PonderExecutorOptions) {
    this.base = `http://127.0.0.1:${opts.bridgePort}`;
    this.timeoutMs = opts.timeoutMs ?? 600_000;
  }

  /** The Ponder Electron bridge must be running for jobs to execute. */
  async bridgeAvailable(): Promise<boolean> {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2_000);
      const res = await fetch(`${this.base}/health`, { signal: ctrl.signal });
      clearTimeout(t);
      return res.ok;
    } catch {
      return false;
    }
  }

  async execute(job: BrowserJob): Promise<BrowserJobExecutionResult> {
    if (!(await this.bridgeAvailable())) {
      return {
        success: false,
        requiresHuman: true,
        error: `Ponder bridge not reachable at ${this.base}. Open the Ponder desktop app so jobs can execute.`,
      };
    }

    const recipeId = mappedRecipeId(job);
    if (recipeId) {
      return this.post(
        "/recipe/run",
        { id: recipeId, reground: true, params: job.payload || {} },
        job,
      );
    }
    return this.post("/agent_do", { task: goalForJob(job), decompose: true }, job);
  }

  private async post(
    path: string,
    body: Record<string, unknown>,
    job: BrowserJob,
  ): Promise<BrowserJobExecutionResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text().catch(() => "");
      if (!res.ok) {
        return { success: false, error: `Ponder bridge ${res.status}: ${text.slice(0, 400)}` };
      }
      let payload: any = {};
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { raw: text };
      }
      // The bridge marks hard failures with isError/ok=false; an "exhausted"
      // outcome means the loop ran out of steps but the goal often still
      // landed — treat it as success-with-warning and let reconcile/observe
      // sort it out rather than failing (and retrying) a likely-done job.
      const isError = payload?.isError === true || payload?.ok === false;
      if (isError) {
        return {
          success: false,
          error: String(payload?.error || payload?.message || "Ponder run failed"),
          result: payload,
        };
      }
      return {
        success: true,
        result: {
          status: "success",
          via: path === "/recipe/run" ? "recipe" : "agent",
          jobType: job.type,
          platform: job.platform,
          operation: job.operation,
          outcome: payload?.outcome ?? payload?.status ?? "done",
          payload,
          updatedAt: new Date().toISOString(),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const aborted = /abort/i.test(message);
      return {
        success: false,
        error: aborted ? `Ponder run timed out after ${this.timeoutMs}ms` : message,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
