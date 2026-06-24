import type { ProviderClient } from "./types";
import { cropAndScalePng, pngDimensions } from "./imageops";

/**
 * Coarse→fine grounding (opt-in, env-gated).
 *
 * Ground once for a rough point, crop a tight box around it, UPSCALE
 * that box (more pixels for the same widget), and ground again with
 * the target shown large.
 *
 * HISTORY — the 0/8 verdict was a tooling artifact, not a model limit.
 * The 2026-05-18 bench scored refine 0/8 (~76px mean error) and
 * NEXT-WORK declared it a dead end. Root cause found 2026-06-10:
 * imageops.cropAndScalePng combined --cropToHeightWidth and
 * --resampleHeightWidth in ONE sips invocation, which emits a mangled
 * image (a 460×816 crop came back 70×339) — the model was grounding
 * garbage pixels. With the two-invocation fix, the same bench scores
 * refined 8/8 at ~1px mean error — the MOST precise grounding mode
 * measured (uncropped ~3px, window-crop ~6px).
 *
 * Still default OFF because it costs one extra ground call per click
 * and base grounding is already ~3-6px (well inside any button).
 * Enable PONDER_GROUND_REFINE=1 for surfaces with genuinely tiny
 * targets (dense toolbars, small text links) where ±5px matters. Any
 * failure inside the fine pass falls back to the coarse coord —
 * refinement can only help, never strand a step.
 */
function refineEnabled(): boolean {
  const v = (process.env.PONDER_GROUND_REFINE ?? "").toLowerCase();
  return v === "1" || v === "on" || v === "true";
}
const REFINE_BOX_LOGICAL = Number(process.env.PONDER_GROUND_REFINE_BOX ?? 320);
const REFINE_SCALE = Number(process.env.PONDER_GROUND_REFINE_SCALE ?? 2);

export async function findCoordinates(
  provider: ProviderClient,
  args: {
    instruction: string;
    screenshotB64: string;
    screen: [number, number];
    signal?: AbortSignal;
  },
  opts?: {
    /**
     * Force the coarse→fine refine pass for THIS call regardless of the
     * PONDER_GROUND_REFINE env default. Used by the loop's retry path:
     * when the brain re-emits the same action (suspected misclick), the
     * second attempt is worth the extra ground call — refine measured
     * 8/8 ~1px vs ~3-6px coarse on the 2026-06-10 bench.
     */
    refine?: boolean;
  },
): Promise<{ x: number; y: number } | null> {
  console.log(`[eyes] → ${provider.name}.ground "${args.instruction}"`);
  const r = await provider.ground(args);
  if (r.error) {
    console.warn(`[eyes] ← error: ${r.error}`);
    return null;
  }
  const [w, h] = args.screen;
  if (r.x < 0 || r.y < 0 || r.x >= w || r.y >= h) {
    console.warn(`[eyes] ← out-of-bounds (${r.x}, ${r.y}) for ${w}x${h}`);
    return null;
  }
  const coarse = { x: r.x, y: r.y };
  console.log(
    `[eyes] ← (${coarse.x}, ${coarse.y})${r.raw ? ` raw=${JSON.stringify(r.raw)}` : ""}`,
  );

  if (!(opts?.refine === true || refineEnabled())) return coarse;
  try {
    const refined = await refine(provider, args, coarse, [w, h]);
    if (refined) {
      console.log(
        `[eyes] ⊕ refined (${coarse.x},${coarse.y}) → (${refined.x},${refined.y})`,
      );
      return refined;
    }
  } catch (e) {
    console.warn(
      `[eyes] refine failed (${e instanceof Error ? e.message : String(e)}) — using coarse`,
    );
  }
  return coarse;
}

/**
 * Second grounding pass on an upscaled crop around the coarse point.
 * Returns a coord in the SAME logical screen space as `coarse`, or
 * null if anything about the fine pass is untrustworthy (caller then
 * keeps the coarse coord).
 */
async function refine(
  provider: ProviderClient,
  args: {
    instruction: string;
    screenshotB64: string;
    screen: [number, number];
    signal?: AbortSignal;
  },
  coarse: { x: number; y: number },
  [w, h]: [number, number],
): Promise<{ x: number; y: number } | null> {
  // Domain guard (2026-06-10, measured live): refine exists for FULL
  // frames where the target occupies few pixels. On a window CROP the
  // target is already large and native-res — upscaling it another 2×
  // hands the model 4× blur, which it mis-grounds (observed: coarse
  // (29,258) = the correct "4" button, refined → (34,298) = the "1"
  // button, repeatedly, while the same refine scores 8/8 ~1px on full
  // frames). Decline when the source's smallest side isn't comfortably
  // larger than the refine box; the coarse answer stands.
  if (Math.min(w, h) < REFINE_BOX_LOGICAL * 1.5) {
    console.log(
      `[eyes] refine skipped: source ${w}x${h} is already a zoomed view (box=${REFINE_BOX_LOGICAL}) — keeping coarse`,
    );
    return null;
  }
  const png = Buffer.from(args.screenshotB64, "base64");
  const dims = pngDimensions(png);
  if (!dims) return null;

  // PNG may be Retina (2x logical). All crop math is in PNG pixels;
  // ground I/O stays in logical screen units.
  const scaleX = dims.width / w;
  const scaleY = dims.height / h;

  // Logical box centered on the coarse point, clamped to the screen.
  const half = REFINE_BOX_LOGICAL / 2;
  const bx = Math.max(0, Math.min(coarse.x - half, w - REFINE_BOX_LOGICAL));
  const by = Math.max(0, Math.min(coarse.y - half, h - REFINE_BOX_LOGICAL));
  const boxW = Math.min(REFINE_BOX_LOGICAL, w);
  const boxH = Math.min(REFINE_BOX_LOGICAL, h);

  const cropped = await cropAndScalePng(
    png,
    {
      x: bx * scaleX,
      y: by * scaleY,
      w: boxW * scaleX,
      h: boxH * scaleY,
    },
    REFINE_SCALE,
  );

  // Declare the crop's LOGICAL size as the ground screen — the upscale
  // just gives the model more pixels for the same logical region, so
  // returned coords are already in box-logical space (same trick the
  // bench's cropped variant uses).
  const f = await provider.ground({
    instruction: args.instruction,
    screenshotB64: cropped.toString("base64"),
    screen: [boxW, boxH],
    signal: args.signal,
  });
  if (f.error) return null;
  if (f.x < 0 || f.y < 0 || f.x >= boxW || f.y >= boxH) return null;

  const fx = bx + f.x;
  const fy = by + f.y;
  if (fx < 0 || fy < 0 || fx >= w || fy >= h) return null;
  return { x: Math.round(fx), y: Math.round(fy) };
}
