/** Build a real FB catalog CSV from a sample of anorha's bulk-ready products
 *  (titled + hosted image), pulled live from Supabase. Proof of server→template.
 *  Run: tsx bench/fb-catalog-real.ts */
import { buildFbCatalogCsv, type FbCatalogProduct } from "../src/agent/browser-jobs/fb-catalog-csv";
import { readFileSync } from "node:fs";

// Sampled from "anorha db" ProductVariants (hosted images only).
const B = "https://pqmxhoxffarcvaxeakwo.supabase.co/storage/v1/object/public/product-images/";
const products: FbCatalogProduct[] = [
  { sku: "DRAFT-7bb1ed6d", title: "10 Actual, Official LSAT Preptests (5) (Lsat Series)", price: 0, imageUrl: B + "b8fd5696-e9fd-4a7d-ac8a-f6b2459d1065/photo-1771009584570-1771009608211.jpg" },
  { sku: "BEAUTIFULJOELSNS293", title: "2021 Apple MacBook Pro 14-inch M1 Pro 16GB RAM 512GB SSD", price: 2750, condition: "Used - Good", imageUrl: B + "003204d6-4da7-4666-9470-2c55b8d4d1df/photo-1768857896857-1768857971430.jpg" },
  { sku: "DRAFT-e3bd7bc1", title: "2025 NWT Nintendo Pokemon Purple Masterball Stuffed Plush Toy Factory", price: 19.95, condition: "New", imageUrl: B + "003204d6-4da7-4666-9470-2c55b8d4d1df/upload-1780953232693-0-1781113767192.jpg" },
  { sku: "AIRPBHDJENS", title: "Apple AirPods 2nd Generation", description: "Seamless wireless audio, automatic pairing, built-in mic, up to 5h listening. Bluetooth 5.0.", price: 89, condition: "New", imageUrl: B + "003204d6-4da7-4666-9470-2c55b8d4d1df/photo-1764447340218-1764447349555.jpg" },
  { sku: "DRAFT-3671e70a", title: "Adidas Samba Jane Womens Athletic Shoes Maroon IH6561", price: 89.95, condition: "New", imageUrl: B + "003204d6-4da7-4666-9470-2c55b8d4d1df/photo-1781648202445-1781648693810.jpg" },
  { sku: "235355", title: "Alakazam SV06 Twilight Masquerade Holo (Near Mint)", description: "Holo foil Alakazam from Twilight Masquerade (SV06), near mint, sharp edges.", price: 12, condition: "Used - Like New", imageUrl: B + "003204d6-4da7-4666-9470-2c55b8d4d1df/photo-1766046312812-1766046357084.jpg" },
];

const res = buildFbCatalogCsv(products, "/tmp/fb-bulk-real.csv");
console.log(`Wrote ${res.path} — ${res.count} rows, ${res.skipped.length} skipped`);
if (res.skipped.length) console.log("skipped:", JSON.stringify(res.skipped));
console.log("\n" + readFileSync(res.path, "utf-8"));
