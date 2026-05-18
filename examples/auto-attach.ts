/**
 * examples/auto-attach.ts
 *
 * The simplest possible Ponder consumer: call ensureAttached, then
 * drive a real Playwright Page bound to the user's Chrome. No recipe,
 * no recorder — just "give me a page."
 *
 * Run with:  npx tsx examples/auto-attach.ts
 */

import { ensureAttached, connectToUserChrome } from "../src/cli/sdk";

async function main(): Promise<void> {
  await ensureAttached({ url: "https://example.com" });

  const { page, close } = await connectToUserChrome();
  try {
    await page.goto("https://example.com");
    const heading = await page.getByRole("heading").first().textContent();
    console.log(`Heading: ${heading ?? "(none)"}`);

    const linkCount = await page.getByRole("link").count();
    console.log(`Links on page: ${linkCount}`);
  } finally {
    await close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
