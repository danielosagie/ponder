# ponder

Computer-use agent SDK + CLI. Dispatch tasks from your backend to a shared **Ponder** desktop app running on your customer's Mac. Holo3-35B planner, hierarchical Ollama subtask manager, Convex for state, Modal / Ollama / H Company providers.

```
your server (Node)              your customer's Mac
─────────────────               ─────────────────────
PonderClient.dispatch()  ───►   Ponder.app
       │                              │
       ▼                              ▼
   Convex (you own)  ◄──── subscribes ─┘
   sessions / steps                    runs the agent loop
                                       (Holo3 → eyes → action)
```

The customer downloads **one** Ponder desktop app and grants macOS permissions **once**. Every product built on the SDK reuses that same runtime — they just point it at a different Convex deployment via a `ponder://configure?convex=…` link.

## Quick start (SDK consumer)

```bash
npm install ponder
npx ponder init
```

`ponder init` walks you through a clack flow: pick a provider (Hosted H Company key / Self-hosted on Modal / Local Ollama), set up Convex (creates a fresh deployment or links an existing one), copies the Ponder schema into your `convex/` folder, and writes a managed block in `.env` that you can later switch with `npx ponder set-provider <name>`.

```ts
import { PonderClient } from "ponder";

const client = new PonderClient({
  convexUrl: process.env.VITE_CONVEX_URL!,
});

const { sessionId } = await client.dispatch("open notes and write hello");

const unsub = client.subscribe(sessionId, (step) => {
  if (step.kind === "result") console.log("agent answer:", step.text);
});

const final = await client.getResult(sessionId);
unsub();
```

Verify the setup any time:

```bash
npx ponder doctor
```

## Quick start (Ponder.app user)

End users don't need a CLI at all. The developer who built your tool sends you a one-click link:

```
ponder://configure?convex=https://their-deployment.convex.cloud
```

Click it once. The Ponder desktop app stores the URL in `~/Library/Application Support/Ponder/config.json` and connects to that deployment on next launch.

## How dispatch works

The Convex schema is the **public protocol**. Three tables, all shipped in the package and copied into your project by `ponder init`:

- **`sessions`** — `{ prompt, provider, runtime?, status, claimedBy?, claimedAt?, targetWorkerId?, createdAt, endedAt?, error? }`. The SDK inserts a row with `status: "pending"`; a worker (Ponder.app instance) atomically claims it via `workers.claimNext` and runs it.
- **`steps`** — append-only event log: `{ kind: thought | ground | action | screenshot | error | status | result, text?, coords?, action?, screenshotId?, index, createdAt }`. The agent loop streams these as it works; the SDK's `subscribe()` and the React `usePonderSession` hook surface them live.
- **`workers`** — fleet table, one row per Ponder.app instance pointed at this deployment. Heartbeats every 15s; a Convex cron marks workers offline if heartbeat is older than 45s and releases their in-flight session back to `pending` so another worker can pick it up. Multiple Macs can point at the same deployment — claims are FIFO across the fleet.

To pin a session to a specific worker (e.g. always run customer X's tasks on customer X's Mac), pass `{ worker: "their-worker-id" }` to `dispatch`. Otherwise any idle worker drains FIFO.

There is no per-customer auth in v1 — anyone with the Convex URL can dispatch. Fine for closed beta, internal tools, and gated invite flows. Auth is on the v2 roadmap.

## Providers

Pick one. You can switch later with `npx ponder set-provider <name>`.

### Hosted (H Company API)

Recommended for getting started. Sign up at [hub.hcompany.ai](https://hub.hcompany.ai), generate an API key. Pay per token, no infrastructure.

```bash
npx ponder set-provider hosted   # prompts for HAI_API_KEY
```

### Self-hosted on Modal

Cheapest 24 GB GPU (`L4`, ~$0.80/hr), scales to zero between requests. The CLI runs `modal deploy modal_app.py` for you and parses the deployed URL.

```bash
pipx install modal
modal token new
npx ponder set-provider modal
```

### Local Ollama

Fully offline. Downloads the Holo3 GGUF (14–23 GB depending on tier) and imports it into Ollama as `holo3`.

```bash
brew install ollama
ollama serve
npx ponder set-provider local
```

## Headless serving (`ponder/server`)

For browser-only automation where there's no end-user machine in the loop — background jobs, scheduled scrapers, server-side workflows. Sessions are marked `runtime: "headless"` so item 7's desktop fleet doesn't try to claim them, but they still stream through Convex so `PonderClient.subscribe()` works for observability.

```ts
import { serveHeadless } from "ponder/server";

const result = await serveHeadless({
  task: "go to example.com and read the page title",
  convexUrl: process.env.VITE_CONVEX_URL!,
  provider: { name: "hcompany", apiKey: process.env.HAI_API_KEY! },
  // Optional — bring your own Playwright wrapper for browser actions.
  // Without one, every action throws HeadlessVisionActionError because
  // there's no screen to fall back to.
  browser: yourBrowserClient,
});

console.log(result.outcome, result.sessionId);
```

## Embedded mode (`ponder/agent`)

For advanced consumers who want to run the agent loop inside their own Node process instead of dispatching to the desktop app:

```ts
import {
  runTask,
  makeProvider,
  createNutScreenAdapter,
} from "ponder/agent";

await runTask({
  task: "open Chrome and search 'taylor swift'",
  provider: makeProvider({ name: "hcompany", apiKey: process.env.HAI_API_KEY! }),
  screen: createNutScreenAdapter(), // default; pass your own to retarget
  events: {
    onThought: (text) => console.log("think:", text),
    onAction: (a) => console.log("act:", a),
    onScreenshot: () => {},
    onResult: (text) => console.log("done:", text),
    onStatus: () => {},
    onError: (msg) => console.error("err:", msg),
    onGround: () => {},
  },
});
```

## React (`ponder/react`)

Wraps `convex/react` to give you a session-bound hook:

```tsx
import { usePonderSession } from "ponder/react";

function SessionView({ sessionId }: { sessionId: string }) {
  const { steps, status, result, cancel } = usePonderSession(sessionId);
  return (
    <>
      <p>Status: {status}</p>
      {steps.map((s) => (
        <div key={s._id}>{s.kind}: {s.text}</div>
      ))}
      {result && <pre>{result}</pre>}
      <button onClick={cancel}>Stop</button>
    </>
  );
}
```

A `ConvexProvider` from `convex/react` must be mounted above this hook.

## CLI reference

| Command | What it does |
|---|---|
| `npx ponder init` | Clack-driven setup: provider, Convex deployment, env files, schema copy |
| `npx ponder dev` | Shells out to `npx convex dev` with a status banner |
| `npx ponder doctor` | Validates `.env`, Convex reachability, provider creds, schema files |
| `npx ponder set-provider <hosted\|modal\|local>` | Switches provider, rewrites only the managed `.env` block |

## Permissions (macOS, end-user side)

The Ponder desktop app needs three macOS permissions on first launch:
1. **Accessibility** — synthetic clicks/keyboard
2. **Screen Recording** — screenshots
3. **Input Monitoring** — global ⌘E hotkey for the input pill

The app probes these and surfaces a deep-link to the right pane in System Settings if any are missing. With `cliclick` installed (`brew install cliclick`), the agent fires clicks at coordinates **without moving the user's visible cursor**.

## Security

For security reports, email **security@ponder.dev**. Please don't open public issues for vulnerabilities.

## Roadmap / non-goals (v1)

Out of scope for v1 — open issues if you need any of these and we'll prioritize:

- Customer-pairing auth (v1 is "anyone with the Convex URL can dispatch")
- Windows / Linux `ScreenAdapter` implementations
- Browser-only headless mode
- Multi-machine fleet routing (one Convex deployment maps to one desktop app)
- Hosted "Ponder Cloud" SaaS
- `ponder.config.ts` (env-only for now)

## Hacking on Ponder itself

```bash
git clone https://github.com/danielosagie/ponder
cd ponder
npm install
npm run typecheck   # strict TS on src + electron
npm run build       # tsup build of the npm package
npm run dev         # electron-vite dev (the desktop app, not the CLI)
npm run build:app   # production DMG via electron-vite
```

The repo is a single package — the SDK, the CLI, and the Electron desktop app all live here. The desktop app is built but not npm-published; consumers download the prebuilt DMG.

## License

MIT
