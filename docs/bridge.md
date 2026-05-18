# HTTP Bridge

Ponder exposes a localhost HTTP bridge on `:7900` (override with `PONDER_BRIDGE_PORT`). Any process — your own CLI, anorha's dispatch worker, a Slack bot — can drive the same surface the MCP server uses.

Started automatically when you run the Electron tray app; manually-spawned MCP processes do *not* start the bridge.

## Auth model

The bridge is localhost-only AND key-gated. Every endpoint except `/version` and `/health` requires:

```
Authorization: Bearer pndr_live_<token>
```

Issue keys with the CLI:

```bash
ponder grant my-app --scopes browser:*,recipe:*
# pndr_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx     ← printed once
```

Stripe-style — the key is shown ONCE and never echoed again. Store it in your app's secrets.

| Subcommand                        | Effect                                                 |
| --------------------------------- | ------------------------------------------------------ |
| `ponder grant <name> [--scopes]`  | Mint or rotate a key.                                  |
| `ponder grants list`              | Show issued keys (truncated key suffix only).          |
| `ponder grants revoke <name>`     | Remove a key; subsequent calls return `401 INVALID_KEY`. |
| `ponder grants log [--tail N]`    | Tail the audit log.                                    |

Keys live in `~/.ponder/keys.json` (`mode 0600`). Audit log at `~/.ponder/audit.log` (JSONL).

### Scopes

```
*                       # everything (default when no --scopes passed)
browser:*               # /browser/* endpoints
recipe:*                # /recipe/* endpoints
bypass:confirmations    # magic mode (this consumer never sees prompts)
```

Wildcards match `category:*` against `category:anything`.

## Endpoints

### Anonymous (no auth)

- `GET /health` — `{ ok, provider, warmup, activeSessionId }`
- `GET /version` — `{ commit, commitShort, dirty, builtAt }`

### Authenticated — browser

- `POST /browser/attach` — body `{ url?, tabHint?, session? }` → `{ url, title }`
- `POST /browser/snapshot` — `{ url, title, ax }`
- `POST /browser/click` — body `{ ref }` → `{ ok: true }`
- `POST /browser/type` — body `{ ref, text, submit? }` → `{ ok: true }`
- `POST /browser/navigate` — body `{ url }` → `{ url, title }`
- `POST /browser/set_input_files` — body `{ ref, paths: string[] }` → `{ ok: true }`
- `POST /browser/scroll` — body `{ direction: "up" | "down", ref?, amount? }` → `{ ok: true }`
- `POST /browser/read` — body `{ ref? }` → `{ text }`

### Authenticated — recipes

- `POST /recipe/save` — body `{ task?, fromIndex? }` → `{ id, recipePath, jsonPath, steps }`
- `GET /recipe/list` — `{ recipes: [...] }`
- `GET /recipe/<id>` — full `RecordedRecipe` JSON (404 with `RECIPE_NOT_FOUND` if missing)
- `POST /recipe/run` — body `{ id, reground? }` → `{ ok, failed, durationMs, failureScreenshotPath? }`

### Legacy (kept for the MCP forwarder)

- `POST /agent_do` — body `{ task, targetApp?, maxSteps? }` → full BridgeRunResult.
- `POST /screen/screenshot`, `/screen/type`, `/screen/hotkey`, `/screen/scroll`, `/screen/click`, `/screen/drag` — OS primitives.
- `POST /window/raise`, `/window/bounds` — macOS Accessibility proxies.

These endpoints predate the auth model and are considered localhost-trusted for compatibility with the existing MCP forwarder.

## Error shape

Every failure surfaces:

```json
{
  "code": "REF_NOT_FOUND",
  "message": "Click 'e999' failed: element not found",
  "hint": "Call /browser/snapshot to get fresh refs.",
  "docs_url": "https://ponder.dev/docs/errors/ref_not_found"
}
```

HTTP status maps to the typical 4xx/5xx; the body is always JSON with a `code` from the [error code list](sdk.md#typed-errors).

## Magic mode

Some consumers want zero confirmation prompts. Two flavors:

- **Global**: `ponder serve --auto` (or env `PONDER_AUTO=1` / `PONDER_MAGIC=1`).
- **Per-consumer**: grant scope `bypass:confirmations`.

```bash
ponder grant anorha --scopes browser:*,recipe:*,bypass:confirmations
```

Magic mode does not bypass OS-level dialogs (Screen Recording / Accessibility prompts are owned by macOS) and never bypasses auth — the bearer token is still required on every request.

## A complete consumer example

```ts
import { createPonderClient } from "ponder";

const client = createPonderClient({ token: process.env.PONDER_KEY! });

await client.ensureAttached({ url: "https://example.com" });
const snap = await client.browser.snapshot();
const ref = snap.ax.match(/\[(e\d+)\] button "Sign in"/)?.[1];
if (ref) await client.browser.click(ref);

const saved = await client.recipe.save({ task: "sign in to example" });
console.log(`saved recipe: ${saved.id}`);
```
