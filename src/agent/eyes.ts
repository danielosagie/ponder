import type { ProviderClient } from "./types";

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
  console.log(
    `[eyes] ← (${r.x}, ${r.y})${r.raw ? ` raw=${JSON.stringify(r.raw)}` : ""}`,
  );
  return { x: r.x, y: r.y };
}
