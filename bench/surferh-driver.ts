/**
 * Drive the REAL HoloTab brain (Surfer H, via H Company AgP, EU region) in a
 * browser and measure it — so we can put a true number next to our engine.
 *
 * Loop: create trajectory -> poll /commands -> execute on a Playwright page ->
 * POST /commands/{uid}/result -> repeat until the trajectory is terminal.
 * Surfer H tracks steps + cost server-side (metrics), so we get speed AND $$.
 *
 * Key from /tmp/agp-key (user-provided, rolled after).
 * Run:  node_modules/.bin/tsx bench/surferh-driver.ts ["task..."]
 */
import { chromium, type Page } from "playwright-core";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

const BASE = "https://agp.eu.hcompany.ai/api/v1";
const AGENT = "holo-tab-holo3-1-flash-visual-20260601-1612";
const KEY = fs.readFileSync("/tmp/agp-key", "utf-8").trim();
const PROFILE = path.join(os.homedir(), ".anorha", "surferh-profile");
const VW = 1096, VH = 1096;
const TASK =
  process.argv.find((a) => !a.startsWith("--") && a.includes(" ")) ??
  "Go to news.ycombinator.com and tell me the exact title of the #1 story.";

const HDR: Record<string, string> = {
  Authorization: `Bearer ${KEY}`,
  "X-From-htab": "true",
  "Content-Type": "application/json",
  Accept: "application/json",
};
function log(s: string): void {
  process.stdout.write(s + "\n");
}
async function agp(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(BASE + p, {
    method,
    headers: HDR,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  return { status: r.status, json: txt.trim() ? JSON.parse(txt) : null };
}

async function exec(page: Page, name: string, args: any): Promise<unknown> {
  const a = args ?? {};
  switch (name) {
    case "goto":
      await page.goto(a.url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      return null;
    case "back": await page.goBack().catch(() => {}); return null;
    case "forward": await page.goForward().catch(() => {}); return null;
    case "refresh": await page.reload().catch(() => {}); return null;
    case "current_url": return { url: page.url() };
    case "get_active_tab": return { url: page.url(), title: await page.title().catch(() => "") };
    case "get_tabs": case "get_tabs_with_screenshots": case "observe_with_tabs":
      return { tabs: [{ id: "0", url: page.url(), title: await page.title().catch(() => ""), active: true }] };
    case "get_screen_size": return { width: VW, height: VH };
    case "get_mouse_position": return { x: 0, y: 0 };
    case "screenshot": case "screenshot_png_bytes": case "screenshot_and_metadata": {
      const buf = await page.screenshot({ type: "png" });
      const meta = { url: page.url(), title: await page.title().catch(() => ""), viewport: [VW, VH], scroll: [0, 0] };
      return { base64: buf.toString("base64"), screenshot_b64: buf.toString("base64"), imgWidth: VW, imgHeight: VH, dpr: 1, metadata: meta };
    }
    case "get_a11y_snapshot": case "observe": {
      const snap = await page.evaluate(() => document.body?.innerText?.slice(0, 8000) ?? "").catch(() => "");
      return { snapshot: snap, refMap: {}, meta: { url: page.url() } };
    }
    case "get_html": return { html: (await page.content().catch(() => "")).slice(0, 20000) };
    case "get_viewport_html": return { html: (await page.content().catch(() => "")).slice(0, 20000) };
    case "extract_markdown": case "extract_table": case "get_element_text": case "reader_mode":
      return { text: (await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")).slice(0, 12000) };
    case "click_at": await page.mouse.click(a.x, a.y); return null;
    case "double_click": await page.mouse.dblclick(a.x ?? 0, a.y ?? 0); return null;
    case "mouse_move_to": await page.mouse.move(a.x, a.y); return null;
    case "mouse_press": await page.mouse.down(); return null;
    case "mouse_release": await page.mouse.up(); return null;
    case "click_element":
      if (a.selector) await page.click(a.selector, { timeout: 3000 }).catch(() => {});
      else if (a.x != null) await page.mouse.click(a.x, a.y);
      return null;
    case "hover_element": if (a.x != null) await page.mouse.move(a.x, a.y); return null;
    case "input_text": case "type_text": await page.keyboard.type(String(a.text ?? "")); return null;
    case "type_element":
      if (a.selector) await page.fill(a.selector, String(a.text ?? "")).catch(() => {});
      else await page.keyboard.type(String(a.text ?? ""));
      if (a.submit) await page.keyboard.press("Enter");
      return null;
    case "press_key": await page.keyboard.press(mapKey(a.key)); return null;
    case "press_keys": for (const k of a.keys ?? []) await page.keyboard.down(mapKey(k));
      for (const k of (a.keys ?? []).slice().reverse()) await page.keyboard.up(mapKey(k)); return null;
    case "scroll": await page.mouse.wheel(a.dx ?? 0, a.dy ?? 0); return null;
    case "scroll_at": await page.mouse.move(a.x ?? VW / 2, a.y ?? VH / 2); await page.mouse.wheel(a.dx ?? 0, a.dy ?? 0); return null;
    case "wait_for": await page.waitForTimeout(Math.min((a.time ?? 1) * 1000, 5000)); return null;
    case "new_tab": case "open_new_tab": if (a.url) await page.goto(a.url).catch(() => {}); return null;
    case "execute_script": try { return { result: await page.evaluate(a.script) }; } catch { return null; }
    default:
      log(`  [driver] UNHANDLED command: ${name} ${JSON.stringify(a).slice(0, 80)}`);
      return null;
  }
}
function mapKey(k: string): string {
  const m: Record<string, string> = { Return: "Enter", Esc: "Escape", Ctrl: "Control" };
  return m[k] ?? k;
}

async function main(): Promise<void> {
  fs.mkdirSync(PROFILE, { recursive: true });
  log("── Surfer H (real HoloTab brain) driver ──");
  log(`task: ${TASK}`);
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: "chrome", headless: false, viewport: { width: VW, height: VH },
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled"],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  const t0 = Date.now();
  const { status, json: traj } = await agp("POST", `/agents/${AGENT}/trajectories`, {
    task: { type: "interactive", start_url: "https://example.com", idle_timeout_s: 200, instructions: TASK },
    launch: true, store_calltrace: true, metadata: { source: "extension" },
  });
  if (status !== 200 || !traj?.id) { log(`create failed ${status}: ${JSON.stringify(traj).slice(0, 200)}`); await ctx.close(); process.exit(1); }
  const tid = traj.id;
  log(`trajectory ${tid} (${status})`);

  // HoloTab delivers the actual task as a user_message after create, then resumes.
  await agp("POST", `/trajectories/${tid}/interaction`, { type: "user_message", message: TASK, images: [], caller_id: "user" });
  await agp("POST", `/trajectories/${tid}/interaction`, { type: "flow_control", flow: "resume", origin: "user_resume" });

  let steps = 0;
  const deadline = t0 + 150_000;
  let terminal = false;
  while (Date.now() < deadline && !terminal) {
    const { status: cs, json: cmds } = await agp("GET", `/commands/${tid}/commands?wait_for_seconds=20`);
    if (cs === 204 || !Array.isArray(cmds) || cmds.length === 0) {
      const { json: st } = await agp("GET", `/trajectories/${tid}`);
      const s = st?.status;
      const ans = st?.answer;
      log(`  (no commands; status=${s}${ans ? "; answer set" : ""})`);
      const TERMINAL = ["completed", "finished", "failed", "stopped", "timed_out", "error", "cancelled"];
      if (TERMINAL.includes(s)) terminal = true;
      else if (s === "idle" && ans && steps > 1) terminal = true;
      continue;
    }
    for (const c of cmds) {
      steps++;
      const argstr = JSON.stringify(c.args ?? {}).slice(0, 70);
      log(`  [${steps}] ${c.name} ${argstr}`);
      let result: unknown = null;
      let error: string | null = null;
      try { result = await exec(page, c.name, c.args); }
      catch (e) { error = e instanceof Error ? e.message : String(e); }
      await agp("POST", `/commands/${c.command_uid}/result`, { result, error, command_uid: c.command_uid });
    }
  }

  const { json: fin } = await agp("GET", `/trajectories/${tid}`);
  const ms = Date.now() - t0;
  log("\n── SURFER H RESULT ──");
  log(`status:   ${fin?.status}`);
  log(`answer:   ${(fin?.answer ?? "").slice(0, 300)}`);
  log(`time:     ${(ms / 1000).toFixed(1)}s`);
  log(`steps:    server=${fin?.metrics?.steps} driver=${steps}`);
  log(`cost:     $${fin?.metrics?.total_cost ?? "?"}  (per-model: ${JSON.stringify(fin?.metrics?.cost_per_model ?? [])})`);
  await ctx.close().catch(() => {});
  process.exit(0);
}
main().catch((e) => { log(`FATAL: ${e instanceof Error ? e.stack : e}`); process.exit(1); });
