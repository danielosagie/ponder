# `os_*` — OS-level a11y-grounded tooling (prototype)

A comparison prototype for the "OS-level Playwright" idea: mirror the
`browser_*` tool shape (`browser_snapshot` → `browser_click({ ref })`)
for native windows, so the agent can pick refs out of an accessibility
tree instead of paying a vision-grounding round-trip per click.

**Status:** Commit 2 of a multi-step plan
(`/root/.claude/plans/i-ve-been-thinking-one-sorted-babbage.md`).
macOS provider routes through the Electron bridge via a native node
addon (`native/mac-ax/`). Windows + benchmark land later.

## Architecture

```
src/agent/os/
  types.ts              OsClient, OsSnapshot, OsElement, OsSelector
  refs.ts               eN → AX handle map (reset on every snapshot)
  snapshot.ts           Vimium-style serializer (matches BrowserSnapshot.ax)
  client.ts             pickOsClient() factory, lazy mac import
  providers/
    null.ts             unsupported-platform fallback
    mac.ts              routes through Electron bridge (POST /os/snapshot)

native/mac-ax/          # N-API addon loaded by electron/main.ts
  binding.gyp           # node-gyp config with framework links
  src/ax_bridge.mm      # AXUIElement walker (dump | perform | set-value | resolve)
  index.js / index.d.ts # CJS loader + types
```

Mirrors `src/agent/browser/` shape. `OsSnapshot { app, window, ax }`
parallels `BrowserSnapshot { url, title, ax }`. The TS provider is a
thin client over the bridge — no spawned child processes, no separate
perms grants.

## Why through the Electron bridge?

macOS Accessibility permission is granted per-bundle-ID. The Holo3
Electron app already has it (the user ticked the checkbox once for
`/screen/screenshot`, `/screen/click`, `/window/bounds`). The tsx-
hosted MCP child does not. By loading the native addon inside Electron
and exposing `/os/snapshot` on the existing bridge, all AX calls run
in the Electron process and "inherit" its perms — no second prompt,
no sidecar binary to sign.

This is the same pattern `tryBridgeScreenCall` already uses for the
other screen primitives (see `src/screen.ts:139–147` and
`src/mcp/tools.ts:331`).

## Setup on macOS

```sh
# 1. Install deps (the native addon's gyp install hook may fail on first
#    run because Electron's ABI isn't matched yet — that's expected).
npm install

# 2. Build the addon against Electron's ABI.
npm run build:native

# 3. Start the app so the bridge is alive.
npm run dev
```

Then grant Accessibility permission to the Holo3 app (System Settings
→ Privacy & Security → Accessibility). Same checkbox the screen tools
already need.

## Enabling the tools

The MCP tools (`os_snapshot`, `os_click`) are always registered. They
gate at action time on `pickOsClient().status().available` — if the
bridge is down OR the native addon failed to load OR perms aren't
granted, the tools surface a clear setup hint instead of executing.

Force a specific provider during development:

```sh
HOLO3_OS_PROVIDER=null   # always-unavailable, for testing error paths
HOLO3_OS_PROVIDER=mac    # force mac even on Linux (will fail cleanly)
```

## Tool surface

| Tool | Input | Output |
|------|-------|--------|
| `os_snapshot` | — | `app`, `window`, ax tree text with `[eN]` refs |
| `os_click` | `{ selector, button?, mode? }` | resolved target + coords |

Selector shape: `{ ref: "e12" } \| { text: "Save" } \| { coords: [x, y] }`.
Resolution order: ref → text → coords.

Click currently uses the existing `/screen/click` route (mouse click at
resolved coords). Future commits will add a `mode: "axpress"` shortcut
that posts `/os/perform { handle, action: "AXPress" }` — no cursor
movement, no focus changes.

## Bridge routes added in this commit

| Route | Body | Returns |
|-------|------|---------|
| `POST /os/snapshot` | `{ pid?, maxDepth? }` | raw tree (caller serializes) |
| `POST /os/perform` | `{ handle, action }` | `{ ok: true }` |
| `POST /os/set-value` | `{ handle, value }` | `{ ok: true }` |

## What's not here yet

- `os_type`, `os_hover`, `os_drag` MCP tools (provider methods exist — just need MCP registration)
- Windows provider via PowerShell + UIAutomationClient
- `scripts/bench-os-vs-browser.ts` end-to-end comparison
- Linux AT-SPI (stretch)

See the plan file for the full sequencing.

## Known limitations

- **Bridge must be running.** When the Holo3 app isn't open, `os_*`
  tools return a setup hint. They never auto-fall-back to vision —
  that decision is the planner's, via `agent_observe` / `agent_click`.
- **Electron apps** (Slack, Discord, VS Code) often have empty AX trees.
  `os_snapshot` detects this (empty `ax`) and surfaces a hint pointing
  at `agent_observe`.
- **Background-mode hover impossible** — `screen.move()` is a no-op
  under cliclick. `os_hover` always returns `noop: true` for now.
- **Refs invalidate on every snapshot.** Same staleness model as
  `browser_*`. `os_click` returns a clear "call os_snapshot first"
  error on stale refs.
- **Native addon must match Electron's ABI.** `npm run build:native`
  invokes `electron-rebuild`. If you upgrade Electron, rebuild the
  addon.
