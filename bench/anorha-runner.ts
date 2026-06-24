/**
 * Anorha runner — the lean "our own HoloTab", end to end, in YOUR real Chrome.
 *
 *   minimal :17777 bridge  ◄──ws──►  anorha-extension (chrome.debugger, YOUR tab)
 *          ▲
 *          │ sendRpc(cdp_exec ...)
 *   thin Holo 3.1 loop (screenshot → decide → execute → repeat)
 *
 * No Convex, no Clerk, no browser-use, no dev Chrome. You load the extension once;
 * this drives whatever tab is active in your normal Chrome, in the background.
 *
 * Run:  node_modules/.bin/tsx bench/anorha-runner.ts "task..."
 * Then: load /Users/dosagie/Documents/CodeProjects/anorha-extension as an unpacked
 *       extension (chrome://extensions → Developer mode → Load unpacked). It auto-pairs.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { config as loadEnv } from "dotenv";
import * as path from "node:path";
loadEnv({ path: path.join(__dirname, "..", ".env") });

const PORT = 17777;
const PAIR_CODE = "000000";
const TOKEN = "anorha-runner-token";
const KEY = process.env.HAI_API_KEY ?? "";
const MODEL = process.env.HCOMPANY_MODEL ?? "holo3-1-35b-a3b";
const TASK = process.argv.find((a) => !a.startsWith("--") && a.includes(" "))
  ?? "Read the main heading of this page and report it.";

function log(s: string) { process.stdout.write(s + "\n"); }

// ── minimal bridge ────────────────────────────────────────────────────────
let client: WebSocket | null = null;
let authed = false;
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();
let rpcSeq = 0;

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const send = (code: number, obj: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(obj));
  };
  if (req.method === "GET" && req.url?.startsWith("/status")) {
    return send(200, { ok: true, port: PORT, deviceId: "anorha-runner", pairCode: PAIR_CODE, paired: authed, connectedExtensions: client ? 1 : 0 });
  }
  if (req.method === "POST" && req.url?.startsWith("/pair")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { code } = JSON.parse(body || "{}");
        if (code === PAIR_CODE) return send(200, { ok: true, token: TOKEN, deviceId: "anorha-runner", pairedAt: Date.now() });
      } catch { /* ignore */ }
      send(400, { ok: false, error: "bad code" });
    });
    return;
  }
  send(404, { ok: false });
});

const wss = new WebSocketServer({ server, path: "/ws" });
let connCount = 0;
wss.on("connection", (ws: WebSocket) => {
  client = ws;
  const n = ++connCount;
  log(`[bridge] ws#${n} connected (path ok)`);
  ws.on("message", (data) => {
    const raw = String(data);
    log(`[bridge] ws#${n} MSG: ${raw.slice(0, 160)}`);
    let msg: any;
    try { msg = JSON.parse(raw); } catch (e) { log(`[bridge] ws#${n} parse-fail: ${e}`); return; }
    if (msg.type === "hello") {
      authed = true;
      log(`[bridge] ws#${n} hello from ${msg.extensionId ?? "?"} → authed`);
      ws.send(JSON.stringify({ type: "status", payload: { paired: true, deviceId: "anorha-runner", pairCode: PAIR_CODE, connectedExtensions: 1 }, authed: true }));
      return;
    }
    if (msg.type === "rpc_response") {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result); }
      return;
    }
  });
  ws.on("error", (e) => log(`[bridge] ws#${n} error: ${e}`));
  ws.on("close", (code, reason) => log(`[bridge] ws#${n} closed code=${code} reason=${String(reason).slice(0, 80)}`));
});

function sendRpc<T = any>(method: string, params: any = {}, timeoutMs = 30000): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!client || !authed) return reject(new Error("extension not connected/authed"));
    const id = `rpc-${++rpcSeq}`;
    pending.set(id, { resolve, reject });
    client.send(JSON.stringify({ type: "rpc", id, method, params }));
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`rpc ${method} timed out`)); }, timeoutMs);
  });
}

async function waitForExtension(): Promise<void> {
  log("[bridge] waiting for the anorha-extension to connect + pair…");
  log("  → chrome://extensions → Developer mode → Load unpacked → /Users/dosagie/Documents/CodeProjects/anorha-extension");
  while (!(client && authed)) await new Promise((r) => setTimeout(r, 500));
  log("[bridge] extension paired ✓");
}

// ── PNG dims (IHDR) so we can tell Holo the real viewport ───────────────────
function pngSize(b64: string): { w: number; h: number } {
  const buf = Buffer.from(b64, "base64");
  // PNG: 8-byte sig, then IHDR length(4)+type(4)+ width(4)+height(4) → width at offset 16
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

// ── Holo 3.1 one-call brain ─────────────────────────────────────────────────
async function holoDecide(task: string, b64: string, w: number, h: number, history: string[]): Promise<any> {
  const prompt =
    `You are a fast browser agent. The screenshot is ${w}x${h} pixels. Decide the SINGLE next action.\n` +
    `Reply with ONLY JSON: {"action":"click|type|press|scroll|goto|done","x":int,"y":int,"text":str,"key":"Enter|Tab","dy":int,"url":str,"answer":"final answer","why":"short"}\n` +
    `Coordinates are PIXELS. Use "done" with "answer" when complete.\n\nTASK: ${task}` +
    (history.length ? `\n\nDone so far:\n${history.join("\n")}` : "") + `\n\nNext action JSON:`;
  const r = await fetch("https://api.hcompany.ai/v1/chat/completions", {
    method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, temperature: 0, max_tokens: 220, chat_template_kwargs: { enable_thinking: false },
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
        { type: "text", text: prompt } ] }] }),
  });
  if (!r.ok) return { action: "done", answer: `Holo HTTP ${r.status}` };
  const j = await r.json();
  const c = j?.choices?.[0]?.message?.content ?? "{}";
  const m = c.match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : { action: "done", answer: c.slice(0, 120) }; }
  catch { return { action: "done", answer: c.slice(0, 120) }; }
}

// ── main loop ───────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  if (!KEY) { log("no HAI_API_KEY"); process.exit(1); }
  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", () => r()));
  log(`── Anorha runner · bridge on :${PORT} · brain=${MODEL} ──`);
  log(`task: ${TASK}`);
  await waitForExtension();

  const tab = await sendRpc<any>("get_active_tab");
  const tabId = tab?.id;
  log(`[run] active tab #${tabId}: ${tab?.title ?? ""} ${tab?.url ?? ""}`);
  // ask for consent (fires the approval popup if not auto-approved)
  await sendRpc("request_consent", { tabId, reason: `Anorha wants to run: ${TASK}` }).catch(() => {});

  const history: string[] = [];
  const t0 = Date.now();
  let answer: string | null = null;
  for (let step = 1; step <= 20 && Date.now() - t0 < 150000; step++) {
    const shot = await sendRpc<any>("cdp_exec", { tabId, name: "screenshot" }).catch((e) => ({ error: String(e) }));
    if (!shot?.base64) { log(`[${step}] screenshot failed: ${shot?.error ?? "?"}`); break; }
    const { w, h } = pngSize(shot.base64);
    const t1 = Date.now();
    const cmd = await holoDecide(TASK, shot.base64, w, h, history);
    log(`[${step}] (${Date.now() - t1}ms) ${JSON.stringify(cmd).slice(0, 130)}`);
    if (cmd.action === "done") { answer = cmd.answer ?? "(done)"; break; }
    await sendRpc("cdp_exec", { tabId, name: cmd.action, args: cmd }).catch((e) => log(`  exec err: ${e}`));
    history.push(`${cmd.action} ${cmd.x ?? ""}${cmd.x != null ? "," + cmd.y : ""} ${cmd.text ?? cmd.url ?? cmd.key ?? ""}`.trim());
    await new Promise((r) => setTimeout(r, 500));
  }
  log(`\n── RESULT ──\nanswer: ${answer}\ntime:   ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
}
main().catch((e) => { log(`FATAL: ${e instanceof Error ? e.stack : e}`); process.exit(1); });
