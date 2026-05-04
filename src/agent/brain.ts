import type { ProviderClient } from "./types";

export async function think(
  provider: ProviderClient,
  args: {
    task: string;
    history: string[];
    screenshotB64: string;
    screen: [number, number];
    signal?: AbortSignal;
  },
): Promise<string> {
  console.log(
    `[brain] → ${provider.name}.plan history=${args.history.length} screen=${args.screen[0]}x${args.screen[1]}`,
  );
  const { action, usage } = await provider.plan(args);
  console.log(
    `[brain] ← action="${action}"${usage ? ` usage=${JSON.stringify(usage)}` : ""}`,
  );
  return action;
}

const KEYBOARD_ONLY = /^(type\s+|press\s+|hotkey\s+|scroll\s+|wait\s+|done)/i;
export function needsCoordinates(action: string): boolean {
  return !KEYBOARD_ONLY.test(action.trim());
}

export function isDone(action: string): boolean {
  return /\bDONE\b/i.test(action);
}

/**
 * Recognize a drag action and split it into source + target descriptions.
 * Both endpoints are grounded separately so the model can describe each in
 * natural language ("drag the file to the trash") instead of returning two
 * coordinates pre-resolved.
 *
 * Accepted forms:
 *   drag X to Y
 *   drag from X to Y
 *   drag X onto Y
 *   drag and drop X to Y
 *
 * Returns null for non-drag actions so the caller can fall through to the
 * normal single-coord flow.
 */
export function parseDragAction(
  action: string,
): { from: string; to: string } | null {
  const m = action
    .trim()
    .match(/^drag(?:\s+and\s+drop)?\s+(?:from\s+)?(.+?)\s+(?:to|onto|into)\s+(.+?)\.?$/i);
  if (!m) return null;
  const from = m[1]?.trim();
  const to = m[2]?.trim();
  if (!from || !to) return null;
  return { from, to };
}
