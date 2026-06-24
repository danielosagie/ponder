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
 * FB account-safety: the friction phrases that indicate Facebook has flagged
 * the account (checkpoint, captcha, rate-limit, identity verify, restriction…).
 * Seeing any of these in a WRITE result/error trips the consumer's circuit
 * breaker — a HARD perma-block on all future writes until manual reset, so
 * every phrase here must be UNAMBIGUOUS FB friction. NOTE: "in review" /
 * "being reviewed" is NORMAL on healthy publishes and is explicitly stripped
 * before scanning (see detectFrictionPhrase).
 *
 * DELIBERATELY NOT here: generic, transient strings like "try again later" and
 * "log in again" — they show up in benign network flakiness / session blips and
 * would falsely perma-trip the breaker. Benign flakiness is still caught (and
 * self-heals) via the consumer's consecutive-write-failure counter, which only
 * needs a manual reset after N real failures in a row, not the first hiccup.
 */
export const FRICTION_PHRASES: readonly string[] = [
  // Security / checkpoint / identity (unambiguous account flags).
  // NOTE (GAP A, adversarial re-review): the haystack for the agent_do/vision
  // path embeds the bridge transcript, which echoes BOTH on-page FB text AND
  // the NL goal (built from the user's own title/description/message). Bare
  // single tokens like "suspicious" / "security check" / "checkpoint" /
  // "captcha" therefore matched BENIGN content — an item titled "Captcha
  // Solver" or "Security Check Camera", or FB's benign "Don't share suspicious
  // links" inbox banner — and HARD-perma-tripped the breaker. Two defenses:
  //   (1) frictionForWriteResult() ATTRIBUTES each detected phrase (round-3):
  //       it suppresses the phrase only when the WHOLE phrase is present in the
  //       user's own goal/payload, so user-supplied strings don't trip — WITHOUT
  //       mutating the haystack (so it can never fail open the way the old
  //       substring scrub did), and
  //   (2) the on-page-overlap phrases below are NARROWED to FB-account-specific
  //       multiword forms so a benign on-page banner can't match (and so a
  //       one-word user title can never suppress a multi-word ban phrase).
  // Keep every phrase UNAMBIGUOUS FB account friction — a match is a manual-
  // reset perma-block on all writes.
  "security checkpoint",
  "complete the checkpoint",
  "enter the captcha",
  "temporarily blocked",
  "confirm it's you",
  "confirm its you",
  "unusual activity",
  "verify your identity",
  "account has been restricted",
  "account has been disabled",
  "account is restricted",
  "account is disabled",
  "temporarily restricted",
  "suspicious activity",
  "suspicious login",
  "suspicious attempt",
  "you're temporarily restricted",
  "you are temporarily restricted",
  "you're temporarily restricted from",
  "we limit how often",
  "we've limited",
  "weve limited",
  "go to facebook to confirm",
  "complete a security check",
  "security check required",
  "please re-enter your password",
  // FB rate-limit / "too fast" friction (specific wording, not generic flakiness).
  "posting too fast",
  "posting too quickly",
  "doing that too often",
  "doing that too much",
  "you're going too fast",
  "you are going too fast",
];

/** Benign review spans removed before friction scanning — a healthy publish
 *  legitimately says "this listing is being reviewed", which must NOT match. */
const BENIGN_REVIEW_SPANS: readonly string[] = [
  "in review",
  "is being reviewed",
  "being reviewed",
  "under review",
];

/**
 * Scan free text for an FB friction phrase. Pure/stateless/unit-testable:
 * lowercases the input, strips benign review spans first so a normal
 * "being reviewed" never trips, then returns the first matching friction
 * phrase or null. The consumer calls this on combined write result + error
 * text to drive the circuit breaker.
 */
export function detectFrictionPhrase(text: string): string | null {
  if (!text) return null;
  let hay = String(text).toLowerCase();
  for (const span of BENIGN_REVIEW_SPANS) {
    hay = hay.split(span).join(" ");
  }
  for (const phrase of FRICTION_PHRASES) {
    if (hay.includes(phrase)) return phrase;
  }
  return null;
}

/**
 * GAP A (round-3 redesign) — decide whether a WRITE outcome carries a GENUINE
 * Facebook friction signal, with NO mutation of the haystack and explicit
 * phrase ATTRIBUTION. Returns the friction phrase if it came from on-page /
 * FB text, or null if it is fully accounted for by the user's own content (or
 * if there's no friction at all). A safety breaker must NEVER fail open, so
 * this is deliberately conservative about suppression.
 *
 * WHY this supersedes scrubForFrictionScan (now removed):
 *   The old scrub MUTATED the haystack by blanking out every user-field
 *   substring. That had three fatal flaws for a safety breaker:
 *     (1) FAIL-OPEN: a benign one-word title like "activity" / "account" /
 *         "limit" blanked that word out of the REAL on-page FB friction text,
 *         so a genuine "unusual activity" ban silently vanished from the
 *         haystack and the breaker never tripped.
 *     (2) FALSE-TRIP: the haystack was JSON.stringify'd (escaped quotes) while
 *         the scrub spans were raw, so a quoted user span never matched and was
 *         never removed — defeating the suppression it was meant to provide.
 *     (3) MISSED FIELDS: only title/description/message/text were scrubbed, but
 *         goalForJob interpolates category/condition/location/buyer/thread/
 *         slots and the default-type path stringifies the whole payload.
 *
 * The fix is non-mutating attribution:
 *   - Build a PLAIN-TEXT haystack (recursive string leaves of outcome.result +
 *     outcome.error, space-joined — NO JSON.stringify, so no escaped quotes to
 *     mismatch on).
 *   - phrase = detectFrictionPhrase(haystack). If null → no friction → null.
 *   - Collect the user's own strings: goalForJob(job) + every recursive string
 *     value in job.payload, each kept as a SEPARATE leaf. If ANY single leaf
 *     contains the whole phrase → it is user-originated → suppress (return null).
 *     Otherwise the phrase came from on-page/FB text → return it (real friction).
 *
 * Attribution is PER-LEAF, never on a space-joined blob: joining first would
 * fabricate a contiguous phrase across two adjacent fields (title:"account has
 * been" + condition:"restricted") that no field contained, suppressing real
 * friction and failing open. Because every FRICTION_PHRASES entry is multi-word
 * / FB-account-specific, a single shared word (a title of just "activity") can
 * NEVER suppress a multi-word phrase like "unusual activity" — one user value
 * would have to contain the entire phrase. So this CANNOT fail open the way the
 * substring scrub (or a joined blob) did.
 *
 * The only residual suppression case is rare and self-correcting: the user
 * verbatim-types a complete friction phrase (e.g. "we limit how often") AND FB
 * also displays it on the same write. That one write is suppressed, but the
 * consumer's consecutive-write-failure counter still backstops a genuine block.
 */
export function frictionForWriteResult(
  outcome: BrowserJobExecutionResult,
  job: BrowserJob,
): string | null {
  // Plain-text haystack: recursive string leaves of result + the error string.
  const haystackParts: string[] = [];
  collectStringLeaves(outcome.result, haystackParts);
  if (outcome.error) haystackParts.push(outcome.error);
  const haystack = haystackParts.join(" ");

  const phrase = detectFrictionPhrase(haystack);
  if (!phrase) return null;

  // Attribution (no mutation): does the user's own content contain the WHOLE
  // friction phrase? Build userBlob from the rendered goal + every payload
  // string value, lowercased to match detectFrictionPhrase's casing.
  const userParts: string[] = [];
  try {
    const goal = goalForJob(job);
    if (goal) userParts.push(goal);
  } catch {
    /* never let goal-building break the safety scan */
  }
  collectStringLeaves(job.payload, userParts);

  // Attribution is PER-LEAF, never on a joined blob: suppress only if a SINGLE
  // user string (the rendered goal, or one individual payload field) contains
  // the whole phrase. Joining leaves first would FABRICATE a contiguous phrase
  // across two adjacent fields — e.g. title:"account has been" +
  // condition:"restricted" space-joins to "account has been restricted" — that
  // no field actually contained, suppressing REAL on-page friction and failing
  // open. Per-leaf attribution cannot fuse fields, so a multi-word phrase must
  // genuinely appear inside one user-supplied value to be treated as
  // user-originated.
  if (userParts.some((s) => s.toLowerCase().includes(phrase))) return null;

  // Phrase is in the outcome but NOT user-originated → genuine on-page/FB
  // friction → return it so the consumer trips the breaker.
  return phrase;
}

/** Recursively collect every string leaf value from a value (objects + arrays)
 *  into `out`. Pure, depth-guarded, ignores non-string leaves. Used to build a
 *  PLAIN-TEXT haystack (no JSON escaping) for friction attribution. */
function collectStringLeaves(value: unknown, out: string[], depth = 0): void {
  if (depth > 12 || value == null) return; // cycle/runaway guard
  if (typeof value === "string") {
    if (value) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, out, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStringLeaves(v, out, depth + 1);
    }
  }
}

/** Marker substring of the executor's infra-not-FB failure (closed laptop /
 *  Ponder app not open). The consumer excludes this from the consecutive-fail
 *  count so an unreachable bridge never trips the friction breaker. */
export const BRIDGE_NOT_REACHABLE_MARKER = "Ponder bridge not reachable";

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
    case "propose_slots": {
      const who = str(p, "buyer") || str(p, "thread") || "the buyer";
      const slots =
        (Array.isArray((p as any).slots) && (p as any).slots.length
          ? ((p as any).slots as unknown[]).map((s) => String(s)).join(", ")
          : "") ||
        str(p, "times") ||
        str(p, "availability");
      const item = listingRef(job);
      const slotLine = slots
        ? `Offer these appointment time slots: ${slots}.`
        : "Offer the available appointment time slots from the details provided.";
      const msg = str(p, "message") || str(p, "text");
      return `On ${place}, open the inbox conversation with ${who} about ${item}. ${slotLine}${
        msg ? ` Include this note: "${msg}".` : ""
      } Send the proposed time slots in the conversation and confirm they were sent.`;
    }
    case "confirm_appointment": {
      const who = str(p, "buyer") || str(p, "thread") || "the buyer";
      const when = str(p, "slot") || str(p, "time") || str(p, "datetime") || str(p, "when");
      const item = listingRef(job);
      const whenLine = when ? ` for ${when}` : "";
      const msg = str(p, "message") || str(p, "text");
      return `On ${place}, open the inbox conversation with ${who} about ${item} and confirm the appointment${whenLine}.${
        msg ? ` Include this note: "${msg}".` : ""
      } Send the confirmation message and confirm it was sent.`;
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
/**
 * FB Marketplace category is selected by CLICKING a button whose label is an
 * exact FB top-level category (the recipe step is `click button name="{{category}}"`).
 * Upstream `category` can be null, an eBay/Google taxonomy PATH
 * ("Electronics > Audio > Headphones"), or a leaf with no matching FB button —
 * any of which makes the category click miss and the whole create fail (this is
 * the documented `click-category` replay failure). Coerce to a safe value: keep
 * a plausibly-exact single label, but fall back to "Miscellaneous" (a
 * guaranteed-present FB catch-all, verified in the recorded flow) for anything
 * empty, path-shaped, or sentence-length.
 *
 * SCOPE: applied ONLY to the recipe-replay param path, where an exact button
 * label is required. The vision/goalForJob path deliberately keeps the RICH
 * category (even a full path) — the model can navigate FB's category picker
 * intelligently and a path is more informative there than "Miscellaneous".
 *
 * A precise upstream→FB label map needs a one-time live capture of FB's
 * category list; until then this keeps publish unblocked rather than failing.
 */
function normalizeFbCategory(raw: unknown): string {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (!v) return "Miscellaneous";
  if (/[>/|,]/.test(v)) return "Miscellaneous"; // taxonomy path / multi-segment
  if (v.length > 40) return "Miscellaneous"; // a description, not a label
  return v;
}

export function recipeParamsForJob(job: BrowserJob): Record<string, unknown> {
  const p = job.payload || {};
  if (job.type === "create_listing") {
    // create needs a guaranteed-valid category button label
    return { ...p, sku: (p as any).sku ?? "", category: normalizeFbCategory((p as any).category) };
  }
  if (job.type === "update_listing") {
    // update must NOT default category — only set it when explicitly provided,
    // else replay would silently reset an existing listing's category.
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

/** WRITE job types — these post a human-visible, side-effecting action that FB
 *  rate-limits, so the consumer paces (jitter), caps (1h/24h velocity) and
 *  circuit-breaks them. This Set is the CANONICAL, SINGLE SOURCE OF TRUTH for
 *  WRITE vs non-write that the consumer imports.
 *
 *  DECISION (flagged): `send_message` IS counted as a WRITE even though the
 *  A/B/C design examples only listed create/update/delete — sending a message
 *  is a human-visible action FB rate-limits, so it belongs under the same
 *  account-safety guardrails. `propose_slots` and `confirm_appointment` are
 *  ALSO writes: both post a buyer-visible message/appointment into the FB
 *  Marketplace inbox conversation (the upstream Convex queue accepts them —
 *  see sssync-bknd/convex/browserJobs.ts `type` union — and the backend
 *  produces them), and FB rate-limits inbox/appointment actions, so they must
 *  be paced/capped/breaker-protected like any other write. WRITE is made
 *  EXPLICIT (not "everything not in READ_TYPES") so a future new READ type
 *  isn't accidentally throttled, and unknown/default job types (e.g.
 *  explore_session / generate_recipe / run_recipe / report_results /
 *  await_human — none of which directly post/send/change FB state here) fall
 *  through as non-write (no jitter/cap/breaker, preserving the existing fast
 *  path). */
const WRITE_TYPES = new Set([
  "create_listing",
  "update_listing",
  "delete_listing",
  "send_message",
  "propose_slots",
  "confirm_appointment",
]);

/** True iff this job mutates FB state and must go through the account-safety
 *  guardrails. Pure Set.has on String(job.type) — cannot throw. */
export function isWriteJob(job: BrowserJob): boolean {
  return WRITE_TYPES.has(String(job.type));
}

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
        error: `${BRIDGE_NOT_REACHABLE_MARKER} at ${this.base}. Open the Ponder desktop app so jobs can execute.`,
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
