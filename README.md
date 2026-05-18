# Ponder

> Drive your real Chrome and your real macOS desktop from an agent — record every flow, hand-edit it, replay it forever.

Ponder is a standalone, open-source platform for browser+desktop automation. It bundles:

- An **MCP server** any AI agent (Claude Code, Claude Desktop, claude.ai) can plug into.
- A **TypeScript SDK** that gives you `page` (real Chrome via Playwriter) plus `screen.*` (OS-level vision-grounded clicks).
- A **CLI** (`ponder`) for recording, replaying, and editing flows.
- A **localhost HTTP bridge** at `:7900` your own apps can drive — same surface as the MCP, with per-consumer auth.
- A **process-wide trace buffer**: every browser_*/screen_*/agent_do call is captured and can be snapshotted into a hand-editable recipe.

## Ponder in 60 seconds

```bash
npm i -g ponder
ponder setup                            # probes for Playwriter + walks you through the extension
ponder doctor                           # green checks across the board?
```

From any MCP-aware agent (Claude Code et al.):

```
ponder_browser_ensure({ url: "https://example.com" })  // one tool — handles every cold-start state
browser_snapshot()                                     // see the [eN] refs
browser_click("e12")                                   // click something
ponder_recipe_save({ task: "my flow" })                // freeze it as a replayable recipe
```

Replay later from the terminal:

```bash
ponder list                             # newest first
ponder run <id>                         # deterministic replay, no LLM in the loop
ponder open <id>                        # hand-edit the .recipe.ts when something breaks
```

Or from any Node program:

```ts
import { loadRecipe, replayRecipe } from "ponder";

const recipe = await loadRecipe("2026-05-12_18-30-00-search-marketplace");
await replayRecipe(recipe!, { reground: true });
```

Or from any process that can speak HTTP (anorha, custom CLI, Slack bot, whatever):

```bash
ponder grant my-app --scopes browser:*,recipe:*
# pndr_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx     ← shown once
```

```ts
import { createPonderClient } from "ponder";

const client = createPonderClient({ token: process.env.PONDER_KEY });
await client.ensureAttached({ url: "https://example.com" });
const snap = await client.browser.snapshot();
```

## What Ponder is — and isn't

Ponder is **the platform**: the recorder, the SDK, the bridge, the CLI, the MCP server. It does not ship a UI for end users (other than a tray app for permissions). It expects to be consumed by:

- An AI agent talking to the MCP server.
- A TypeScript program importing `ponder`.
- Any HTTP client talking to the bridge.

Apps that build a user-facing product *on top of* Ponder — like [anorha](https://anorha.dev) — live in their own repos and bring their own backend.

## Highlights

- **`ponder_browser_ensure`** — one MCP tool that handles every cold-start state: Chrome not running, extension missing, no green tab, wrong URL. Vision auto-attaches.
- **Process-wide trace buffer** — direct `browser_click` / `screen_type` / `agent_do` calls all land in the same recipe. Save with `ponder_recipe_save`.
- **Raw Playwright recipes** — `.recipe.ts` files use `page.getByRole(...)` directly; the `defineRecipe({ run })` shell is 30 lines you can rip out to drop the body into any Playwright project.
- **Stripe-style auth** — `ponder grant <name>` mints a `pndr_live_<random>` key. Each request goes through localhost bridge middleware that touches `lastUsedAt` and appends an audit row.
- **Typed errors** — every failure surfaces `{ code, message, hint, docs_url }`. No bare strings.

## Docs

- [`docs/recipes.md`](docs/recipes.md) — record, edit, replay.
- [`docs/sdk.md`](docs/sdk.md) — TypeScript API surface.
- [`docs/bridge.md`](docs/bridge.md) — HTTP endpoint reference + auth.

## Examples

- [`examples/record-a-flow.ts`](examples/record-a-flow.ts) — record once with `agent_do`, save.
- [`examples/replay-via-sdk.ts`](examples/replay-via-sdk.ts) — load + replay.
- [`examples/drive-via-bridge.ts`](examples/drive-via-bridge.ts) — talk to `:7900` from a separate Node process.
- [`examples/auto-attach.ts`](examples/auto-attach.ts) — `ensureAttached` then drive a Playwright `Page` directly.

## License

Apache 2.0. See [`LICENSE`](LICENSE).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Pull requests welcome — typecheck (`npm run typecheck`) must be clean before merge.
