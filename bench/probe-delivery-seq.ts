/** Deterministic click-delivery probe: clicks 4,7,×,8,= at fixed oracle
 *  coords (no model), capturing the window after each. Variant B adds a
 *  mouse-move before each click (SwiftUI hover-state hypothesis). */
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: path.join(__dirname, "..", ".env") });
async function main(): Promise<void> {
  const screen = await import("../src/screen");
  await screen.raiseMacApp("Calculator");
  await screen.sleep(500);
  const w = await screen.captureWindowDirect("Calculator");
  if (!w) { console.log("no window"); process.exit(2); }
  const ox = w.offsetX, oy = w.offsetY;
  // local oracle (230x408 layout): 4=(33,265) 7=(33,211) ×=(196,211) 8=(86,211) ==(201,368)
  const seq: Array<[string, number, number]> = [
    ["4", 33, 265], ["7", 33, 211], ["x", 196, 211], ["8", 86, 211], ["=", 201, 368],
  ];
  for (const variant of ["plain", "move-first"] as const) {
    // clear: esc esc
    execFileSync("/usr/bin/osascript", ["-e", 'tell application "System Events" to key code 53'], {});
    await screen.sleep(300);
    execFileSync("/usr/bin/osascript", ["-e", 'tell application "System Events" to key code 53'], {});
    await screen.sleep(400);
    let prev = (await screen.captureWindowDirect("Calculator"))!.png;
    let registered = 0;
    for (const [label, lx, ly] of seq) {
      const x = ox + lx, y = oy + ly;
      if (variant === "move-first") {
        execFileSync("/opt/homebrew/bin/cliclick", [`m:${x},${y}`, "w:120", `c:${x},${y}`], {});
      } else {
        execFileSync("/opt/homebrew/bin/cliclick", [`c:${x},${y}`], {});
      }
      await screen.sleep(900);
      const cur = (await screen.captureWindowDirect("Calculator"))!.png;
      const changed = !cur.equals(prev);
      if (changed) registered++;
      console.log(`${variant} click ${label} @(${x},${y}): ${changed ? "registered" : "NO CHANGE"}`);
      prev = cur;
    }
    console.log(`${variant}: ${registered}/${seq.length} registered\n`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
