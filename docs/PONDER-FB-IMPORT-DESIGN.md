# Importing products to Facebook — UI-driven via Ponder (NO FB API)

Hard constraint: **we do not use the Facebook Marketing / Business / Catalog
(Graph) API.** Every write to Facebook goes through Ponder driving the real
Chrome UI (the dispatcher → Convex `browserJobs` → desktop consumer → Ponder).
That's already true for single listings; this doc sketches how **bulk import**
works the same way, using **Facebook's own bulk template uploader** instead of N
one-at-a-time creates.

> Status: SKETCH (Facebook was down when written — 2026-06-23). The flow is laid
> out from prior live mastery of the create form; the **bulk uploader UI steps +
> the current CSV template columns must be confirmed live when FB is back** (see
> the checklist at the end).

---

## Two import paths, one principle

| | Path | When | Mechanism |
|---|---|---|---|
| **Single / small batch** | per-item Marketplace create | a few items | `fb-create-listing-full` recipe (proven live) — fills the create form field-by-field, publishes |
| **Bulk** | Facebook's **template/catalog uploader** | many items | export FB's CSV template, then Ponder drives the Commerce Manager upload UI + `browser_set_input_files` the file |

Both are UI-driven. Neither sends anything to a Facebook API. The principle:
**anorha produces the data; Ponder operates Facebook's own screens.**

---

## Path A — single create (DONE / proven)

`dispatch_marketplace_job{operation:'create', details}` → `browserJobs:create`
→ desktop consumer → replays `fb-create-listing-full` (or vision fallback) →
fills photos/title/price/category/condition/description across the 3 pages
(`step=item → delivery → audience`) → **Publish**. Verified live with a real
product (Torras case → Active). Bulk-as-small-batch already works too:
`dispatch_marketplace_job{productIds:[...]}` enqueues one create job per item and
the consumer runs them serially. Good for a handful; too slow for hundreds (each
create is ~10–30s).

## Path B — bulk via Facebook's template uploader (the sketch)

For real bulk, drive **Facebook's native bulk tool** (Commerce Manager →
Catalog → Data Sources → **Add items → Upload from file**), which ingests a
spreadsheet in **FB's template format** in one shot.

```
anorha (selected products)
   │  1. EXPORT → FB catalog template CSV   (deterministic field map, our code)
   ▼
~/…/fb-bulk-<catalog>.csv   (id,title,description,availability,condition,
   │                          price,link,image_link,brand,quantity,…)
   │  2. enqueue browserJob  { type:'bulk_upload_catalog',
   │                           payload:{ catalogId?, csvPath, mapping? } }
   ▼
desktop consumer  →  Ponder recipe `fb-bulk-upload`:
     navigate Commerce Manager catalog → Data Sources → Add items →
     Upload from file → browser_set_input_files(<the CSV>) →
     (column-mapping step, if FB prompts) → submit →
     wait for "N items processed" → extract the result count/errors
   ▼
3. reconcile back to anorha  (items uploaded, errors per row)
```

### What anorha generates (step 1)
A CSV in FB's catalog feed schema. The columns we already have map cleanly:

| FB template column | anorha source (`ProductVariants`) |
|---|---|
| `id` | `Id` / `Sku` |
| `title` | `Title` |
| `description` | `Description` |
| `price` | `Price` (+ currency, e.g. `20.00 USD`) |
| `condition` | new / used (we default "new"/"used") |
| `availability` | `in stock` (from inventory) |
| `image_link` | `PrimaryImageUrl` — **must be a public URL** |
| `link` | product/landing URL (optional) |
| `brand`, `quantity`, `google_product_category` | from tags/options/metadata |

**Image gotcha (already known):** the feed needs **public** `image_link`s. Many
anorha `PrimaryImageUrl`s are device-local `file://…` paths — those must be the
**rehosted** Supabase `…/storage/v1/object/public/product-images/…` URLs (which
exist for synced items). The single-create path sidesteps this by downloading the
file and `set_input_files`; the bulk feed CANNOT — it needs the hosted URL. So
bulk import requires the products to have hosted images first.

### What Ponder drives (step 2) — the new recipe `fb-bulk-upload`
Same robust toolkit as the create recipe: `browser_set_input_files` for the CSV
(no native picker), label/role locators for the upload + mapping buttons,
`{{csvPath}}` parameter. The only genuinely new UI is the **column-mapping
screen** (FB sometimes asks you to confirm which spreadsheet column is which
field) — handle it as parameterized dropdown selects (the `{{token}}`-target
mechanism already built).

---

## The fork to confirm with the user

Facebook's **bulk template uploader populates a Commerce Manager *catalog*
(Shop)** — **not** personal Marketplace listings. Personal Marketplace has **no
bulk tool** (one-at-a-time only). So:

- **Bulk → catalog/Shop** (native template upload; this doc's Path B). Products
  live in a catalog; surfaced on Marketplace only for a **business/Shop**
  account (Commerce eligibility), or listed-to-Marketplace from the catalog.
- **Bulk → personal Marketplace** = there is no native bulk; only Path A repeated
  (N creates), which is slow but needs no Shop.

**Decision needed:** is the target a **Commerce Manager Shop catalog** (then the
template uploader is the right, fast, native path) or **personal Marketplace**
(then bulk = many single creates, no template uploader exists)? "Use their
template uploader" implies the **catalog/Shop** path — confirm the account is
set up for Commerce/Shop.

---

## Verify / fix live when Facebook is back

1. Confirm the account has **Commerce Manager / a catalog** (Business vs personal).
2. Walk the live UI: Commerce Manager → Catalog → Data Sources → Add items →
   **Upload from file**; snapshot every step + capture the exact button labels.
3. **Download FB's current CSV template**; diff its columns against our export map
   above; lock the field mapping.
4. Test-upload a 2–3 row CSV (real hosted images); confirm ingestion + read back
   the success/error report; verify items appear in the catalog.
5. Record the flow as the `fb-bulk-upload` recipe (parameterize `{{csvPath}}` +
   any mapping selects); wire `bulk_upload_catalog` in the executor (`goalForJob`
   + a recipe mapping) and a `dispatch_marketplace_bulk` producer that writes the
   CSV and enqueues the job.
6. Confirm catalog → Marketplace surfacing for this account.
