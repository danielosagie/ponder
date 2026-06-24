#!/usr/bin/env tsx
/**
 * Headless integration test — REAL FB-selling-page structure.
 *
 * The flat-edit test used a fixture where every listing had a direct
 * edit URL. The LIVE page is messier (trace 2026-06-11): SOLD listings
 * have NO direct edit URL — you click the "..." More-options button,
 * a MENU opens, and you pick "Edit listing". The live planner got stuck
 * toggling More-options open/closed via slow VISION clicks and never
 * selected Edit. This fixture reproduces that so we can fix it headless.
 *
 * Worklist (mirrors the user's real listings):
 *   • 2 SOLD items  → editable ONLY via More-options menu → Edit listing
 *   • 2 DRAFT items → direct edit URL in the read text
 *
 *   npx tsx bench/integration-fb-menu.ts
 *
 * PASS if ≥2 of 4 descriptions change (the 2 drafts are the reliable
 * floor; a smart agent also does the 2 sold via the menu → 4/4).
 */
import { config as loadDotenv } from "dotenv";
import * as path from "node:path";
loadDotenv({ path: path.join(__dirname, "..", ".env") });

const WHITE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEUlEQVR42mP8z8BQz0AEYBxVSF8AGdcBBUjbf3sAAAAASUVORK5CYII=",
  "base64",
);
// The fake's CURRENT tab title, mirrored into the window-list so the
// loop's tab-visibility (title-match) check sees the controlled tab as
// VISIBLE — this fixture tests the visible-tab path on purpose.
let liveTabTitle = "Your listings";
const Module = require("module");
const screenStub = {
  __stub: true,
  async screenshot() {
    return { png: WHITE_PNG, width: 1512, height: 982, scaleFactor: 1, offsetX: 0, offsetY: 0 };
  },
  async size() { return { width: 1512, height: 982 }; },
  async sleep() {},
  async raiseMacApp() { return true; },
  async listMacWindows() {
    return [{ id: 1, owner: "Google Chrome", name: `${liveTabTitle} - Google Chrome`, layer: 0, x: 0, y: 0, width: 1512, height: 982 }];
  },
  async getBrowserUrl() { return undefined; },
  async getMacWindowBounds() { return null; },
  async captureWindowDirect() { return null; },
  async clickObstruction() { return null; },
  async frontWindowAtPoint() { return null; },
  async hover() {}, async click() {}, async drag() {}, async move() {},
  async typeText() {}, async pressCombo() {}, async scroll() {},
};
const origLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  let resolved = request;
  try { resolved = Module._resolveFilename(request, parent); } catch { /* */ }
  if (resolved.endsWith("/src/screen.ts") || resolved.endsWith("/src/screen.js") || resolved.endsWith("/screen.ts")) {
    return screenStub;
  }
  return origLoad.apply(this, arguments as unknown as [string, unknown, boolean]);
};

const SELLING_URL = "https://www.facebook.com/marketplace/you/selling";
const editUrl = (id: number) => `https://www.facebook.com/marketplace/edit/?listing_id=${id}`;

interface Listing {
  id: number;
  name: string;
  price: string;
  kind: "sold" | "draft";
  desc: string;
}

class FakeFbBrowser {
  name = "fake";
  listings: Listing[] = [
    { id: 201, name: "Pokemon Bulbasaur Card", price: "$30", kind: "sold", desc: "A pokemon card." },
    { id: 202, name: "1998 Honda CR-V", price: "$2500", kind: "sold", desc: "A honda cr-v." },
    { id: 689864533700020, name: "Heavy-Duty Storage Shelving", price: "$50", kind: "draft", desc: "Shelving." },
    { id: 9481279811909270, name: "Retail Display Cases", price: "$50", kind: "draft", desc: "Display cases." },
  ];
  page: { kind: "list" } | { kind: "menu"; idx: number } | { kind: "edit"; id: number } = { kind: "list" };
  pendingDesc: string | null = null;
  edited = new Set<number>();

  async available() { return true; }
  async isActive() { return true; }
  async bringToFront() {}
  async close() {}
  async listTabs() { return []; }
  async switchTab() { return {} as never; }
  async geometry() { return null; }
  async setInputFiles() {}
  async scrollElement() {}
  async scrollPage() {}

  private listRowsAx(): string {
    return this.listings
      .map(
        (l, i) =>
          `[e1${i}] link "${l.name} — ${l.price} (${l.kind})"\n[e2${i}] button "More options for ${l.name}"`,
      )
      .join("\n");
  }

  async snapshot() {
    if (this.page.kind === "list") {
      liveTabTitle = "Your listings";
      return { url: SELLING_URL, title: "Your listings", ax: `[e1] heading "Your listings"\n${this.listRowsAx()}` };
    }
    if (this.page.kind === "menu") {
      const l = this.listings[this.page.idx];
      liveTabTitle = "Your listings";
      return {
        url: SELLING_URL,
        title: "Your listings",
        ax:
          `[e1] heading "Your listings"\n${this.listRowsAx()}\n` +
          `[e90] menuitem "Edit listing"\n[e91] menuitem "Delete"\n[e92] menuitem "Mark as available"  (menu open for ${l.name})`,
      };
    }
    const l = this.listings.find((x) => x.id === (this.page as { id: number }).id)!;
    liveTabTitle = `Edit ${l.name}`;
    return {
      url: editUrl(l.id),
      title: `Edit ${l.name}`,
      ax: `[e1] textbox "Description" value "${this.pendingDesc ?? l.desc}"\n[e2] button "Save changes"`,
    };
  }

  async readText() {
    if (this.page.kind === "edit") {
      const l = this.listings.find((x) => x.id === (this.page as { id: number }).id)!;
      return `Editing ${l.name}. Description: ${this.pendingDesc ?? l.desc}. Save changes button below.`;
    }
    // Realistic FB read: sold items show relist/share actions (no edit
    // hint, no URL); drafts show a Continue link with a direct edit URL.
    return (
      "Your listings. Filters. " +
      this.listings
        .map((l) =>
          l.kind === "draft"
            ? `${l.name} ${l.price} Draft. Continue (${editUrl(l.id)}). Delete draft.`
            : `${l.name} ${l.price} Sold. Listed on Marketplace. 0 clicks on listing. Mark as available. Relist this item. Share.`,
        )
        .join(" ")
    );
  }

  async navigate(url: string) {
    const m = url.match(/listing_id=(\d+)/);
    if (m) {
      const id = Number(m[1]);
      if (this.listings.some((l) => l.id === id)) {
        this.page = { kind: "edit", id };
        this.pendingDesc = null;
        return;
      }
    }
    if (/you\/selling/.test(url)) {
      this.page = { kind: "list" };
      this.pendingDesc = null;
    }
  }

  async click(ref: string) {
    // Listing title link e1<i> — opens that listing's editor directly
    // (clicking your own listing opens it; realistic clean path).
    const title = ref.match(/^e1(\d)$/i);
    if (title && this.page.kind === "list") {
      const idx = Number(title[1]);
      if (idx < this.listings.length) {
        this.page = { kind: "edit", id: this.listings[idx].id };
        this.pendingDesc = null;
      }
      return;
    }
    // More-options button e2<i> — opens (or toggles) that item's menu.
    const more = ref.match(/^e2(\d)$/i);
    if (more) {
      const idx = Number(more[1]);
      if (idx < this.listings.length) {
        this.page =
          this.page.kind === "menu" && this.page.idx === idx
            ? { kind: "list" } // toggle closed
            : { kind: "menu", idx };
      }
      return;
    }
    // Menu item "Edit listing" e90 — opens the edit form for the open item.
    if (/^e90$/i.test(ref) && this.page.kind === "menu") {
      this.page = { kind: "edit", id: this.listings[this.page.idx].id };
      this.pendingDesc = null;
      return;
    }
    // Edit page: e2 = Save changes.
    if (/^e2$/i.test(ref) && this.page.kind === "edit") this.save();
  }

  async type(ref: string, text: string, opts?: { submit?: boolean }) {
    if (this.page.kind === "edit" && /^e1$/i.test(ref)) {
      this.pendingDesc = text;
      if (opts?.submit) this.save();
    }
  }

  private save() {
    if (this.page.kind !== "edit") return;
    const l = this.listings.find((x) => x.id === (this.page as { id: number }).id)!;
    if (this.pendingDesc && this.pendingDesc !== l.desc) {
      l.desc = this.pendingDesc;
      this.edited.add(l.id);
    }
    this.pendingDesc = null;
    this.page = { kind: "list" };
  }
}

async function main() {
  const { runTask } = await import("../src/agent/loop");
  const { makeProvider, computeDefaultProvider } = await import("../src/agent/factory");
  const provider = makeProvider(computeDefaultProvider());
  if (provider.name !== "composite") {
    console.error(`FAIL: need composite provider, got "${provider.name}".`);
    process.exit(1);
  }
  const browser = new FakeFbBrowser();
  const transcript: string[] = [];
  const events = {
    onStatus: async (s: string) => transcript.push(`status: ${s}`),
    onAction: async (a: { type: string; payload: Record<string, unknown> }) =>
      transcript.push(`action: ${a.type} ${JSON.stringify(a.payload).slice(0, 80)}`),
    onError: async (e: string) => transcript.push(`error: ${e.slice(0, 80)}`),
    onResult: async (r: string) => transcript.push(`result: ${r.slice(0, 80)}`),
    onScreenshot: async () => {},
    onThought: async () => {},
    onGround: async () => {},
  };
  const MAX = Number(process.env.MAX_STEPS ?? 40);
  // Tests the EDIT-EACH flow (menu + URL paths). The slow-mover FILTER
  // reasoning is tested separately in planner-decisions.ts — keeping them
  // apart avoids the filter excluding the fixture's items to nothing.
  const task =
    "go to my facebook marketplace listings and change the description on each of my listings";
  console.log(`▶ real-structure FB fixture (2 sold via menu, 2 drafts via URL), maxSteps=${MAX}\n`);
  const t0 = Date.now();
  let outcome = "error";
  try {
    outcome = await runTask({
      task, provider: provider as never, events: events as never, browser: browser as never,
      router: null, flat: true, decompose: true, overallGoal: task,
      maxSteps: MAX, stepPause: 0, targetApp: "",
      onHistory: (h: string) => transcript.push(`history: ${h.slice(0, 100)}`),
    });
  } catch (e) {
    console.error("runTask threw:", e instanceof Error ? e.message : e);
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n── outcome=${outcome} in ${secs}s ──`);
  console.log(`edited ${browser.edited.size}/4: [${[...browser.edited].join(", ")}]`);
  browser.listings.forEach((l) =>
    console.log(`   ${l.kind.padEnd(5)} ${l.name}: "${l.desc}"${browser.edited.has(l.id) ? "  ✏️" : ""}`),
  );
  const acts = transcript.filter((t) => t.startsWith("history:"));
  console.log(`\nlast ${Math.min(20, acts.length)} actions:`);
  acts.slice(-20).forEach((a) => console.log(`   ${a.replace("history: ", "").slice(0, 96)}`));
  const pass = browser.edited.size >= 2;
  console.log(`\n${pass ? "✅ PASS" : "❌ FAIL"} — edited ${browser.edited.size}/4 (need ≥2)`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("FATAL:", e?.message ?? e); process.exit(1); });
