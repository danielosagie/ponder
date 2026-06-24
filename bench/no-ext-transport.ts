/**
 * No-extension Chrome transport — prototype + micro-benchmark.
 *
 * Proves the "Granola/Notion" model: launch the user's REAL installed Chrome
 * (channel:"chrome") with a dedicated Anorha profile dir, drive it directly
 * over CDP via Playwright. NO extension, NO Playwriter relay, NO green-icon
 * gesture. Logins live in the profile dir and persist across runs.
 *
 * Run:  node_modules/.bin/tsx bench/no-ext-transport.ts
 * Env:  NOEXT_KEEP_OPEN=0  → measure then exit (default keeps window open so
 *       you can log into your channels once).
 */
import { chromium, type BrowserContext, type Page } from "playwright-core";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

const PROFILE = path.join(os.homedir(), ".anorha", "chrome-profile");
const LOG = "/tmp/anorha-noext.log";

function log(line: string): void {
  process.stdout.write(line + "\n");
  try {
    fs.appendFileSync(LOG, line + "\n");
  } catch {
    /* best-effort */
  }
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = Date.now();
  const r = await fn();
  const ms = Date.now() - t0;
  return [r, ms];
}

async function main(): Promise<void> {
  try {
    fs.writeFileSync(LOG, "");
  } catch {
    /* ignore */
  }
  fs.mkdirSync(PROFILE, { recursive: true });
  const firstRun = fs.readdirSync(PROFILE).length === 0;

  log("── Anorha no-extension transport ──");
  log(`profile:   ${PROFILE}`);
  log(`first run: ${firstRun ? "yes (fresh profile — log in once)" : "no (profile already has sessions)"}`);

  // 1) LAUNCH — the user's installed Chrome, dedicated profile, no extension.
  const [ctx, tLaunch] = await timed<BrowserContext>("launch", () =>
    chromium.launchPersistentContext(PROFILE, {
      channel: "chrome",
      headless: false,
      viewport: null,
      // Strip the automation fingerprint so the window is indistinguishable
      // from a normal Chrome launch — no "Chrome is being controlled by
      // automated test software" banner, navigator.webdriver stays false.
      ignoreDefaultArgs: ["--enable-automation"],
      args: [
        "--no-first-run",
        "--no-default-browser-check",
        "--start-maximized",
        "--disable-blink-features=AutomationControlled",
      ],
    }),
  );
  const page: Page = ctx.pages()[0] ?? (await ctx.newPage());
  log(`launch:    ${tLaunch} ms  (one-time per session)`);

  // 2) PER-ACTION latency on a neutral page (no login needed) — this is the
  //    raw transport cost the agent pays on every step.
  const [, tGotoCold] = await timed("goto cold", () =>
    page.goto("https://example.com", { waitUntil: "domcontentloaded" }),
  );
  const gotoWarm: number[] = [];
  for (let i = 0; i < 3; i++) {
    const [, ms] = await timed("goto warm", () =>
      page.goto("https://example.com", { waitUntil: "domcontentloaded" }),
    );
    gotoWarm.push(ms);
  }
  const [linkCount, tQuery] = await timed("dom query", () => page.locator("a").count());
  const [, tEval] = await timed("evaluate", () => page.evaluate(() => document.title));
  const avgWarm = Math.round(gotoWarm.reduce((a, b) => a + b, 0) / gotoWarm.length);

  log("");
  log("per-action latency (direct CDP, no relay hop):");
  log(`  goto (cold):   ${tGotoCold} ms`);
  log(`  goto (warm):   ${avgWarm} ms avg  [${gotoWarm.join(", ")}]`);
  log(`  dom query:     ${tQuery} ms  (${linkCount} links)`);
  log(`  page.evaluate: ${tEval} ms`);

  // 3) REAL site — prove it reaches Facebook + report login state. Capture
  //    the real navigation error if any, and a screenshot of what rendered.
  let fbErr: string | null = null;
  const [, tFb] = await timed("goto fb", () =>
    page
      .goto("https://www.facebook.com/", { waitUntil: "load", timeout: 30000 })
      .then(() => {})
      .catch((e: unknown) => {
        fbErr = e instanceof Error ? e.message : String(e);
      }),
  );
  await page.waitForTimeout(2500);
  const url = page.url();
  const shot = "/tmp/anorha-fb.png";
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
  const bodyText = (await page.locator("body").innerText().catch(() => "")) || "";
  const loggedIn = /Your listings|active listing|Marketplace profile|What's on your mind/i.test(bodyText);
  log("");
  log(`facebook: ${tFb} ms → ${url}${fbErr ? `  ERR: ${fbErr}` : ""}`);
  log(`  body chars: ${bodyText.length}  | login form: ${/log in|password/i.test(bodyText) ? "yes" : "no"}`);
  log(`  logged in: ${loggedIn ? "YES (profile already authed)" : "no"}`);
  log(`  screenshot: ${shot}`);

  log("");
  log("VERDICT: drove your installed Chrome with zero extension, zero gesture.");
  log("Setup cost: one login per channel, persisted in the profile forever.");

  const keepOpen = process.env.NOEXT_KEEP_OPEN !== "0";
  if (keepOpen) {
    log("");
    log("→ This Anorha Chrome window is staying open. Log into Facebook/Google here once.");
    log("  (kill the process to close it)");
    await new Promise<void>(() => {
      /* keep alive */
    });
  } else {
    await ctx.close();
  }
}

main().catch((e) => {
  log(`ERROR: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
