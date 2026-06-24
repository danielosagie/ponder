/** Deterministic test of the FB catalog CSV exporter (offline half of bulk import).
 *  Run: tsx bench/fb-catalog-csv-smoke.ts */
import { buildFbCatalogCsv, toFbCatalogRow, formatPrice, normalizeCondition, type FbCatalogProduct } from "../src/agent/browser-jobs/fb-catalog-csv";
import { readFileSync } from "node:fs";

let fail = 0;
const check = (n: string, ok: boolean, got?: unknown) => {
  console.log(`  ${ok ? "ok " : "FAIL"} ${n}${ok ? "" : " — got " + JSON.stringify(got)}`);
  if (!ok) fail++;
};

// unit: helpers
check("price 19.99 → '19.99 USD'", formatPrice(19.99) === "19.99 USD", formatPrice(19.99));
check("price '$20' → '20.00 USD'", formatPrice("$20") === "20.00 USD", formatPrice("$20"));
check("condition 'Used - Good' → used", normalizeCondition("Used - Good") === "used");
check("condition '' → new", normalizeCondition("") === "new");
check("condition 'Refurbished' → refurbished", normalizeCondition("Refurbished") === "refurbished");
check("condition 'Used - Like New' → used (not new!)", normalizeCondition("Used - Like New") === "used", normalizeCondition("Used - Like New"));
check("condition 'Like New' → used", normalizeCondition("Like New") === "used", normalizeCondition("Like New"));
check("condition 'New' → new", normalizeCondition("New") === "new", normalizeCondition("New"));

// unit: row map
const row = toFbCatalogRow({ id: "SKU1", title: "Torras Case", price: 19.99, condition: "New", imageUrl: "https://x/p.jpg", brand: "TORRAS" });
check("row image_link kept (public)", row.image_link === "https://x/p.jpg", row.image_link);
check("row id from sku/id", row.id === "SKU1", row.id);

// integration: build CSV with a realistic mix (hosted, file://, no-title)
const products: FbCatalogProduct[] = [
  { sku: "838993ae", title: "Torras Shockproof Magsafe Kickstand Samsung S26 Ultra - Black", price: 19.99, condition: "New", imageUrl: "https://pqmxhoxffarcvaxeakwo.supabase.co/storage/v1/object/public/product-images/x/photo.jpg", brand: "TORRAS", quantity: 1 },
  { sku: "ikea1", title: "RÅGKORN Plant pot", price: 19.99, condition: "Used - Good", imageUrl: "file:///var/mobile/Containers/.../camera.jpg" }, // device-local → skip
  { sku: "notitle", title: "", price: 5, imageUrl: "https://x/y.jpg" }, // no title → skip
];
const res = buildFbCatalogCsv(products, "/tmp/fb-bulk-test.csv");
check("only the hosted+titled product written (count=1)", res.count === 1, res.count);
check("2 skipped", res.skipped.length === 2, res.skipped);
check("skip reasons present", res.skipped.some(s => /image/.test(s.reason)) && res.skipped.some(s => /title/.test(s.reason)), res.skipped);

const csv = readFileSync(res.path, "utf-8");
console.log("\n--- generated CSV ---\n" + csv);
check("CSV header has FB columns", csv.startsWith("id,title,description,availability,condition,price,link,image_link"), csv.split("\n")[0]);
check("CSV row has price '19.99 USD'", csv.includes("19.99 USD"), null);
check("CSV row condition new", /(^|,)new(,|$)/m.test(csv), null);

console.log(`\n${fail === 0 ? "=== PASS" : "=== FAIL"} — ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
