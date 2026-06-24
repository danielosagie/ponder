/** Deterministic test of parseResult's truncated-JSON salvage. No model/network.
 *  Run: tsx bench/extract-salvage-smoke.ts */
import { parseResult } from "../src/agent/extract";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}

// 1. Clean JSON parses normally.
{
  const r = parseResult('{"headers":["A","B"],"rows":[["1","2"],["3","4"]]}');
  check("clean: 2 rows", r.rows.length === 2 && r.headers.join() === "A,B");
}

// 2. Truncated mid-last-row → recover the complete rows, drop the partial one.
{
  const raw = '{"headers":["Title","Price"],"rows":[["Couch","$50"],["Table","$30"],["Lamp","$2';
  const r = parseResult(raw);
  check("truncated: headers recovered", r.headers.join() === "Title,Price", JSON.stringify(r.headers));
  check("truncated: 2 complete rows kept", r.rows.length === 2, `got ${r.rows.length}`);
  check("truncated: data correct", r.rows[1]?.[0] === "Table" && r.rows[1]?.[1] === "$30");
}

// 3. Strings containing brackets/commas don't break the scanner.
{
  const raw = '{"headers":["Name"],"rows":[["a [boxed], item"],["b, [2]"],["c';
  const r = parseResult(raw);
  check("bracket-in-string: 2 rows", r.rows.length === 2, `got ${r.rows.length}`);
  check("bracket-in-string: value intact", r.rows[0]?.[0] === "a [boxed], item", r.rows[0]?.[0]);
}

// 4. Escaped quotes inside a cell survive salvage.
{
  const raw = '{"headers":["Q"],"rows":[["she said \\"hi\\""],["next';
  const r = parseResult(raw);
  check("escaped-quote: 1 row", r.rows.length === 1, `got ${r.rows.length}`);
  check("escaped-quote: value intact", r.rows[0]?.[0] === 'she said "hi"', r.rows[0]?.[0]);
}

// 5. Code-fenced clean JSON still parses (fence stripping).
{
  const r = parseResult('```json\n{"headers":["X"],"rows":[["1"]]}\n```');
  check("fenced: 1 row", r.rows.length === 1 && r.headers[0] === "X");
}

console.log(`\n${fail === 0 ? "=== PASS" : "=== FAIL"} — ${pass} ok, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
