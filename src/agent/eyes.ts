import type { ProviderClient } from "./types";
import { cropAndScalePng, pngDimensions } from "./imageops";

/**
 * Coarse→fine grounding (opt-in, env-gated).
 *
 * The vision-precision bench (2026-05-13) showed ~25% top-1 hit and
 * ~55px mean error on a SIMPLE Calculator, and that cropping to the
 * window barely helped. The hypothesis this implements: the model
 * localizes the rough region fine, but loses precision because dense
 * UI occupies few pixels. So: ground once for a rough point, crop a
 * tight box around it, UPSCALE that box (more pixels for the same
 * widget), and ground again. The second pass sees the target large.
 *
 * Default OFF. It is a behavior change to the live loop that cannot be
 * validated from a dev box without Modal + a real desktop; shipping it
 * default-on would risk regressing the loop the user depends on. Flip
 * PONDER_GROUND_REFINE=1 to measure it via bench/vision-precision.ts
 * (which has a matching `refined` column), then make it default if it
 * wins. Any failure inside the fine pass falls back to the coarse
 * coord — refinement can only help, never strand a step.
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

  if (!refineEnabled()) return coarse;
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
