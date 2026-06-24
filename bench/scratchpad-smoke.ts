/**
 * Smoke test for src/agent/scratchpad.ts — durable working memory for long tasks.
 * Verifies row dedupe, facts, done-tracking, and a persist→resume round-trip.
 *
 * Run: tsx bench/scratchpad-smoke.ts
 */
import { Scratchpad } from "../src/agent/scratchpad";
import { unlinkSync } from "node:fs";

const RUN = "zzz-scratchpad-smoke-9f3a";

let failed = false;
const check = (name: string, cond: boolean): void => {
  console.log(`  ${cond ? "OK " : "FAIL"}  ${name}`);
  if (!cond) failed = true;
};

const pad = Scratchpad.create("smoke goal", RUN);
check("addRows returns new count", pad.addRows([["Item", "$30"], ["Car", "$2500"]], ["Name", "Price"]) === 2);
check("addRows dedupes", pad.addRows([["Item", "$30"]]) === 0);
check("rows accumulated", pad.rows.length === 2);
pad.put("sheetUrl", "https://docs.google.com/x");
pad.markDone("subtask-1", "done", "extracted 2 rows");
check("isDone true", pad.isDone("subtask-1"));
check("isDone false for unknown", !pad.isDone("subtask-2"));

// Resume from disk — simulates a crash + restart.
const resumed = Scratchpad.load(RUN);
check("resume loads", resumed !== null);
check("resume keeps rows", resumed?.rows.length === 2);
check("resume keeps facts", resumed?.get("sheetUrl") === "https://docs.google.com/x");
check("resume keeps done", !!resumed?.isDone("subtask-1"));
check("resume re-dedupes", resumed?.addRows([["Item", "$30"]]) === 0);
check("resume adds genuinely-new", resumed?.addRows([["Sink", "$300"]]) === 1);

check("open() resumes existing", Scratchpad.open("smoke goal", RUN).resumed === true);

try { unlinkSync(pad.path); } catch { /* ignore */ }
check("gone after delete", Scratchpad.load(RUN) === null);

console.log(failed ? "\nSCRATCHPAD SMOKE: FAILED" : "\nSCRATCHPAD SMOKE: ALL OK");
process.exit(failed ? 1 : 0);
