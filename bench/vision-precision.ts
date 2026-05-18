#!/usr/bin/env tsx
/**
 * Vision precision bench — isolates the crop variable.
 *
 * Hypothesis (2026-05-13): vision-grounded clicks feel less accurate
 * than they used to, and the suspected cause is the targetApp crop
 * path in src/agent/loop.ts. This bench tests it empirically.
 *
 * For each test target:
 *   1. Take a screenshot (uncropped, full screen).
 *   2. Run provider.ground() on the UNCROPPED screenshot.
 *   3. Crop the screenshot to the target app's window bounds.
 *   4. Run provider.ground() on the CROPPED screenshot. Translate
 *      returned coords back into screen space.
 *   5. For each variant: compute distance from the expected button
 *      center (derived from the window bounds + a hardcoded button
 *      layout for the test app).
 *   6. Print a table: target | expected | uncropped | cropped |
 *      uncropped_err_px | cropped_err_px | uncropped_pass | cropped_pass.
 *
 * Bypasses the MCP server entirely — calls provider.ground via the
 * SDK so changes to recorder/tools.ts don't affect this measurement
 * AND no MCP restart is needed to test fixes to screen.ts / loop.ts.
 *
 * Usage:
 *   npx tsx bench/vision-precision.ts                          # default: calculator
 *   npx tsx bench/vision-precision.ts --case calculator        # explicit
 *   npx tsx bench/vision-precision.ts --runs 3                 # 3 grounds per target
 *   npx tsx bench/vision-precision.ts --skip-cropped            # uncropped only
 *   npx tsx bench/vision-precision.ts --save-shots /tmp/shots   # write screenshots
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { config as loadDotenv } from "dotenv";

// Load .env BEFORE factory imports — factory.ts reads env vars at
// construction time to pick a provider. Without this, the bench
// thinks no provider is configured even when .env has HAI_API_KEY
// or MODAL_BASE_URL set.
loadDotenv({ path: path.join(__dirname, "..", ".env") });
loadDotenv({ path: path.join(__dirname, "..", ".env.local"), override: false });

import {
  computeDefaultProvider,
  humanProviderLabel,
  isProviderConfigured,
  makeProvider,
} from "../src/agent/factory.js";
import * as screen from "../src/screen.js";
import type { ProviderClient } from "../src/agent/types.js";
import { cropAndScalePng, pngDimensions } from "../src/agent/imageops.js";

// Mirror eyes.ts refine defaults so the bench measures the SAME config
// the live loop would use under PONDER_GROUND_REFINE. Sweep these env
// vars to tune the box/scale and watch the `refined` column move.
const REFINE_BOX_LOGICAL = Number(process.env.PONDER_GROUND_REFINE_BOX ?? 320);
const REFINE_SCALE = Number(process.env.PONDER_GROUND_REFINE_SCALE ?? 2);

// ── Test cases ───────────────────────────────────────────────────────

interface ButtonTarget {
  /** Plain-English description fed to provider.ground. Match what
   *  an agent would actually say. */
  description: string;
  /** Grid cell [row, col] in the 4×5 Basic-Calculator keypad. The
   *  expected center is resolved at runtime from the macOS
   *  Accessibility tree (the REAL button frame) — not a hand-guessed
   *  fractional formula. The old formula assumed the keypad started
   *  right under a 28px title bar and spanned the whole window; the
   *  modern Calculator devotes the top ~40% to the result display, so
   *  that formula was off by ~90px at the top row and ~0 at the
   *  bottom (a linear ramp that made an accurate model score ~25%).
   *  AX gives ground truth and tracks the window if it moves. */
  cell: { row: number; col: number };
}

interface PrecisionCase {
  id: string;
  processName: string;
  /** Tolerance: a ground is "PASS" if it lands within this many
   *  pixels of the expected center. ~30px = half a typical button. */
  toleranceP: number;
  targets: ButtonTarget[];
}

/**
 * macOS Calculator (Basic mode) — confirmed 4×5 keypad via the AX tree
 * (20 uniform 48×48 AXButtons; window controls + toolbar excluded by
 * the size filter in axButtonGrid). Real layout:
 *
 *   col:  0    1    2    3
 *   row0: ⌫    AC   %    ÷
 *   row1: 7    8    9    ×
 *   row2: 4    5    6    −
 *   row3: 1    2    3    +
 *   row4: ±    0    .    =
 */
const CALCULATOR_CASE: PrecisionCase = {
  id: "calculator",
  processName: "Calculator",
  toleranceP: 30,
  targets: [
    { description: "the AC button on Calculator", cell: { row: 0, col: 1 } },
    { description: "the 7 button on Calculator", cell: { row: 1, col: 0 } },
    { description: "the 8 button on Calculator", cell: { row: 1, col: 1 } },
    { description: "the 9 button on Calculator", cell: { row: 1, col: 2 } },
    { description: "the × multiply button on Calculator", cell: { row: 1, col: 3 } },
    { description: "the 4 button on Calculator", cell: { row: 2, col: 0 } },
    { description: "the + plus button on Calculator", cell: { row: 3, col: 3 } },
    { description: "the = equals button on Calculator", cell: { row: 4, col: 3 } },
  ],
};

/**
 * Ground-truth keypad geometry, derived from a real Accessibility-tree
 * measurement of the live macOS Calculator (not a guessed formula).
 *
 * Why not query AX live every run: the modern Calculator is a Mac
 * Catalyst app whose keypad AXButtons live inside an opaque AXGroup
 * that System Events' `entire contents` only recurses into
 * intermittently (works when the tree is "warm" from prior
 * interaction, returns just the 3 window-control buttons otherwise).
 * That flakiness makes a wrong/empty oracle — worse than none.
 *
 * Instead: a one-time AX probe of the real keypad (window 230×408 at
 * (1226,457)) gave button centers at screen offsets
 *   x ∈ {34, 88, 142, 196}   (cols, 54px pitch)
 *   y ∈ {157, 211, 265, 319, 373}  (rows, 54px pitch)
 * i.e. fractions of the window box:
 *   xFrac = {0.148, 0.383, 0.617, 0.852}
 *   yFrac = {0.385, 0.517, 0.650, 0.782, 0.914}
 * These are measured truth, anchored to the LIVE window bounds (which
 * `getMacWindowBounds` returns reliably from any context), so the
 * oracle tracks the window if it moves and tolerates proportional
 * resize. Reproduces the probed centers to <1px.
 *
 * This replaces the original oracle that assumed the keypad started
 * under a 28px title bar and spanned the whole window — off by ~90px
 * at the top row, which made an accurate model score 25%.
 */
const KEYPAD_X_FRAC = [0.148, 0.383, 0.617, 0.852];
const KEYPAD_Y_FRAC = [0.385, 0.517, 0.65, 0.782, 0.914];

function keypadGrid(bounds: {
  x: number;
  y: number;
  width: number;
  height: number;
}): { x: number; y: number }[][] {
  return KEYPAD_Y_FRAC.map((yf) =>
    KEYPAD_X_FRAC.map((xf) => ({
      x: Math.round(bounds.x + xf * bounds.width),
      y: Math.round(bounds.y + yf * bounds.height),
    })),
  );
}

const CASES: Record<string, PrecisionCase> = {
  calculator: CALCULATOR_CASE,
};

// ── Arg parsing ──────────────────────────────────────────────────────

interface Args {
  caseId: string;
  runs: number;
  skipCropped: boolean;
  skipUncropped: boolean;
  skipRefined: boolean;
  saveShotsDir?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const a: Args = {
    caseId: "calculator",
    runs: 1,
    skipCropped: false,
    skipUncropped: false,
    skipRefined: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--case") a.caseId = argv[++i] ?? a.caseId;
    else if (arg === "--runs") a.runs = Math.max(1, parseInt(argv[++i] ?? "1", 10));
    else if (arg === "--skip-cropped") a.skipCropped = true;
    else if (arg === "--skip-uncropped") a.skipUncropped = true;
    else if (arg === "--skip-refined") a.skipRefined = true;
    else if (arg === "--save-shots") a.saveShotsDir = argv[++i];
  }
  return a;
}

// ── Crop helper ──────────────────────────────────────────────────────

/**
 * Crop a PNG buffer to the given rect using macOS's `sips` tool.
 *
 * The agent loop's maybeCropToTargetApp uses Electron's nativeImage,
 * which isn't available when running this bench from tsx (the
 * Electron module returns a path string, not the API, outside an
 * Electron process). `sips` is part of every macOS install and
 * produces the same pixel-perfect crop, so swapping primitives
 * doesn't muddy the precision measurement.
 *
 * `--cropToHeightWidth h w --cropOffset y x` is sips's left-handed
 * way of saying "crop the rect at (x,y) with size (w,h)".
 */
async function cropPng(
  pngBuffer: Buffer,
  rect: { x: number; y: number; width: number; height: number },
): Promise<Buffer> {
  const tmpIn = path.join(os.tmpdir(), `ponder-bench-in-${Date.now()}.png`);
  const tmpOut = path.join(os.tmpdir(), `ponder-bench-out-${Date.now()}.png`);
  await fsp.writeFile(tmpIn, pngBuffer);
  try {
    execFileSync(
      "/usr/bin/sips",
      [
        "--cropToHeightWidth",
        String(rect.height),
        String(rect.width),
        "--cropOffset",
        String(rect.y),
        String(rect.x),
        tmpIn,
        "--out",
        tmpOut,
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    return await fsp.readFile(tmpOut);
  } finally {
    await fsp.unlink(tmpIn).catch(() => {});
    await fsp.unlink(tmpOut).catch(() => {});
  }
}

// ── Run ──────────────────────────────────────────────────────────────

async function run(): Promise<number> {
  const args = parseArgs();
  const testCase = CASES[args.caseId];
  if (!testCase) {
    console.error(`unknown case: ${args.caseId}. known: ${Object.keys(CASES).join(", ")}`);
    return 2;
  }

  // 1. Provider sanity.
  const providerName = computeDefaultProvider();
  if (!isProviderConfigured(providerName)) {
    console.error(
      `Vision provider not configured. Provider would have been: ${humanProviderLabel(providerName)}.`,
    );
    console.error(
      `Set HAI_API_KEY (preferred) or MODAL_BASE_URL+MODAL_BEARER_TOKEN, or run Ollama with the holo3 model.`,
    );
    return 2;
  }
  const provider: ProviderClient = makeProvider(providerName);
  await provider.warm().catch((e) => {
    console.warn(`[warn] provider warmup failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
  });
  console.log(`[bench] provider: ${humanProviderLabel(providerName)}`);
  console.log(`[bench] case:     ${testCase.id} (target ${testCase.processName})`);
  console.log(`[bench] runs:     ${args.runs} per target per variant`);
  console.log("");

  // 2. Raise the target app + grab window bounds.
  const raised = await screen.raiseMacApp(testCase.processName);
  if (!raised) {
    console.warn(
      `[warn] raiseMacApp("${testCase.processName}") returned false — window may not be on a visible Space. ` +
        `Open ${testCase.processName} manually before re-running.`,
    );
  }
  // Wait for the raise to actually take effect.
  await screen.sleep(400);
  const bounds = await screen.getMacWindowBounds(testCase.processName);
  if (!bounds) {
    console.error(
      `getMacWindowBounds("${testCase.processName}") returned null. Is the app running and on a visible Space? Is the Holo3 Electron app running so the bridge has macOS Accessibility perms? Are perms granted at all?`,
    );
    return 2;
  }
  console.log(
    `[bench] window:   ${testCase.processName} at (${bounds.x}, ${bounds.y}) size ${bounds.width}×${bounds.height}`,
  );

  // Ground-truth keypad geometry, anchored to the live window bounds
  // (AX-measured proportions — see keypadGrid). Fixes the broken
  // hand-guessed oracle that made an accurate model score 25%.
  if (
    Math.abs(bounds.width - 230) > 60 ||
    Math.abs(bounds.height - 408) > 90
  ) {
    console.warn(
      `[bench] ⚠ Calculator window is ${bounds.width}×${bounds.height}, far from the ` +
        `default Basic 230×408 the keypad fractions were measured at. Results may skew — ` +
        `reset Calculator to Basic default size for a clean measurement.`,
    );
  }
  const axGrid = keypadGrid(bounds);
  console.log(
    `[bench] keypad oracle (AX-measured fractions @ live bounds): ` +
      `row0=${axGrid[0]!.map((c) => `${c.x},${c.y}`).join(" ")}`,
  );

  // 3. Capture the screenshot ONCE per run. We reuse the same bytes
  //    for both variants so any difference is purely the crop's doing.
  const results: Array<{
    target: string;
    expected: { x: number; y: number };
    uncropped?: { x: number; y: number; err: number; pass: boolean };
    cropped?: { x: number; y: number; err: number; pass: boolean };
    refined?: { x: number; y: number; err: number; pass: boolean };
  }> = [];

  for (let run = 0; run < args.runs; run++) {
    if (args.runs > 1) console.log(`\n[bench] === run ${run + 1}/${args.runs} ===`);
    // Route through the bridge first — it has macOS Accessibility +
    // Screen Recording perms granted (the user added the Electron
    // app in System Settings → Privacy → Accessibility). From a bare
    // tsx process, screen.screenshot() falls back to cursor's display
    // which is wrong when Calculator lives on a secondary display.
    let shot: screen.Screenshot;
    const bridgePort = Number(process.env.PONDER_BRIDGE_PORT ?? 7900);
    try {
      const res = await fetch(`http://127.0.0.1:${bridgePort}/screen/screenshot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (res.ok) {
        const j = (await res.json()) as {
          pngBase64: string;
          width: number;
          height: number;
          offsetX: number;
          offsetY: number;
        };
        shot = {
          png: Buffer.from(j.pngBase64, "base64"),
          width: j.width,
          height: j.height,
          offsetX: j.offsetX,
          offsetY: j.offsetY,
        };
        console.log(`[bench] shot via bridge (has perms)`);
      } else {
        throw new Error(`bridge HTTP ${res.status}`);
      }
    } catch (e) {
      console.warn(
        `[warn] bridge unreachable (${e instanceof Error ? e.message : String(e)}) — falling back to local screen.screenshot(). May capture the wrong display in multi-monitor setups.`,
      );
      shot = await screen.screenshot();
    }
    console.log(
      `[bench] shot: ${shot.width}×${shot.height} at display offset (${shot.offsetX}, ${shot.offsetY})`,
    );

    // Optional: dump the screenshots to disk for visual sanity.
    if (args.saveShotsDir) {
      await fsp.mkdir(args.saveShotsDir, { recursive: true });
      const uncroppedPath = path.join(args.saveShotsDir, `${testCase.id}-run${run + 1}-uncropped.png`);
      await fsp.writeFile(uncroppedPath, shot.png);
      console.log(`[bench] saved: ${uncroppedPath}`);
    }

    // Detect Retina mismatch: PNG byte dimensions vs reported logical
    // dimensions. captureViaDesktopCapturer historically reported
    // logical pixels in width/height while toPNG() encoded at native
    // (2x on Retina) — the cause of the cropped-region-wrong-place
    // vision regression. Bench measures the actual PNG to apply the
    // right scale.
    const pngDims = (() => {
      // PNG IHDR: bytes 16-19 = width, 20-23 = height (big-endian)
      const w = shot.png.readUInt32BE(16);
      const h = shot.png.readUInt32BE(20);
      return { w, h };
    })();
    const scaleX = pngDims.w / shot.width;
    const scaleY = pngDims.h / shot.height;
    if (scaleX !== 1 || scaleY !== 1) {
      console.log(
        `[bench] Retina detected: PNG is ${pngDims.w}×${pngDims.h} but reported ${shot.width}×${shot.height} (scale ${scaleX}×${scaleY}). Crop coords will scale.`,
      );
    }

    // Compute crop rect in PNG-pixel space (apply scale factor).
    const cropX = Math.round((bounds.x - shot.offsetX) * scaleX);
    const cropY = Math.round((bounds.y - shot.offsetY) * scaleY);
    const cropW = Math.round(bounds.width * scaleX);
    const cropH = Math.round(bounds.height * scaleY);
    const cropRect = { x: cropX, y: cropY, width: cropW, height: cropH };
    const cropFits =
      cropX >= 0 &&
      cropY >= 0 &&
      cropX + cropW <= pngDims.w &&
      cropY + cropH <= pngDims.h;
    if (!cropFits && !args.skipCropped) {
      console.warn(
        `[warn] crop rect ${cropW}×${cropH}@(${cropX},${cropY}) doesn't fit in PNG ${pngDims.w}×${pngDims.h} — cropped variant will be skipped.`,
      );
    }

    // Pre-crop the screenshot once.
    let croppedPng: Buffer | null = null;
    if (cropFits && !args.skipCropped) {
      croppedPng = await cropPng(shot.png, cropRect);
      if (args.saveShotsDir) {
        const croppedPath = path.join(args.saveShotsDir, `${testCase.id}-run${run + 1}-cropped.png`);
        await fsp.writeFile(croppedPath, croppedPng);
        console.log(`[bench] saved: ${croppedPath}`);
      }
    }

    // 4. For each target, ground both variants.
    for (let i = 0; i < testCase.targets.length; i++) {
      const t = testCase.targets[i]!;
      const cellCenter = axGrid[t.cell.row]?.[t.cell.col];
      if (!cellCenter || Number.isNaN(cellCenter.x)) {
        console.warn(
          `[warn] no AX cell for ${t.description} [r${t.cell.row}c${t.cell.col}] — skipping`,
        );
        continue;
      }
      const expected = { x: cellCenter.x, y: cellCenter.y };
      const row: typeof results[number] = { target: t.description, expected };

      if (!args.skipUncropped) {
        const r = await provider.ground({
          instruction: t.description,
          screenshotB64: shot.png.toString("base64"),
          screen: [shot.width, shot.height],
        });
        if (r.error) {
          console.warn(`[warn] uncropped ground failed for "${t.description}": ${r.error}`);
        } else {
          // Translate screenshot coords to screen-space for fair comparison.
          const screenX = r.x + shot.offsetX;
          const screenY = r.y + shot.offsetY;
          const err = Math.hypot(screenX - expected.x, screenY - expected.y);
          row.uncropped = {
            x: screenX,
            y: screenY,
            err,
            pass: err <= testCase.toleranceP,
          };
        }
      }

      if (croppedPng && !args.skipCropped) {
        const r = await provider.ground({
          instruction: t.description,
          screenshotB64: croppedPng.toString("base64"),
          screen: [bounds.width, bounds.height],
        });
        if (r.error) {
          console.warn(`[warn] cropped ground failed for "${t.description}": ${r.error}`);
        } else {
          // Translate cropped coords back to screen space.
          const screenX = r.x + bounds.x;
          const screenY = r.y + bounds.y;
          const err = Math.hypot(screenX - expected.x, screenY - expected.y);
          row.cropped = {
            x: screenX,
            y: screenY,
            err,
            pass: err <= testCase.toleranceP,
          };
        }
      }

      // Refined = coarse→fine: reuse the uncropped ground as the
      // coarse point (that IS what eyes.ts uses as coarse in the live
      // path), crop a tight box around it, upscale, ground again.
      // Falls back to a dedicated coarse ground if uncropped was
      // skipped so the variant still measures standalone.
      if (!args.skipRefined) {
        let coarse: { x: number; y: number } | null = row.uncropped
          ? { x: row.uncropped.x - shot.offsetX, y: row.uncropped.y - shot.offsetY }
          : null;
        if (!coarse) {
          const c = await provider.ground({
            instruction: t.description,
            screenshotB64: shot.png.toString("base64"),
            screen: [shot.width, shot.height],
          });
          if (!c.error) coarse = { x: c.x, y: c.y };
        }
        if (coarse) {
          const half = REFINE_BOX_LOGICAL / 2;
          const bx = Math.max(
            0,
            Math.min(coarse.x - half, shot.width - REFINE_BOX_LOGICAL),
          );
          const by = Math.max(
            0,
            Math.min(coarse.y - half, shot.height - REFINE_BOX_LOGICAL),
          );
          const boxW = Math.min(REFINE_BOX_LOGICAL, shot.width);
          const boxH = Math.min(REFINE_BOX_LOGICAL, shot.height);
          try {
            const pd = pngDimensions(shot.png);
            if (pd) {
              const sX = pd.width / shot.width;
              const sY = pd.height / shot.height;
              const zoomed = await cropAndScalePng(
                shot.png,
                { x: bx * sX, y: by * sY, w: boxW * sX, h: boxH * sY },
                REFINE_SCALE,
              );
              const fr = await provider.ground({
                instruction: t.description,
                screenshotB64: zoomed.toString("base64"),
                screen: [boxW, boxH],
              });
              if (!fr.error && fr.x >= 0 && fr.y >= 0 && fr.x < boxW && fr.y < boxH) {
                const screenX = bx + fr.x + shot.offsetX;
                const screenY = by + fr.y + shot.offsetY;
                const err = Math.hypot(screenX - expected.x, screenY - expected.y);
                row.refined = {
                  x: screenX,
                  y: screenY,
                  err,
                  pass: err <= testCase.toleranceP,
                };
              }
            }
          } catch (e) {
            console.warn(
              `[warn] refined ground failed for "${t.description}": ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
      }

      results.push(row);
    }
  }

  // 5. Render the comparison table.
  console.log("");
  console.log(`Tolerance: ±${testCase.toleranceP}px from expected center`);
  console.log("");
  const header =
    "target".padEnd(40) +
    "expected".padEnd(16) +
    "uncropped".padEnd(20) +
    "cropped".padEnd(20) +
    "refined".padEnd(20);
  console.log(header);
  console.log("-".repeat(header.length));
  let uncroppedPass = 0;
  let uncroppedTotal = 0;
  let croppedPass = 0;
  let croppedTotal = 0;
  let refinedPass = 0;
  let refinedTotal = 0;
  let uncroppedErrSum = 0;
  let croppedErrSum = 0;
  let refinedErrSum = 0;
  for (const r of results) {
    const exp = `(${Math.round(r.expected.x)},${Math.round(r.expected.y)})`;
    const u = r.uncropped
      ? `${r.uncropped.pass ? "✓" : "✗"} (${Math.round(r.uncropped.x)},${Math.round(r.uncropped.y)}) ${Math.round(r.uncropped.err)}px`
      : "—";
    const c = r.cropped
      ? `${r.cropped.pass ? "✓" : "✗"} (${Math.round(r.cropped.x)},${Math.round(r.cropped.y)}) ${Math.round(r.cropped.err)}px`
      : "—";
    const rf = r.refined
      ? `${r.refined.pass ? "✓" : "✗"} (${Math.round(r.refined.x)},${Math.round(r.refined.y)}) ${Math.round(r.refined.err)}px`
      : "—";
    console.log(
      r.target.padEnd(40) + exp.padEnd(16) + u.padEnd(20) + c.padEnd(20) + rf.padEnd(20),
    );
    if (r.uncropped) {
      uncroppedTotal++;
      uncroppedErrSum += r.uncropped.err;
      if (r.uncropped.pass) uncroppedPass++;
    }
    if (r.cropped) {
      croppedTotal++;
      croppedErrSum += r.cropped.err;
      if (r.cropped.pass) croppedPass++;
    }
    if (r.refined) {
      refinedTotal++;
      refinedErrSum += r.refined.err;
      if (r.refined.pass) refinedPass++;
    }
  }
  console.log("-".repeat(header.length));
  if (uncroppedTotal > 0) {
    console.log(
      `uncropped:  ${uncroppedPass}/${uncroppedTotal} (${Math.round((uncroppedPass / uncroppedTotal) * 100)}%)  mean_err=${Math.round(uncroppedErrSum / uncroppedTotal)}px`,
    );
  }
  if (croppedTotal > 0) {
    console.log(
      `cropped:    ${croppedPass}/${croppedTotal} (${Math.round((croppedPass / croppedTotal) * 100)}%)  mean_err=${Math.round(croppedErrSum / croppedTotal)}px`,
    );
  }
  if (refinedTotal > 0) {
    console.log(
      `refined:    ${refinedPass}/${refinedTotal} (${Math.round((refinedPass / refinedTotal) * 100)}%)  mean_err=${Math.round(refinedErrSum / refinedTotal)}px  [box=${REFINE_BOX_LOGICAL} scale=${REFINE_SCALE}]`,
    );
  }
  console.log("");

  // Save raw results to bench/results/ for later analysis.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const resultsDir = path.join(__dirname, "results");
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
  const resultsPath = path.join(resultsDir, `vision-precision-${testCase.id}-${stamp}.json`);
  await fsp.writeFile(
    resultsPath,
    JSON.stringify(
      {
        case: testCase.id,
        provider: providerName,
        bounds,
        runs: args.runs,
        tolerancePx: testCase.toleranceP,
        refineConfig: { boxLogical: REFINE_BOX_LOGICAL, scale: REFINE_SCALE },
        results,
        summary: {
          uncropped: {
            pass: uncroppedPass,
            total: uncroppedTotal,
            meanErrPx: uncroppedTotal > 0 ? uncroppedErrSum / uncroppedTotal : null,
          },
          cropped: {
            pass: croppedPass,
            total: croppedTotal,
            meanErrPx: croppedTotal > 0 ? croppedErrSum / croppedTotal : null,
          },
          refined: {
            pass: refinedPass,
            total: refinedTotal,
            meanErrPx: refinedTotal > 0 ? refinedErrSum / refinedTotal : null,
          },
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  console.log(`[bench] results: ${resultsPath}`);

  return 0;
}

run().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
