/**
 * Smoke test for src/agent/export.ts (the bulk-write half of a data task).
 * Verifies CSV escaping, TSV, file write, and a clipboard round-trip.
 * Saves + restores the OS clipboard so it doesn't clobber the user's.
 *
 * Run: tsx bench/export-smoke.ts
 */
import { toCsv, toTsv, writeCsvFile, copyToClipboard } from "../src/agent/export";
import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";

const table = {
  headers: ["Item", "Price", "Status"],
  rows: [
    ["Pokémon Bulbasaur Card", "$30", "Sold"],
    ["1998 Honda CR-V", "$2,500", "Sold"], // comma must be quoted in CSV
    ['Chest Freezer "17.5 cu ft"', "$300", "Active"], // quotes must be doubled
  ],
};

let failed = false;
const check = (name: string, cond: boolean): void => {
  console.log(`  ${cond ? "OK " : "FAIL"}  ${name}`);
  if (!cond) failed = true;
};

const csv = toCsv(table);
console.log("--- CSV ---\n" + csv + "\n");
check("CSV quotes a comma field", csv.includes('"$2,500"'));
check("CSV doubles embedded quotes", csv.includes('""17.5 cu ft""'));
check("CSV has header + 3 rows", csv.split("\n").length === 4);

const tsv = toTsv(table);
console.log("\n--- TSV ---\n" + tsv + "\n");
check("TSV is tab-separated", tsv.includes("\t"));
check("TSV has 4 lines", tsv.split("\n").length === 4);

const path = writeCsvFile(table, "/tmp/holo3-export-smoke.csv");
const back = readFileSync(path, "utf-8");
check("CSV file written + readable", back === csv);
unlinkSync(path);

if (process.platform === "darwin") {
  const prev = execFileSync("pbpaste").toString(); // save user's clipboard
  try {
    copyToClipboard(tsv);
    const pasted = execFileSync("pbpaste").toString();
    check("clipboard round-trip matches TSV", pasted.replace(/\s+$/, "") === tsv);
  } finally {
    copyToClipboard(prev); // restore
  }
  check("clipboard restored", execFileSync("pbpaste").toString() === prev);
}

console.log(failed ? "\nEXPORT SMOKE: FAILED" : "\nEXPORT SMOKE: ALL OK");
process.exit(failed ? 1 : 0);
