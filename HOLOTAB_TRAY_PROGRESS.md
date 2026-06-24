# HoloTab Tray App — build loop progress

_Living doc. Updated each `/loop` iteration. Source of truth for "where are we."_

## Goal (acceptance test)
Ollama-style menubar **tray app** (Codex-style automation UX + holo3-agent's floating Buddy cursor) that **reliably runs this task 3× + benchmarks it**:

> Go to Facebook Marketplace → pull all my products → keep the **active** listings → put them in a **new Google Sheet** → edit the **power inverter** price to **4206.90**.

With: logs (debug failures), the task **recorded as a recipe**, then benchmark the **best run** + demonstrate **self-heal/improve**. Model: **Holo 3.1 hosted** (`holo3-1-35b-a3b`, key `HAI_API_KEY`).

## Architecture decision (LOCKED)
- **Engine = holo3-agent** (NOT a HoloTab reskin). Local observe-decide-act brain; **Holo 3.1 hosted only for vision-grounding**. This preserves the cost moat (local thinking) + keeps the IP ours (recipe library + heal loop).
- **HoloTab = blueprint, not the product.** It's H Company's official extension (thin driver to *their* metered hosted brain; no deterministic replay). We borrow its CDP-driver design for a future own-extension to drop the Playwriter dependency.
- **Browser bridge = Playwriter** CDP relay (existing/live) for now. Future: own CDP driver extension (HoloTab-style).
- **Reliability via recipe-first**, which is also the product thesis:
  - **R0 Record** — agentic run (Holo 3.1), saves recipe. Slow/expensive, once.
  - **R1, R2 Replay** — deterministic `ponder_recipe_replay` (`reground:true`). Fast, ~free. = the "reliable 3×".
  - **Heal demo** — break → heal (ref → reground) → **rewrite recipe so fix persists** (the real gap: healRef is ephemeral today).
  - **Benchmark** = record-time vs replay-times + steps + grounding calls + est cost. Replay should be ~5–10× faster (the moat number).

## Hard gates (need the human)
- [ ] Chrome attached via green **Playwriter** icon on the FB tab (one click — Chrome debugger security; no workaround).
- [ ] Logged into **Facebook** (Marketplace › Your listings) + **Google** (Sheets).

## Known facts
- Live MCP `ponder` @ `http://127.0.0.1:7831/mcp`, commit `edc72b784fd4` = on-disk HEAD (NOT stale; `dirty` = uncommitted edits already loaded). Restart after editing `src/mcp/**` or `src/agent/**`: `bash scripts/kill-stale-mcp.sh` then reconnect.
- Scripts: `dev`=electron tray, `mcp:http`=`tsx src/mcp/server-http.ts`, `ponder`=CLI, `bench:menu`=`bench/integration-fb-menu.ts`, `bench:integration`=`bench/integration-flat-edit.ts`.
- `.env`: `HCOMPANY_MODEL=holo3-1-35b-a3b`, `HAI_API_KEY=hk-…`, Modal + Ollama also configured. Default provider TBD (workflow verifying).

## Pivot 2026-06-17 AM: simplest Ollama UI + NO browser extension
User redirected from the FB benchmark (no "power inverter" listing exists anyway — mostly Sold) to: build the **simplest Ollama-style tray UI** + **drop the Playwriter extension entirely** (Granola/Notion model: app opens the user's own Chrome, they log in once, no extension). Brand = **Anorha**. UI mock approved (3 states: connect / idle / running) at `tray-mock.html` (served via `.tray-preview/` on a static server). User chose to build the **no-extension engine + speed test FIRST**.

### NO-EXTENSION TRANSPORT — VALIDATED ✅ (`bench/no-ext-transport.ts`)
`chromium.launchPersistentContext('~/.anorha/chrome-profile', {channel:'chrome', headless:false, ignoreDefaultArgs:['--enable-automation'], args:['--disable-blink-features=AutomationControlled', …]})` drives the user's INSTALLED Chrome, dedicated profile, **zero extension, zero gesture**. Hardened to hide the automation fingerprint. **Measured:** launch 1.9s (warm) / 5.4s (cold first run); goto warm **76ms**; DOM query **26ms**; page.evaluate **2ms**; facebook.com root loads **691ms** → normal login page (screenshot `/tmp/anorha-fb.png`), NO bot block. Logins persist in the profile dir. Deep-URL goto aborts on logged-out redirect → navigate to root or use `waitUntil:'commit'`. **NEXT: wire this as a BrowserClient backend in `src/agent/browser/` (alongside/replacing Playwriter) so agent_do + recipes drive the no-ext window; then build the Anorha tray renderer + connect-channels flow.**

## Provider wiring (RESOLVED + VALIDATED 2026-06-17)
- **Root cause of "wrong model":** `~/.holo3-agent/preferences.json` pins the provider and **wins over env vars** (`factory.ts:51-53` → `getProviderPreference()` reads the file fresh each call). It was `{"provider":"remote"}` = **Modal**, ignoring `HAI_API_KEY`. **Fixed → `{"provider":"hcompany"}`.**
- `tools.ts:250 getProvider()` **memoizes** `_providerPromise` at first provider use. Only read-only tools had run this session → cache cold → the prefs edit took effect with **no MCP restart**.
- **VALIDATED:** `agent_observe` grounded the Apple menu at (24,16) in **2252ms** (Holo 3.1 hosted speed; Modal cold-start would be 30-60s). Provider=hcompany, `HAI_API_KEY` valid, Holo 3.1 `holo3-1-35b-a3b` grounding works, Screen Recording perm granted.
- **Decided benchmark shape:** R0 agentic **record** → R1/R2 **`reground:true` replay** (frozen plan, vision re-grounds each step → survives a fresh Google Sheet's DOM + stale refs; verifier-2's path). Scope to first-page active listings (avoid infinite-scroll anti-loop). Existing engine already self-heals via reground; heal-**rewrite** (persist) is the "improving" enhancement.

## The one thing the human must do (gate)
Open Chrome → `facebook.com/marketplace/you/selling`, **logged into Facebook + Google** (test `sheets.new` opens blank), then **click the green Playwriter icon** on that tab. Then the run executes.

## Loop state
- **2026-06-17 03:15** — Poll: Chrome NOT attached (user asleep). De-risk: inspected existing recipe JSON — format confirmed `{t,executed:{type,payload},url,refLabel?,intent?}`; existing one is a degenerate 1-step `browser_navigate` (no intent/refLabel, fine for navigate). Replay-path split confirmed: `browser_*`→ref+refLabel heal (recorder captures role+name), coord clicks→reground needs `intent`. Plan holds: drive R0 via `browser_*` (captures refLabel) + `screen_hotkey` for OS steps. Long-polling 1h for attach.
- **2026-06-17 02:40** — Recon + HoloTab decompile done. Architecture LOCKED (Option B). Workflow `wf_f39478bb-29b` ingested. **Provider FIXED → hcompany + grounding VALIDATED (2.25s).** User asleep (2:39am). **NEXT (autonomous):** build JSONL logging harness + heal-rewrite patch (sdk.ts+recorder.ts, typecheck; restart batched w/ run) + tray UI shell. **GATED:** await Chrome attach → R0 record → R1/R2 reground replay → heal demo → benchmark report.

## Run defaults (override on return)
- Price-edit target: **your real "power inverter" listing → 4206.90** (as instructed; revertible). Say the word for a dummy listing instead.
- Scope: **first-page active listings** (reliable). Say "all" to scroll-load everything.

## RUNBOOK — push-button gated run (execute when Chrome is attached)
**Pre-flight:** `browser_status` → must show `Attached. URL: …facebook.com/marketplace/you/selling`. Provider already `hcompany` (validated). Confirm logged into FB + Google (`sheets.new` opens blank).

**R0 — Record (agentic, I orchestrate step-by-step; every browser_*/agent_do auto-buffers):**
1. `ponder_recipe_start({task:"FB active listings → new Google Sheet → power inverter price 4206.90"})`
2. Drive as a tight observe→act loop (I'm the planner): `browser_navigate` selling page → `browser_snapshot` → read active listings (`browser_read`) → new tab `agent_do{surface:menu-bar/other}` cmd+t → `browser_navigate sheets.new` → `browser_click`/`browser_type` headers+rows into cells → back to FB → open power inverter edit → `browser_type` price `4206.90` → save. Observe between every step. Log each (ts, action, latency, ok) to JSONL.
3. `ponder_recipe_save({task})` → capture **recipe id**, record wall-clock + step count.

**R1, R2 — Replay (deterministic, vision re-grounds each step):**
4. `ponder_recipe_replay({id, reground:true})` → capture outcome, steps, elapsed. **×2.** (creates its own fresh sheet each run; reground survives the new DOM.)

**Report:** table → phase | wall-clock | steps | grounding calls | outcome; record-vs-replay speedup (the moat number) + est cost (grounding calls × Holo price). Write to `~/.ponder/benchmarks/` + show user.

**Then (with validation):** implement heal-rewrite (persist healed ref/coords → `sdk.ts` `withHealedRef`/`resolveCoords` set `ctx.stepHealed`; `replayRecipe` re-saves on `persistHeals` flag), restart MCP (`scripts/kill-stale-mcp.sh`), re-run to show R2<R1 "improving". Then build tray UI shell (additive: `src/renderer/tray/*` + `electron/windows.ts createTrayPanelWindow` + `electron.vite.config.ts` input — isolated from the engine path).

## Verified ground() contract (for heal-rewrite later)
`provider.ground({instruction, screenshotB64, screen:[w,h]})` → `{x,y,error?}`; coords in screenshot space, add `shot.offsetX/Y`. `ReplayCtx={browser,provider,reground,healedOnce?}` (add `stepHealed?`). Heal lives in `sdk.ts:676 withHealedRef` (refs) + `sdk.ts:835 resolveCoords` (coords); neither persists today.

## Open risks (remaining)
- Cross-tab new-sheet replay → mitigated by `reground:true` (validate at run).
- Reground accuracy on tiny Google Sheets cells → may need `refine:true`; validate with a dummy sheet first.
- Infinite-scroll "pull ALL" trips anti-loop → scoped to first page by default.
- 3× live price write to a real listing → ends at 4206.90, user-revertible.
- MCP restart for heal-rewrite: kill-stale + may need Claude Code restart (do with user present).
