/**
 * Build a Facebook catalog bulk-upload CSV from anorha products — the OFFLINE
 * half of bulk import (PONDER-FB-IMPORT-DESIGN.md, Path B). NO Facebook API:
 * this just produces the spreadsheet that Ponder then feeds into FB's own
 * "Upload from file" template uploader (Commerce Manager → Catalog → Data
 * Sources) via browser_set_input_files.
 *
 * Columns follow Meta's product-feed schema. The EXACT template columns must be
 * confirmed against FB's downloadable template when FB is back up (see the doc's
 * checklist) — this is the standard set and the field MAP, which is the part
 * that needs anorha's data and can be built/validated offline.
 */

import { writeCsvFile } from "../export.js";

/** A product as anorha hands it to the bulk job (mapped from ProductVariants). */
export interface FbCatalogProduct {
  id?: string;
  sku?: string;
  title: string;
  description?: string;
  price?: number | string;
  currency?: string; // default USD
  condition?: string; // free text → normalized to new|used|refurbished
  availability?: string; // default "in stock"
  imageUrl?: string; // MUST be a public http(s) url for the feed
  extraImageUrls?: string[];
  link?: string;
  brand?: string;
  quantity?: number;
}

/** Meta catalog feed columns we emit, in order. */
export const FB_CATALOG_COLUMNS = [
  "id",
  "title",
  "description",
  "availability",
  "condition",
  "price",
  "link",
  "image_link",
  "additional_image_link",
  "brand",
  "quantity_to_sell_on_facebook",
] as const;

export interface BuildResult {
  path: string;
  count: number; // rows written
  skipped: Array<{ title: string; reason: string }>;
}

/** Normalize a free-text/condition value to Meta's enum (new|used|refurbished). */
export function normalizeCondition(raw?: string): string {
  const c = (raw ?? "").toLowerCase();
  if (!c) return "new";
  if (/refurb/.test(c)) return "refurbished";
  // Check USED indicators BEFORE plain "new" — "Used - Like New" / "Like New"
  // contain the word "new", so a \bnew\b test would mis-tag them as new.
  if (/\bused\b|like new|\bgood\b|\bfair\b|pre-?owned|open box|refurb/.test(c)) return "used";
  if (/\bnew\b/.test(c)) return "new";
  return "new";
}

/** Meta wants price as "<amount> <CUR>", amount with 2 decimals, e.g. "20.00 USD". */
export function formatPrice(price: number | string | undefined, currency = "USD"): string {
  if (price === undefined || price === null || price === "") return "";
  const n = typeof price === "number" ? price : parseFloat(String(price).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n)) return "";
  return `${n.toFixed(2)} ${currency}`;
}

const isPublicUrl = (u?: string): boolean => !!u && /^https?:\/\//i.test(u);

/** Map one product to the FB catalog row (object keyed by FB_CATALOG_COLUMNS). */
export function toFbCatalogRow(p: FbCatalogProduct): Record<string, string> {
  return {
    id: String(p.id ?? p.sku ?? "").trim(),
    title: (p.title ?? "").slice(0, 150),
    description: (p.description ?? p.title ?? "").slice(0, 5000),
    availability: p.availability ?? "in stock",
    condition: normalizeCondition(p.condition),
    price: formatPrice(p.price, p.currency),
    link: p.link ?? "",
    image_link: isPublicUrl(p.imageUrl) ? p.imageUrl! : "",
    additional_image_link: (p.extraImageUrls ?? []).filter(isPublicUrl).join(","),
    brand: p.brand ?? "",
    quantity_to_sell_on_facebook: p.quantity !== undefined ? String(p.quantity) : "",
  };
}

/**
 * Build the catalog CSV. Skips products WITHOUT a public image url (the feed
 * can't carry device-local file:// photos — they must be rehosted first) and
 * without a title/id, reporting them so the caller can surface what was dropped.
 */
export function buildFbCatalogCsv(products: FbCatalogProduct[], path?: string): BuildResult {
  const skipped: BuildResult["skipped"] = [];
  const rows: string[][] = [];
  for (const p of products) {
    const title = (p.title ?? "").trim();
    if (!title) {
      skipped.push({ title: p.id ?? p.sku ?? "(no title)", reason: "missing title" });
      continue;
    }
    if (!isPublicUrl(p.imageUrl)) {
      skipped.push({ title, reason: "no public image_link (device-local/empty — rehost first)" });
      continue;
    }
    const row = toFbCatalogRow(p);
    rows.push(FB_CATALOG_COLUMNS.map((c) => row[c] ?? ""));
  }
  const written = writeCsvFile({ headers: [...FB_CATALOG_COLUMNS], rows }, path);
  return { path: written, count: rows.length, skipped };
}
