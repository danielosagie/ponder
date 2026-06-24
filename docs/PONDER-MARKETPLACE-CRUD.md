# Ponder × Marketplace — full CRUD (single + bulk)

How to drive **any** seller marketplace (Facebook Marketplace, eBay, Poshmark,
Mercari, Depop, Etsy, a Shopify admin…) through Ponder to do the four operations
at both scales:

|            | **Single**                          | **Bulk**                                                    |
|------------|-------------------------------------|-------------------------------------------------------------|
| **Create** | post one listing                    | post N listings from a spreadsheet / cart                   |
| **Read**   | open one listing → fields           | export the whole inventory → CSV/Sheet                      |
| **Update** | edit one listing's price/title      | price-drop / relist / restock across N                      |
| **Delete** | mark-sold / remove one              | bulk mark-sold / remove                                     |

The guide is platform-agnostic on purpose. Selectors differ per site; the
*patterns* don't. Ponder is the toolkit — **you (the planner) run the loop.**

---

## 0. Mental model

Three things make marketplace CRUD fast and reliable on Ponder:

1. **The observe→decide→act loop** for anything new. One tool call, one state
   change, re-observe. Never chain blind.
2. **Coarse tools beat the vision loop** for the heavy parts:
   - **Reading many rows** → `extract` (one call turns the page into a table).
     No per-row scrolling/screenshots.
   - **Repeating a known write** → record it once, then `ponder_recipe_replay`
     it per item (deterministic, no LLM, **self-heals** when the DOM drifts).
   - **A big end-to-end goal** → `long_task` decomposes once and routes each
     sub-step to the cheapest executor (replay › coarse › agent).
3. **The flywheel.** The FIRST time you do an op on a site, you do it the slow
   way (snapshot → click → type). You **save that as a recipe**. Every
   subsequent run is a replay — seconds, no tokens, and it adapts to small
   layout changes. Bulk = the same recipe replayed over a list.

> Cost/speed: everything here runs on the **hosted H‑company API** brain by
> default (fast, no cold start). Modal/local Holo is optional and only matters
> for the autonomous `agent_*` / `agp_do` paths.

---

## 1. Cold start (always first)

```
ponder_browser_ensure({ url: "https://www.facebook.com/marketplace/you/selling" })
```

Launches Chrome if needed, installs/attaches the Playwriter extension by
vision (no "click the green icon" ask), switches/navigates to the URL. Returns
`{ url, title }`. **You must be signed in to the marketplace already** — Ponder
reuses your real browser session; it never handles passwords.

---

## 2. CREATE

### 2a. Create — single listing

The golden rule for posting: **`browser_snapshot` FIRST**, because the photo
`<input type=file>` is usually already in the DOM and surfaces as a ref flagged
`(use browser_set_input_files, accepts=…)`. Don't click the styled "Add photos"
button as your upload step.

```
ponder_browser_ensure({ url: "<site>/marketplace/create/item" })
browser_snapshot()                                   # find field + file-input refs
browser_set_input_files("e22", ["/Users/me/Desktop/couch-1.jpg",
                                "/Users/me/Desktop/couch-2.jpg"])   # photos, no native picker
browser_type("e10", "Mid-century walnut couch")      # title
browser_type("e11", "450")                           # price
browser_click("e14")                                 # open Category dropdown
browser_snapshot(); browser_click("e31")             # pick "Furniture"
browser_type("e12", "Solid walnut, light wear…")     # description
browser_click("e40")                                 # Next / Publish
browser_snapshot()                                   # CONFIRM it posted (URL/toast)
```

- Photos from disk → **always `browser_set_input_files`**, never `agent_*`.
- Don't know the path? Read it from disk with a Bash tool
  (`ls -t ~/Desktop/*.jpg`, `mdfind`) — never open Finder by vision.
- A dropdown that filters as you type: type, `browser_snapshot`, click the
  `(suggestion)` ref (it un-disables Apply/Next).

**Then bank it:** `ponder_recipe_save({ task: "Post a Marketplace listing" })`.

### 2b. Create — bulk (N listings from a spreadsheet/cart)

Source rows = a CSV/Sheet/the app cart, each row: `title, price, category,
description, photo_paths`. Two ways:

- **Replay-per-row (preferred once you have the recipe).** You already saved
  the single-create recipe in 2a. For each row, replay it feeding that row's
  values. Because replay re-grounds each step, it tolerates the small per-item
  DOM differences.

- **`long_task` for the whole job.** Hand the orchestrator the goal once:
  ```
  long_task({ goal: "Post every row of ~/Desktop/inventory.csv as a Facebook
              Marketplace listing: title, price, category, description, and the
              photos in photo_paths. Skip rows already live. Report a table of
              posted vs skipped with each new listing URL." })
  ```
  It decomposes into per-row sub-tasks, routes each to the cheapest executor,
  checkpoints progress to `~/.ponder/runs/<id>.json`, and resumes if interrupted.

Per-row loop you'd drive by hand (also what the orchestrator does internally):
```
for row in rows:
    browser_navigate("<site>/marketplace/create/item")
    browser_snapshot()
    browser_set_input_files(file_ref, row.photo_paths)
    browser_type(title_ref, row.title); browser_type(price_ref, row.price); …
    browser_click(publish_ref); browser_snapshot()   # confirm, capture URL
```
Log a "N of M posted" line so a partial run is never mistaken for a full one.

---

## 3. READ

### 3a. Read — single listing

```
browser_navigate("<listing url>")
browser_read()              # cleaned page text
# or for exact fields:
extract({ columns: ["Title","Price","Condition","SKU","Description","PhotoURLs"] })
```

### 3b. Read — bulk (export the whole inventory → CSV/Sheet)

This is the `extract` sweet spot. Two stages: **load everything**, then **one
extract**.

```
ponder_browser_ensure({ url: "<site>/marketplace/you/selling" })
# Load lazy lists: scroll to the bottom until the text stops growing
browser_scroll("down"); browser_scroll("down"); …    # or rely on long_task's scrollToLoadAll
extract({
  columns: ["Item","Price","Status","Views","Listed"],
  instructions: "Only active listings; skip sold/draft.",
  to: "csv"                                           # writes ~/Downloads/…csv (or to:'clipboard')
})
```

- `to: "clipboard"` → then click the sheet's A1 and paste (TSV). `to: "csv"` →
  file on disk. Omit `to` → rows come back as JSON for `copy_table` / `write_csv`.
- **Per-item detail the index page doesn't show** (SKU, full photo URLs): open
  each listing in its own tab and extract, keeping the index tab open:
  ```
  for each listing link:
      browser_new_tab("<listing url>")               # opens + becomes active, auto-attached
      extract({ columns: ["Title","Price","SKU","PhotoURLs"] })   # collect
      browser_switch_tab({ urlIncludes: "selling" }) # back to the index
  ```
  `browser_new_tab` / `browser_list_tabs` / `browser_switch_tab` are the
  controlled-group tab tools — keep one index tab + one detail tab and recycle.

---

## 4. UPDATE

### 4a. Update — single

```
browser_navigate("<listing url>")           # or from the index, click the listing
browser_snapshot()
browser_click(edit_ref)                      # "Edit listing"
browser_snapshot()
browser_type(price_ref, "399")               # change price (clear first if needed)
browser_click(save_ref); browser_snapshot()  # confirm saved
```
Save it: `ponder_recipe_save({ task: "Edit a Marketplace listing price" })`.

### 4b. Update — bulk (price-drop / relist / restock across N)

Same flywheel: the single-edit recipe replayed per listing with the new value.
The common jobs:
- **Price drop 10%** → read current prices via `extract` (3b), compute new
  prices, replay the edit recipe per item with each new price.
- **Relist stale items** → replay a "delete + repost" recipe over items older
  than N days (filter from the `extract` table's "Listed" column).
- **Restock / toggle availability** → replay the toggle recipe per SKU.

Or one orchestrated pass:
```
long_task({ goal: "On Facebook Marketplace, drop the price 10% on every active
            listing older than 14 days, then report old→new price per item." })
```

---

## 5. DELETE (remove / mark-sold)

### 5a. Delete — single
```
browser_navigate("<listing url>"); browser_snapshot()
browser_click(menu_ref)                       # the ⋯ / "Manage" menu
browser_snapshot(); browser_click(delete_or_sold_ref)
browser_snapshot(); browser_click(confirm_ref)   # confirm dialog
browser_snapshot()                            # verify it's gone
```
> The confirm click is irreversible — surface what you're about to delete and
> get a yes before bulk-deleting on the user's behalf.

### 5b. Delete — bulk
Replay the single delete/mark-sold recipe over the target list (e.g. everything
marked sold elsewhere, or a list of SKUs). Narrate "N of M removed" and stop on
the first unexpected dialog rather than clicking through blind.

---

## 6. The recipe flywheel (why bulk is cheap)

```
ponder_recipe_start({ task: "<op> on <site>" })   # mark a clean trace buffer
…do the op ONCE the slow way (snapshot → click → type)…
ponder_recipe_save({ task: "<op> on <site>" })    # → ~/.ponder/recipes/<id>.{json,recipe.ts}
```
Then bulk = replay:
```
ponder_recipe_replay(<id>, { reground: true })    # deterministic, no LLM
```
- **`reground: true`** re-locates each element by its role+name every run, so the
  recipe survives small layout changes (it **self-heals**; healed steps are
  reported).
- Saved recipes show up in the app's **Automations** tab — the user can open one
  (steps + metadata), hit **Run now**, or reveal the editable `.recipe.ts`.
- A past run in **History** can be promoted with **Save as automation** (or, for
  full fidelity, **Run again** then save the fresh run).

Per-site, you end up with ~4 recipes — create, edit, mark-sold, export — and
every bulk job is just one of them replayed over a list.

### Speed targets: single ≤10s, bulk ≤30s

Recipes are built for speed, and the read path is measured against real data:

- **Reads** (`scrape_inventory` / `sync_listing_state` / `check_messages`) use the
  bridge **`/extract`** path with a FAST model (gemini-flash, not the slow text
  model). Measured: a full Marketplace scrape (33 listings) = **~16s** end-to-end
  (navigate + load-all + structured rows); a single-listing read = **~3s**.
- **Writes** replay **in-Chrome via aria-refs** — no per-step vision (~100-300ms
  per step), with `reground:false` so there's no provider warm-up. A recorded
  create/edit/delete replays in a few seconds → inside the 10s budget. Self-heal
  is still on (refLabel re-resolution via a snapshot, no model).
- **Record write recipes browser-only** (use `browser_set_input_files` for
  photos, never the native OS picker) so every step replays fast.

### Parameterize recorded recipes with `{{tokens}}`

A recorded write recipe types whatever you typed while recording. To make ONE
recipe list ANY item, type **`{{token}}`** placeholders during recording and the
consumer substitutes the browser-job payload at replay:

- `{{title}}`, `{{price}}`, `{{description}}`, `{{category}}`, `{{condition}}`,
  `{{location}}` → substituted into the matching typed fields.
- A photo file-input recorded with the single path **`{{photoPaths}}`** expands
  to the job's `photoPaths` array (N real photos).
- `{{listingUrl}}` in a navigate step → the target listing.

So `dispatch_marketplace_job { operation:'create', details:{title, price, …,
photoPaths} }` → the create recipe replays with those values; bulk passes
`productIds[]` / `items[]` and each runs the same recipe with its own data.

---

## 7. The five hard rules (don't relearn these per site)

1. **A ref is present → `browser_click` / `browser_type`.** Never `agent_*` for
   in-Chrome elements, even if the click opens a native dialog.
2. **File upload from disk → `browser_set_input_files`.** Snapshot FIRST; the
   hidden `<input type=file>` is usually already there. Never click the styled
   "Add photo" button as the upload step.
3. **`agent_do` is the autonomous loop, not the default click.** For an OS-level
   click you can describe (a system "Allow" dialog, a dock icon) use `agent_click`
   (~2–3s). Reserve `agent_do` for open-ended OS work.
4. **Redirect ≠ retry.** If `browser_navigate` lands on a different URL, accept
   it / use on-page nav — don't re-emit the same navigate.
5. **Same action failed twice → STOP, re-snapshot, re-decide.** And **observe
   after every call** before the next one.

---

## 8. Worked example — spreadsheet ⇄ marketplace round-trip

**Import (bulk create):**
```
ponder_browser_ensure({ url: "<site>/marketplace/you/selling" })   # confirm signed in
long_task({ goal: "Post every row of ~/Desktop/restock.csv as a listing
            (title, price, category, description, photos=photo_paths). Skip any
            title already live. Output a CSV of title→new URL." })
```

**Export (bulk read) the result back:**
```
ponder_browser_ensure({ url: "<site>/marketplace/you/selling" })
# scroll to load all, then:
extract({ columns: ["Item","Price","Status","URL"], to: "csv" })
```

**Maintain (bulk update), weekly:** replay the saved price-drop recipe, or
`long_task({ goal: "drop price 10% on everything older than 14 days" })`.

That's the whole lifecycle: import from a sheet, list, export back, maintain —
each step either an `extract` (read) or a replayed recipe (write), with
`long_task` when you want it driven end-to-end.

---

## 9. Quick reference — which tool for which job

| Job | Tool |
|---|---|
| Get a driveable tab | `ponder_browser_ensure({ url })` |
| See refs on the page | `browser_snapshot()` |
| Fill a field / click | `browser_type(ref, text)` / `browser_click(ref)` |
| Upload photos from disk | `browser_set_input_files(ref, paths[])` |
| Read one page's text/fields | `browser_read()` / `extract({ columns })` |
| Export many rows → sheet/CSV | `extract({ columns, instructions, to })` |
| Work across pages at once | `browser_new_tab(url)` / `browser_switch_tab` / `browser_list_tabs` |
| Repeat a known write N× | `ponder_recipe_save` once → `ponder_recipe_replay(id, {reground:true})` |
| Drive a big goal end-to-end | `long_task({ goal })` |
| OS-level click/dialog | `agent_click(target)` (autonomous OS work: `agent_do`) |
| In-Chrome end-to-end on the server brain | `agp_do({ task })` |
