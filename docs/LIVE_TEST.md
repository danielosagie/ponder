# Live-test runbook (v1.1: headless + fleet)

End-to-end validation for the SDK + desktop bridge. Run these on a real Mac with a real Convex deployment.

## Prerequisites

- macOS with Accessibility + Screen Recording granted to your dev Electron build
- A Convex account (`npx convex login` once)
- One of: H Company API key, deployed Modal app, or local Ollama with Holo3
- Node 18.18+

## A. Build and link the package

```bash
cd /path/to/ponder
npm install
npm run typecheck
npm run build       # tsup → dist/
npm run build:app   # electron-vite → out/ (the desktop binary)
```

## B. Bootstrap a consumer project

```bash
mkdir /tmp/ponder-livetest && cd /tmp/ponder-livetest
npm init -y
npm install /path/to/ponder
npx ponder init     # walk through clack: pick provider, "Create new" Convex
```

After `init` completes you should see `.env` with `VITE_CONVEX_URL=…` and your provider creds, plus `convex/{schema,sessions,steps,workers,crons}.ts` copied in. Confirm:

```bash
npx ponder doctor   # all four checks should pass
```

## C. Verify schema + workers deployed

```bash
npx convex deploy   # pushes the schema. Watch for "workers" + "crons" in the deploy output.
```

Open the Convex dashboard (URL from the deploy output) → **Data** tab → confirm `sessions`, `steps`, `workers` tables exist.

## D. Fleet smoke test (no desktop yet)

This validates the SDK ↔ Convex round-trip without booting the Electron app:

```bash
VITE_CONVEX_URL=$(grep VITE_CONVEX_URL .env | cut -d= -f2) \
  node /path/to/ponder/scripts/smoke-fleet.mjs
```

Expected output ends with `PASS`. Any `✗` failure points at the broken hop. Specifically asserts:

- `claimNext` returns the session you just dispatched
- The claimed session's `_id` matches the dispatched `sessionId`
- A `result` step appended by the "worker" round-trips through `PonderClient.getResult`
- `releaseSession` flips status to `done`

## E. Claim CAS load test

Validates the atomic claim under concurrency:

```bash
VITE_CONVEX_URL=… node /path/to/ponder/scripts/fleet-loadtest.mjs --workers 5 --sessions 100
```

Expected: `PASS` with 100 unique claims, balanced distribution across workers, < 30s total.

A `FAIL` like `session X double-claimed by Y and Z` means the CAS is broken — open an issue.

## F. Live desktop bridge

Now the real thing. In one terminal:

```bash
cd /path/to/ponder
npm run dev    # boots Electron pointed at your Convex deployment
```

You should see:

```
[fleet] registered worker <UUID> on <hostname>
```

In another terminal, dispatch a task from a Node script (or REPL):

```bash
cd /tmp/ponder-livetest
node -e '
import("ponder").then(async ({PonderClient}) => {
  const c = new PonderClient({convexUrl: process.env.VITE_CONVEX_URL});
  const {sessionId} = await c.dispatch("open notes and write hello");
  console.log("dispatched", sessionId);
})
' --env-file=.env
```

**Expected within 5 seconds:**
- The Electron buddy bubble pops up with "Got it…" + a narrator intro line
- The agent loop runs the task on screen
- The buddy ends with the extractor's answer
- The Convex dashboard shows the session row with `status: done`, `claimedBy: <worker._id>`, `claimedAt: <timestamp>`

## G. Crash recovery

Kill the Electron app mid-run (Cmd+Q during a long task). The session sits in `running` with `claimedBy` set. Now:

1. Wait 45s; the cron should mark the worker `offline` and release the session back to `pending`. Check the Convex dashboard.
2. OR: relaunch `npm run dev`. `register()` should immediately release the orphan and the new boot claims it on the next 5s tick.

## H. Multi-machine

If you have two Macs pointed at the same deployment:

1. Both should appear as separate rows in the `workers` table with different `workerId`s
2. Dispatch 10 tasks rapidly via the SDK
3. Both desktops should drain the queue (FIFO, claims interleaved)
4. To pin a task to one specific desktop, dispatch with `{ worker: "<workerId>" }`

## I. Headless serving

Verify `ponder/server` independently of the desktop fleet:

```bash
node -e '
import("ponder/server").then(async ({serveHeadless}) => {
  const r = await serveHeadless({
    task: "respond with the literal string ok",
    convexUrl: process.env.VITE_CONVEX_URL,
    provider: { name: "hcompany", apiKey: process.env.HAI_API_KEY },
    // browser: yourPlaywrightWrapper,  // omitted → throws on any vision action
  });
  console.log(r);
})
' --env-file=.env
```

Without a browser, you'll see a `HeadlessVisionActionError` once the planner emits a vision verb — that's the contract working. With a browser, the loop completes and writes a session row with `runtime: "headless"` (NOT claimed by the desktop fleet).

## What "PASS" means

- D + E green → the Convex side is correct
- F green → the desktop bridge works end-to-end
- G + H green → fleet semantics hold under crashes / multi-tenant
- I green → headless mode is independent

If A–I all pass, v1.1 is locked in.
