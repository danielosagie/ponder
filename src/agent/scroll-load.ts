/**
 * scrollToLoadAll — exhaust an infinite/virtual-scroll page so a subsequent
 * readText/extract captures ALL items, not just the first viewport. (FB
 * Marketplace, search results, feeds, etc. lazy-load on scroll; a fresh tab
 * shows ~15 of 25 listings until you scroll.)
 *
 * Scrolls down until the page's text stops growing for two consecutive passes
 * (loaded everything) or a hard cap is hit. Returns the final text length.
 */

import type { BrowserClient } from "./browser/types";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function scrollToLoadAll(
  browser: BrowserClient,
  opts: { maxScrolls?: number; settleMs?: number; stableRounds?: number } = {},
): Promise<number> {
  const maxScrolls = opts.maxScrolls ?? 15;
  const settle = opts.settleMs ?? 900;
  // How many consecutive no-growth passes before we call it done. >1 guards
  // against FALSE stops when a lazy batch renders slower than `settle` (a single
  // slow frame looked "stable" and dropped ~8 of 33 FB listings at settle=550).
  const stableRounds = opts.stableRounds ?? 2;
  let prevLen = 0;
  let stable = 0;
  for (let i = 0; i < maxScrolls; i++) {
    await browser.scrollPage("down", 3000).catch(() => {});
    await sleep(settle);
    const len = (await browser.readText().catch(() => "")).length;
    if (len <= prevLen) {
      if (++stable >= stableRounds) break; // text stopped growing → all loaded
    } else {
      stable = 0;
    }
    prevLen = Math.max(prevLen, len);
  }
  return prevLen;
}
