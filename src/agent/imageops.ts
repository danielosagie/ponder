/**
 * Tiny PNG crop+scale via macOS `sips`.
 *
 * Why sips and not sharp/jimp/nativeImage:
 *   • No new dependency (sips ships with every macOS install).
 *   • Works in BOTH contexts that need it — the Electron main process
 *     (the agent loop) AND a bare `tsx` process (bench/vision-precision.ts
 *     already proved this exact approach). Electron's nativeImage is
 *     unavailable outside an Electron process; sips is not.
 *   • Pixel-identical crop to what the bench measures, so a precision
 *     improvement seen in the bench transfers to the live loop unchanged.
 *
 * Cost: one `sips` fork per call (~20-60ms). The coarse→fine ground path
 * uses it once per refined step, behind an env flag, so the cost only
 * lands when the operator opts in to test it.
 */
import { execFile } from "node:child_process";
import { writeFile, readFile, unlink } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** Read a PNG's pixel dimensions from its IHDR chunk (bytes 16-23,
 *  big-endian). Cheap — no decode. Returns null if the buffer isn't a
 *  PNG (too short / bad signature) so callers can fall back instead of
 *  throwing mid-ground. */
export function pngDimensions(
  buf: Buffer,
): { width: number; height: number } | null {
  // 8-byte signature + 4 len + "IHDR" + width@16 + height@20.
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47) return null; // ‰PNG
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function execFileP(cmd: string, argv: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, argv, { timeout: 15_000 }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
}

/**
 * Crop `png` to `rect` (in PNG-pixel space) then resample the result by
 * `scale` (e.g. 2 = double the pixels).
 *
 * MUST be two sips invocations (2026-06-10): combining
 * `--cropToHeightWidth` and `--resampleHeightWidth` in one call makes
 * sips emit a mangled image (measured: a 460×816 crop + same-size
 * resample returned 70×339). Crop first; resample only when scale≠1.
 * This single-invocation bug is also a suspect in the eyes.ts refine
 * experiment scoring 0/8.
 *
 * `scale === 1` is a pure crop. The returned buffer is PNG bytes at
 * `rect.w*scale × rect.h*scale`.
 *
 * Rect is clamped to the image so a coarse coord near an edge can't
 * produce an out-of-bounds crop that sips would reject.
 */
export async function cropAndScalePng(
  png: Buffer,
  rect: { x: number; y: number; w: number; h: number },
  scale: number,
): Promise<Buffer> {
  const dims = pngDimensions(png);
  if (!dims) throw new Error("cropAndScalePng: not a PNG buffer");

  const x = Math.max(0, Math.min(Math.round(rect.x), dims.width - 1));
  const y = Math.max(0, Math.min(Math.round(rect.y), dims.height - 1));
  const w = Math.max(1, Math.min(Math.round(rect.w), dims.width - x));
  const h = Math.max(1, Math.min(Math.round(rect.h), dims.height - y));
  const outW = Math.max(1, Math.round(w * scale));
  const outH = Math.max(1, Math.round(h * scale));

  const tag = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tmpIn = path.join(os.tmpdir(), `ponder-imgops-in-${tag}.png`);
  const tmpOut = path.join(os.tmpdir(), `ponder-imgops-out-${tag}.png`);
  await writeFile(tmpIn, png);
  try {
    // --cropToHeightWidth H W --cropOffset Y X  is sips's left-handed
    // way of saying "crop the rect (X,Y,W,H)".
    await execFileP("/usr/bin/sips", [
      "--cropToHeightWidth",
      String(h),
      String(w),
      "--cropOffset",
      String(y),
      String(x),
      tmpIn,
      "--out",
      tmpOut,
    ]);
    if (outW !== w || outH !== h) {
      // Separate invocation — see header comment for why these flags
      // cannot share one sips call. In-place edit of the crop output.
      await execFileP("/usr/bin/sips", [
        "--resampleHeightWidth",
        String(outH),
        String(outW),
        tmpOut,
      ]);
    }
    return await readFile(tmpOut);
  } finally {
    await unlink(tmpIn).catch(() => {});
    await unlink(tmpOut).catch(() => {});
  }
}
