/** Variant tuning: which cliclick recipe registers 5/5 on SwiftUI Calculator? */
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: path.join(__dirname, "..", ".env") });
async function main(): Promise<void> {
  const screen = await import("../src/screen");
  await screen.raiseMacApp("Calculator");
  await screen.sleep(500);
  const w = (await screen.captureWindowDirect("Calculator"))!;
  const ox = w.offsetX, oy = w.offsetY;
  const seq: Array<[string, number, number]> = [
    ["4", 33, 265], ["7", 33, 211], ["x", 196, 211], ["8", 86, 211], ["=", 201, 368],
  ];
  const variants: Array<[string, (x: number, y: number) => string[]]> = [
    ["move-w200-click", (x, y) => [`m:${x},${y}`, "w:200", `c:${x},${y}`]],
    ["move-down-up", (x, y) => [`m:${x},${y}`, "w:100", `dd:${x},${y}`, "w:90", `du:${x},${y}`]],
  ];
  for (const [name, args] of variants) {
    for (const r of [1, 2]) {
      execFileSync("/usr/bin/osascript", ["-e", 'tell application "System Events" to key code 53'], {});
      await screen.sleep(300);
      execFileSync("/usr/bin/osascript", ["-e", 'tell application "System Events" to key code 53'], {});
      await screen.sleep(400);
      let prev = (await screen.captureWindowDirect("Calculator"))!.png;
      let reg = 0;
      const misses: string[] = [];
      for (const [label, lx, ly] of seq) {
        execFileSync("/opt/homebrew/bin/cliclick", args(ox + lx, oy + ly), {});
        await screen.sleep(900);
        const cur = (await screen.captureWindowDirect("Calculator"))!.png;
        if (!cur.equals(prev)) reg++; else misses.push(label);
        prev = cur;
      }
      console.log(`${name} round${r}: ${reg}/5${misses.length ? ` (missed: ${misses.join(",")})` : ""}`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
