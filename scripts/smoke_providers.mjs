// Smoke test: run a fake "step" (plan + ground) against each configured
// provider with prompts that should elicit hotkey + drag responses, so we
// verify the new system prompts and the drag two-ground path actually work
// end-to-end without spinning up Electron.
//
// Reads .env / .env.local from the repo root. Skips providers it can't reach.
//
//   node scripts/smoke_providers.mjs

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// Tiny .env loader (avoid pulling dotenv just for a smoke script).
for (const f of [".env", ".env.local"]) {
  const p = join(root, f);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
    if (!m) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
}

// Compile providers from TS source via tsx — but easier: just call the HTTP
// endpoints directly with the same payload shape. That's what the providers do.

// Tiny synthesized PNG with two recognizable rectangles a model could drag
// between: a "file" icon area and a "trash" icon area.
function makeFakeScreenshotB64() {
  // 64x64 dark-blue PNG. Hand-built so we don't depend on Pillow.
  const w = 256, h = 160;
  const zlib = require("node:zlib");
  // Filter byte 0 + RGB rows. Top-left rectangle = "file" (gray), bottom-right = "trash" (red).
  const row = (y) => {
    const buf = Buffer.alloc(w * 3);
    for (let x = 0; x < w; x++) {
      let r = 30, g = 30, b = 40;
      if (x >= 20 && x < 60 && y >= 20 && y < 60) { r = 220; g = 220; b = 230; } // file
      if (x >= 200 && x < 240 && y >= 110 && y < 150) { r = 200; g = 60; b = 60; } // trash
      buf[x * 3] = r; buf[x * 3 + 1] = g; buf[x * 3 + 2] = b;
    }
    return buf;
  };
  const filtered = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    filtered[y * (w * 3 + 1)] = 0;
    row(y).copy(filtered, y * (w * 3 + 1) + 1);
  }
  const idatData = zlib.deflateSync(filtered);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const tb = Buffer.from(type, "ascii");
    const crcTable = (() => {
      const t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
      }
      return t;
    })();
    let c = 0xffffffff;
    const all = Buffer.concat([tb, data]);
    for (let i = 0; i < all.length; i++) c = crcTable[(c ^ all[i]) & 0xff] ^ (c >>> 8);
    const crc = Buffer.alloc(4); crc.writeUInt32BE((c ^ 0xffffffff) >>> 0, 0);
    return Buffer.concat([len, tb, data, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idatData), chunk("IEND", Buffer.alloc(0))]);
  return { b64: png.toString("base64"), screen: [w, h] };
}

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);

const { b64: SCREEN_B64, screen: SCREEN } = makeFakeScreenshotB64();

async function testHCompany() {
  const apiKey = process.env.HAI_API_KEY ?? process.env.HCOMPANY_API_KEY;
  if (!apiKey) return console.log("[hcompany] skipped — no HAI_API_KEY");

  // Compile + import hcompany.ts via tsx by spawning a child? Simpler: hit the
  // raw endpoint directly with the same prompt. But we want to test the new
  // system prompt — which lives in our hcompany.ts. So we need to either run
  // through it OR replicate it here.
  //
  // Easiest: spawn a tiny TS runner.
  const { spawnSync } = require("node:child_process");
  const tsxBin = join(root, "node_modules/.bin/tsx");
  if (!existsSync(tsxBin)) {
    console.log("[hcompany] skipped — tsx not installed");
    return;
  }
  const runner = `
    import { createHCompanyProvider } from "${join(root, "src/agent/providers/hcompany.ts")}";
    const p = createHCompanyProvider({ apiKey: process.env.HAI_API_KEY });
    const screen = ${JSON.stringify(SCREEN)};
    const screenshotB64 = ${JSON.stringify(SCREEN_B64)};

    async function main() {
      console.log("--- plan: should suggest a hotkey ---");
      const r1 = await p.plan({
        task: "Switch to the Safari app that's already open in another window",
        history: [],
        screenshotB64,
        screen,
      });
      console.log("action:", JSON.stringify(r1.action));

      console.log("--- plan: should suggest a drag ---");
      const r2 = await p.plan({
        task: "Move the file icon into the red trash square",
        history: [],
        screenshotB64,
        screen,
      });
      console.log("action:", JSON.stringify(r2.action));

      console.log("--- ground: file region ---");
      const g1 = await p.ground({
        instruction: "the gray file icon in the upper-left",
        screenshotB64,
        screen,
      });
      console.log("coords:", JSON.stringify(g1));
    }
    main().catch(e => { console.error("ERR:", e.message); process.exit(2); });
  `;
  const tmpFile = join(root, "scripts/.smoke_hcompany.tmp.ts");
  require("node:fs").writeFileSync(tmpFile, runner);
  console.log("\n=== hcompany API ===");
  const out = spawnSync("node", ["--import", "tsx", tmpFile], {
    cwd: root,
    encoding: "utf-8",
    env: process.env,
    timeout: 180_000,
  });
  process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  require("node:fs").unlinkSync(tmpFile);
}

async function testModal() {
  const baseUrl = process.env.MODAL_BASE_URL;
  const token = process.env.MODAL_BEARER_TOKEN;
  if (!baseUrl || !token) return console.log("[modal] skipped — MODAL_* not set");

  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`,
  };
  function url(path) {
    const map = { "/plan": "plan-endpoint", "/ground": "ground-endpoint" };
    const prefix = baseUrl.replace(/\/+$/, "").replace(/-(?:warm|plan-endpoint|ground-endpoint|health)\.modal\.run$/, "");
    return `${prefix}-${map[path]}.modal.run`;
  }

  console.log("\n=== modal (Holo3 self-host) ===");

  console.log("--- plan: should suggest a hotkey ---");
  const t0 = Date.now();
  const r1 = await fetch(url("/plan"), {
    method: "POST", headers,
    body: JSON.stringify({
      task: "Switch to the Safari app that's already open in another window",
      history: [],
      screenshot_b64: SCREEN_B64,
      screen: SCREEN,
    }),
  });
  console.log(`HTTP ${r1.status} in ${Date.now() - t0}ms`);
  if (r1.ok) {
    const j = await r1.json();
    console.log("action:", JSON.stringify(j.action), "tokens:", j.usage?.completion_tokens);
  } else {
    console.log("body:", (await r1.text()).slice(0, 300));
  }

  console.log("--- plan: should suggest a drag ---");
  const t1 = Date.now();
  const r2 = await fetch(url("/plan"), {
    method: "POST", headers,
    body: JSON.stringify({
      task: "Move the file icon into the red trash square",
      history: [],
      screenshot_b64: SCREEN_B64,
      screen: SCREEN,
    }),
  });
  console.log(`HTTP ${r2.status} in ${Date.now() - t1}ms`);
  if (r2.ok) {
    const j = await r2.json();
    console.log("action:", JSON.stringify(j.action), "tokens:", j.usage?.completion_tokens);
  } else {
    console.log("body:", (await r2.text()).slice(0, 300));
  }

  console.log("--- ground: file region ---");
  const t2 = Date.now();
  const r3 = await fetch(url("/ground"), {
    method: "POST", headers,
    body: JSON.stringify({
      instruction: "the gray file icon in the upper-left",
      screenshot_b64: SCREEN_B64,
      screen: SCREEN,
    }),
  });
  console.log(`HTTP ${r3.status} in ${Date.now() - t2}ms`);
  if (r3.ok) {
    const j = await r3.json();
    console.log("coords:", JSON.stringify(j));
  } else {
    console.log("body:", (await r3.text()).slice(0, 300));
  }
}

await testHCompany();
await testModal();
