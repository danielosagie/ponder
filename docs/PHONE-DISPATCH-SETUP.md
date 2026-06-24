# Phone → Desktop Ponder → Facebook Marketplace (dispatch setup)

Send a command from your phone (the Anorha app, via Sprout chat) and have your
desktop run it on Facebook Marketplace by computer use — no API, nothing you
touch by hand.

## The path (all built)

```
Anorha app (Sprout chat: "publish this to Facebook Marketplace")
  → sssync-bknd tool  dispatch_marketplace_job
  → createBrowserPendingAction → Convex `browserJobs` row (status: pending)
  → THIS desktop: `ponder consume` claims it (browserJobs:getRetryable)
  → Ponder engine runs it on FB (recipe replay if recorded, else vision agent_do)
  → completeJob / failJob → reconcile back to the agent thread (seller sees the result)
```

- Producer tool: `sssync-bknd/src/agent/runtime/agent-tool.registry.ts` → `dispatch_marketplace_job`
  (operations: `create | update | delete | read | scan_inventory`; `platform` defaults to `facebook_marketplace`).
- Desktop consumer: `holo3-agent/src/agent/browser-jobs/` + the `ponder consume` CLI command.

## 1. Configure the desktop consumer

Either set the queue coordinates directly:

```bash
export PONDER_BROWSER_JOBS_CONVEX_URL="https://<your-convex>.convex.cloud"
export PONDER_BROWSER_JOBS_USER_ID="<the seller's user id>"
```

…or let it bootstrap from the backend (it calls `GET /api/agent/browser-jobs/bootstrap`):

```bash
export PONDER_BROWSER_JOBS_SYNC_BASE_URL="https://api.sssync.app"   # your sssync-bknd
export PONDER_BROWSER_JOBS_SYNC_TOKEN="<a Supabase JWT for the seller>"
```

The sync base URL + token also enable the **reconcile** callback (so the result
shows up back in the Sprout thread). Without them, jobs still run and complete in
Convex; they just won't post back to the chat.

Optional: the engine runs through the local Ponder Electron bridge — make sure the
Ponder desktop app is open (bridge on `:7900`, override with `PONDER_BRIDGE_PORT`).

## 2. Run the consumer

```bash
ponder consume
# [browser-jobs] subscribed to browserJobs for user=… worker=holo3-ponder-… via …
```

It stays up and prints `claim … / done … / fail …` per job. Ctrl-C to stop.

## 3. Dispatch from the phone

In the Anorha app, tell Sprout: **"Publish this to Facebook Marketplace"** (or
"update the price on my FB listing…", "take my couch listing down", "scan my FB
listings"). Sprout calls `dispatch_marketplace_job`; because it leaves the app it
goes to the approval queue first — approve it, and the desktop picks it up.

## 4. Reads are automatic; record recipes for writes

**READ jobs need NO setup.** `scrape_inventory`, `check_messages`, and
`sync_listing_state` run through the built-in coarse **`/extract`** path
(navigate → load-all → one structured pass → rows). The consumer returns clean
rows + a `table` artifact deterministically — no recipe, no vision loop. This is
the proven path (e.g. scrape_inventory returns your listings as Title/Price/
Status/Views/Listed rows).

**WRITE jobs** (`create_listing` / `update_listing` / `delete_listing` /
`send_message`) default to the **vision agent** (`agent_do`) — works, but slower
and less reliable on FB's busy UI. Record once, replay forever:

```bash
# 1. Record yourself creating one listing (you must be logged into Facebook):
ponder attach --url https://www.facebook.com/marketplace/create/item
#    …drive the create flow, then save it:
ponder list                      # find the new recipe id
# 2. Point the consumer at it (job type → recipe id):
export PONDER_BROWSER_JOBS_RECIPE_CREATE_LISTING="<recipe-id>"
```

Same pattern for `PONDER_BROWSER_JOBS_RECIPE_UPDATE_LISTING` and
`PONDER_BROWSER_JOBS_RECIPE_DELETE_LISTING`. With a recipe mapped, that job type
replays deterministically (with vision re-grounding) instead of using the agent.
(`/recipe/run` is localhost-trusted, so the consumer needs no bridge key for it.)
Don't map `*_SCRAPE_INVENTORY` / read types — they use `/extract` above.

**Bulk** = the Sprout `dispatch_marketplace_job` tool accepts `productIds[]` /
`listingRefs[]` / `items[]`; it enqueues one job per item and the consumer runs
them serially (each write replays the same recipe). One approval covers the batch.

See `docs/PONDER-MARKETPLACE-CRUD.md` for the full per-operation playbook.

## 5. Verify the loop end-to-end

1. `ponder consume` running on the desktop (logged into Facebook in the browser it drives).
2. From the phone, dispatch a harmless **read**: "scan my Facebook listings."
3. Watch the consumer log: `claim … type=scrape_inventory` → `done …`.
4. Confirm the result posts back into the Sprout thread (needs the sync token).

Once read works, try `create` with a draft item.
