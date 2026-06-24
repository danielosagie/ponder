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
        str(p, "sku") &&
          `Expand the "More details" section, then enter the SKU into the native private "SKU" field (labeled "SKU", "Optional. Only visible to you"): ${str(p, "sku")}. The SKU is private inventory data — NEVER put it in the public Description.`,
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
      const skuLine = str(p, "sku")
        ? ` Expand "More details" and set the native private "SKU" field to ${str(p, "sku")} — never put the SKU in the public Description.`
        : "";
      return `On ${place}, open my listing ${listingRef(job)} and edit it. ${change}${skuLine} Save the changes and confirm.`;
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

/**
 * Built-in default recipe per job type. These ship with the app so a job
 * flips to deterministic replay WITHOUT an env override. The id is the
 * recipe's on-disk basename: `/recipe/run` → loadRecipe(id) reads
 * `~/.ponder/recipes/<id>.json`, so 'fb-create-listing-full' addresses
 * ~/.ponder/recipes/fb-create-listing-full.json. An env override
 * (PONDER_BROWSER_JOBS_RECIPE_<TYPE>) still wins when set.
 */
export const DEFAULT_RECIPE_IDS: Record<string, string> = {
  create_listing: "fb-create-listing-full",
};

/**
 * Recipe id mapped for this job type. Resolution order:
 *   1. env override PONDER_BROWSER_JOBS_RECIPE_<TYPE> (operator-set, wins)
 *   2. built-in DEFAULT_RECIPE_IDS for the job type
 *   3. "" → caller falls back to /extract or the vision agent_do path
 */
export function mappedRecipeId(job: BrowserJob): string {
  const type = String(job.type || "");
  const key = `PONDER_BROWSER_JOBS_RECIPE_${type.toUpperCase()}`;
  const fromEnv = String(process.env[key] || "").trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_RECIPE_IDS[type] || "";
}

/**
 * Build the {{token}} params handed to a recipe replay.
 *
 * The job payload is forwarded verbatim, so any field the recipe references
 * ({{title}}, {{price}}, {{description}}, …) substitutes directly. For a
 * create_listing job we additionally pin `sku` as a discrete top-level param:
 * the FB create form has a NATIVE (private) SKU field, and the recipe types
 * {{sku}} into it via the resolveByFieldLabel("SKU") anchor. SKU must NEVER be
 * embedded in the public {{description}} — it is carried here as its own field
 * only. The upstream backend (sssync-bknd publishFacebook) already supplies
 * `sku` as a separate payload field and keeps it out of `description`.
 */
export function recipeParamsForJob(job: BrowserJob): Record<string, unknown> {
  const p = job.payload || {};
  if (job.type === "create_listing" || job.type === "update_listing") {
    return { ...p, sku: (p as any).sku ?? "" };
  }
  return { ...p };
}

/** READ job types — these return structured data, not a side effect. They run
 *  through the coarse `/extract` path (navigate + load-all + one model pass)
 *  instead of the vision loop: faster, deterministic, and they return clean
 *  rows the backend can surface directly. WRITE jobs (create/update/delete/
 *  send_message) stay on recipe-replay or agent_do. */
const READ_TYPES = new Set(["scrape_inventory", "check_messages", "sync_listing_state"]);

export interface ExtractSpec {
  url?: string;
  columns?: string[];
  instructions?: string;
  scroll?: boolean;
  /** Fuse the AX snapshot's form-control values into the read — needed to
   *  capture <input> values (title/price/location) off an edit form. */
  deep?: boolean;
}

function urlLike(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

/** The FB Marketplace EDIT form URL for a listing id — the page that holds the
 *  full structured product data (category, condition, description, location,
 *  photos) the index/detail views omit. */
function fbEditUrl(id: string): string {
  return `https://www.facebook.com/marketplace/edit/?listing_id=${encodeURIComponent(id)}`;
}

/** Pull a numeric listing id out of a payload value or an FB item/edit url. */
function fbListingId(p: Record<string, unknown>): string {
  const direct = str(p, "listingId") || str(p, "platformListingId");
  if (direct) return direct;
  const url = str(p, "url") || str(p, "listingUrl") || str(p, "listingRef");
  const m = url.match(/(?:listing_id=|\/item\/)(\d+)/);
  return m ? m[1]! : "";
}

/**
 * For a READ job on a platform whose pages we know, return the extract spec
 * (url + columns + instructions) to run via `/extract`. Returns null when the
 * job isn't a read, or the platform/target URL is unknown — caller then falls
 * back to the vision goal so nothing regresses.
 */
export function extractSpecForJob(job: BrowserJob): ExtractSpec | null {
  if (!READ_TYPES.has(job.type)) return null;
  if (job.platform !== FB) return null; // only FB page URLs are known here
  const p = job.payload || {};
  switch (job.type) {
    case "scrape_inventory":
      return {
        url: "https://www.facebook.com/marketplace/you/selling",
        columns: ["Title", "Price", "Status", "Views", "Listed"],
        instructions:
          "Extract my Facebook Marketplace listings (one row per listing). " +
          "Include active, sold and pending items; put the state in the Status " +
          "column. Skip navigation, ads, and non-listing UI.",
        scroll: true,
      };
    case "check_messages":
      return {
        url: "https://www.facebook.com/marketplace/inbox",
        columns: ["Buyer", "LastMessage", "Time", "Unread"],
        instructions:
          "List recent Marketplace message threads: buyer name, latest message, " +
          "approximate time, and whether the thread is unread.",
        scroll: true,
      };
    case "sync_listing_state": {
      // DEEP per-listing read: open the EDIT form (full structured data) and
      // fuse input values + text. Needs a listing id (or an FB url to derive it).
      const id = fbListingId(p);
      if (id) {
        return {
          url: fbEditUrl(id),
          columns: ["Title", "Price", "Category", "Condition", "Description", "Color", "Location", "Photos", "Availability"],
          instructions:
            "This is the EDIT form for ONE Facebook Marketplace listing. Extract " +
            "every field with its CURRENT value: Title, Price, Category, Condition, " +
            "Description, Color, Location, Photos (count), Availability. Pull Title/" +
            "Price/Location from the FORM FIELD VALUES section; pull Category/" +
            "Condition/Description from the body text. For Description use the FULL " +
            "body text (not the truncated field label).",
          scroll: false,
          deep: true,
        };
      }
      // No id, but a plain url → shallow read of whatever that page shows.
      const ref = str(p, "url") || str(p, "listingUrl");
      if (!ref || !urlLike(ref)) return null; // nothing to open → vision fallback
      return {
        url: ref,
        columns: ["Title", "Price", "Status", "Views"],
        instructions: "Read this listing's current state: title, price, status, view count.",
        scroll: false,
      };
    }
    default:
      return null;
  }
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

    // 1. Operator-recorded recipe → deterministic replay (write flows).
    //    reground:false — FB CRUD recipes are pure in-Chrome (browser_* via
    //    aria-refs), which self-heal through refLabel re-resolution (a snapshot,
    //    no model). Vision re-grounding only ever helps OS-level screen steps,
    //    which these recipes don't have, so reground:true would only add
    //    provider-warm latency (~1-2s) against the 10s single-action budget.
    const recipeId = mappedRecipeId(job);
    if (recipeId) {
      const viaRecipe = await this.post(
        "/recipe/run",
        { id: recipeId, reground: false, params: recipeParamsForJob(job) },
        job,
      );
      // Recipe-as-cache: if the recipe file isn't present on this machine, the
      // bridge returns 404 RECIPE_NOT_FOUND. Don't hard-fail — degrade to the
      // vision agent path below (the agent is the always-available fallback),
      // so create/update still works on a fresh machine without the recipe.
      const recipeMissing =
        !viaRecipe.success &&
        /(^|\D)404(\D|$)|RECIPE_NOT_FOUND/i.test(String(viaRecipe.error || ""));
      if (!recipeMissing) return viaRecipe;
    }
    // 2. READ job on a known platform → coarse /extract (fast, structured).
    const spec = extractSpecForJob(job);
    if (spec) {
      return this.postExtract(spec, job);
    }
    // 3. Everything else → vision agent loop from the NL goal.
    return this.post("/agent_do", { task: goalForJob(job), decompose: true }, job);
  }

  /** POST /extract and shape the rows into a job result + a table artifact. */
  private async postExtract(
    spec: ExtractSpec,
    job: BrowserJob,
  ): Promise<BrowserJobExecutionResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.base}/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(spec),
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
        payload = {};
      }
      const headers: string[] = Array.isArray(payload?.headers) ? payload.headers : [];
      const rows: unknown[] = Array.isArray(payload?.rows) ? payload.rows : [];
      return {
        success: true,
        result: {
          status: "success",
          via: "extract",
          jobType: job.type,
          platform: job.platform,
          operation: job.operation || "read",
          outcome: "done",
          count: rows.length,
          headers,
          rows,
          updatedAt: new Date().toISOString(),
        },
        artifacts: [{ kind: "table", headers, rows }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: /abort/i.test(message)
          ? `Ponder extract timed out after ${this.timeoutMs}ms`
          : message,
      };
    } finally {
      clearTimeout(timer);
    }
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
