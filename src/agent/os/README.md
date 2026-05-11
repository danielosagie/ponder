# `os_*` — OS-level a11y-grounded tooling (prototype)

A comparison prototype for the "OS-level Playwright" idea: mirror the
`browser_*` tool shape (`browser_snapshot` → `browser_click({ ref })`)
for native windows, so the agent can pick refs out of an accessibility
tree instead of paying a vision-grounding round-trip per click.

**Status:** Commit 1 of a multi-step plan
(`/root/.claude/plans/i-ve-been-thinking-one-sorted-babbage.md`). macOS
provider scaffolded; Windows + benchmark land in later commits.

## Architecture

```
src/agent/os/
  types.ts              OsClient, OsSnapshot, OsElement, OsSelector
  refs.ts               eN → AX handle map (reset on every snapshot)
  snapshot.ts           Vimium-style serializer (matches BrowserSnapshot.ax)
  client.ts             pickOsClient() factory, lazy mac import
  providers/
    null.ts             unsupported-platform fallback
    mac.ts              AXUIElement bridge via Swift helper
  helpers/mac-axdump/
    ax-bridge.swift     dump | perform | set-value | resolve subcommands
    build.sh            swiftc invocation; run once on macOS
```

Mirrors `src/agent/browser/` shape exactly. `OsSnapshot { app, window, ax }`
parallels `BrowserSnapshot { url, title, ax }`.

## macOS setup

```sh
cd src/agent/os/helpers/mac-axdump
bash build.sh
```

Then grant **Accessibility** permission to the process that invokes the
binary (Claude Code / Electron / `tsx`), NOT to `ax-bridge` itself:

> System Settings → Privacy & Security → Accessibility → enable the
> app spawning the MCP child.

On first call you'll get `ax-bridge permission-denied`; grant perms and
retry.

## Enabling the tools

The MCP tools are registered behind a feature flag so they only appear
when explicitly enabled (and only on supported platforms):

```sh
OS_TOOLS_ENABLED=1 npm run dev
```

You can also force a specific provider:

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

## What's not here yet

- `os_type`, `os_hover`, `os_drag` (commit 2)
- Windows provider via PowerShell + UIAutomationClient (commit 2)
- `scripts/bench-os-vs-browser.ts` end-to-end comparison (commit 3)
- Linux AT-SPI (stretch)

See the plan file for the full sequencing.

## Known limitations

- **Electron apps** (Slack, Discord, VS Code) often have empty AX trees.
  Detect by `ax` length / `[eN]` count; fall back to `agent_observe`.
- **Background-mode hover impossible** — `screen.move()` is a no-op
  under cliclick. `os_hover` will surface `noop: true`.
- **Helper binary unsigned** for dev — `build.sh` strips the quarantine
  xattr; production needs proper codesigning.
- **Refs invalidate on every snapshot.** Same staleness model as
  `browser_*`. `os_click` returns a clear "call os_snapshot first"
  error on stale refs.
