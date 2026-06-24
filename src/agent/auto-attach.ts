/**
 * Zero-touch Playwriter attach — the AGENT clicks the extension icon itself.
 *
 * Playwriter (chrome.debugger) needs a per-tab user gesture to attach, and the
 * user has ruled out debug ports. So instead of asking the human to click the
 * green icon, holo3-agent does it: raise Chrome → screenshot → vision-ground
 * the Playwriter toolbar icon → cliclick it (background mode) → wait for the
 * relay to attach. Reuses the exact grounding stack agent_click uses.
 *
 * No debug port, no human gesture. (The durable path is a content-script
 * auto-connect extension; this makes the already-installed Playwriter hands-off.)
 */

import * as screen from "../screen";
import { makeProvider, computeDefaultProvider } from "./factory";
import type { BrowserClient } from "./browser/types";

export interface AutoAttachResult {
  attached: boolean;
  note: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Ensure the relay is attached, vision-clicking the Playwriter icon if not.
 * `browser` must already be a started relay client (createPlaywriterClient).
 */
export async function autoAttachPlaywriter(
  browser: BrowserClient,
  opts: { tries?: number } = {},
): Promise<AutoAttachResult> {
  if (await browser.available().catch(() => false)) {
    return { attached: true, note: "already attached" };
  }

  // Bring Chrome to the front so the toolbar (and its icons) are visible.
  await screen.raiseMacApp("Google Chrome").catch(() => {});
  await sleep(700);

  let provider;
  try {
    provider = makeProvider(computeDefaultProvider());
    await provider.warm?.().catch(() => {});
  } catch (e) {
    return { attached: false, note: `no grounding provider: ${(e as Error).message}` };
  }

  const tries = opts.tries ?? 3;
  const instructions = [
    "the Playwriter browser-extension icon in Chrome's top-right toolbar (a small toolbar icon near the address bar / profile avatar)",
    "the green Playwriter extension icon in the browser toolbar",
    "the extensions puzzle-piece icon at the top-right of the Chrome toolbar",
  ];

  for (let i = 0; i < tries; i++) {
    const shot = await screen.screenshot();
    const r = await provider
      .ground({
        instruction: instructions[Math.min(i, instructions.length - 1)]!,
        screenshotB64: shot.png.toString("base64"),
        screen: [shot.width, shot.height],
      })
      .catch(() => null);
    if (r && !r.error) {
      await screen.click(r.x + shot.offsetX, r.y + shot.offsetY).catch(() => {});
      await sleep(1600);
      const page = await browser.rawPage?.().catch(() => null);
      if (page || (await browser.available().catch(() => false))) {
        return { attached: true, note: `vision-clicked the icon (try ${i + 1})` };
      }
    }
  }
  return {
    attached: await browser.available().catch(() => false),
    note: "could not confirm attach after vision clicks — icon may be hidden in the overflow menu",
  };
}
