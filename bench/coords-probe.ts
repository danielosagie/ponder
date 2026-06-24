/**
 * Coords probe — settle pixel-vs-normalized with ONE Holo call (robust to the
 * flaky API). Loads example.com, asks Holo for the click point of the single
 * "More information..." link, clicks it, then checks page.url() — a deterministic
 * verdict that needs no second brain call. example.com's link navigates to
 * iana.org, so: landed on iana.org = the click hit = that coord mode is correct.
 *
 * Run: node_modules/.bin/tsx bench/coords-probe.ts [--norm]
 */
import { chromium } from "playwright-core";
import { config as loadEnv } from "dotenv";
import * as path from "node:path";
import * as os from "node:os";
loadEnv({ path: path.join(__dirname, "..", ".env") });

const KEY = process.env.HAI_API_KEY ?? "";
const MODEL = process.env.HCOMPANY_MODEL ?? "holo3-1-35b-a3b";
const VW = 1280, VH = 800;
const NORM = process.argv.includes("--norm");
const log = (s: string) => process.stdout.write(s + "\n");

async function ground(shotB64: string): Promise<{ x: number; y: number; raw: string }> {
  const note = NORM ? "normalized 0-1000 (top-left origin)" : `PIXELS in the ${VW}x${VH} screenshot`;
  const prompt = `Return ONLY JSON {"x":int,"y":int} for the CENTER of the "More information..." link on this page. Coordinates are ${note}. No prose.`;
  const body = { model: MODEL, temperature: 0, max_tokens: 60, chat_template_kwargs: { enable_thinking: false },
    messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${shotB64}` } }, { type: "text", text: prompt }] }] };
  for (let attempt = 1; attempt <= 4; attempt++) {
    const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 35000);
    try {
      const r = await fetch("https://api.hcompany.ai/v1/chat/completions", { method: "POST", signal: ac.signal, headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      clearTimeout(to);
      if (!r.ok) { if (attempt < 4) { await new Promise(s => setTimeout(s, 800 * attempt)); continue; } throw new Error(`HTTP ${r.status}`); }
      const j = await r.json(); const c = j?.choices?.[0]?.message?.content ?? "{}"; const m = c.match(/\{[\s\S]*?\}/);
      const o = m ? JSON.parse(m[0]) : {}; return { x: o.x, y: o.y, raw: c.slice(0, 80) };
    } catch (e: any) { clearTimeout(to); if (attempt >= 4) throw e; await new Promise(s => setTimeout(s, 800 * attempt)); }
  }
  throw new Error("unreachable");
}

async function main() {
  if (!KEY) { log("no HAI_API_KEY"); process.exit(1); }
  log(`── coords probe (${NORM ? "normalized" : "pixel"} mode) ──`);
  const ctx = await chromium.launchPersistentContext(path.join(os.homedir(), ".anorha", "coords-profile"), {
    channel: "chrome", headless: false, viewport: { width: VW, height: VH },
    ignoreDefaultArgs: ["--enable-automation"], args: ["--no-first-run", "--no-default-browser-check"],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto("https://example.com", { waitUntil: "load", timeout: 30000 });
  const shotBuf = await page.screenshot({ type: "png" });
  const shot = shotBuf.toString("base64");
  const sw = shotBuf.readUInt32BE(16), sh = shotBuf.readUInt32BE(20);
  log(`screenshot actual dims: ${sw}x${sh}  (viewport ${VW}x${VH}, scale ${(sw / VW).toFixed(2)}x)`);
  // Ground truth: where IS the link, per the DOM? (independent of Holo)
  const box = await page.locator("a").first().boundingBox();
  if (box) log(`DOM truth: 'More information...' link center ≈ (${Math.round(box.x + box.width / 2)},${Math.round(box.y + box.height / 2)}) in CSS px`);
  let g; try { g = await ground(shot); } catch (e: any) { log(`brain unreachable: ${e?.message ?? e}`); await ctx.close(); process.exit(1); }
  const px = NORM ? Math.round((g.x / 1000) * VW) : g.x;
  const py = NORM ? Math.round((g.y / 1000) * VH) : g.y;
  log(`holo said: x=${g.x} y=${g.y}  →  click px=(${px},${py})  [raw: ${g.raw}]`);
  await page.mouse.click(px, py);
  await page.waitForTimeout(2500);
  const url = page.url();
  const hit = /iana\.org/i.test(url);
  log(`\nfinal url: ${url}`);
  log(`VERDICT: ${hit ? `✅ CLICK HIT — ${NORM ? "normalized" : "pixel"} coords are CORRECT` : `❌ MISS (still on ${url}) — wrong coord mode or off-target`}`);
  await ctx.close().catch(() => {});
  process.exit(hit ? 0 : 2);
}
main().catch(e => { log(`FATAL: ${e?.stack ?? e}`); process.exit(1); });
