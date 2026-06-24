#!/usr/bin/env tsx
/**
 * Headless integration test of the REAL agent loop — no live screen.
 *
 * The planner-decision bench tests single decisions; this tests the
 * SEQUENCE the review flagged: on a "change the description of EACH
 * listing" task, does runTask actually ITERATE multiple items, or edit
 * one and stop (the false-"done" regression)?
 *
 * How it runs the real thing without the user's machine:
 *   • `screen` is stubbed via a require hook (blank screenshots, no-op
 *     mouse, browser reported frontmost) — so the vision/OS layer is
 *     inert but the loop's control flow, guards, decompose, and the
 *     composite planner all run for real.
 *   • a FAKE BrowserClient models a 3-listing FB-selling page as a state
 *     machine (list ⇄ edit pages), recording which descriptions actually
 *     changed.
 *
 *   npx tsx bench/integration-flat-edit.ts
 *
 * PASS if ≥2 of 3 listings get their description changed within the step
 * budget (iteration works) AND the run never exceeds the budget spinning.
 * Hits Gemini (composite planner) ~1 call/step. Exit non-zero on fail.
 */
import { config as loadDotenv } from "dotenv";
import * as path from "node:path";
loadDotenv({ path: path.join(__dirname, "..", ".env") });

// ── stub the `screen` module BEFORE anything imports the loop ──────────
// A 4×4 white PNG so imageops/downscale never choke on an empty buffer.
const WHITE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEUlEQVR42mP8z8BQz0AEYBxVSF8AGdcBBUjbf3sAAAAASUVORK5CYII=",
  "base64",
);
// The fake's current tab title, mirrored into the window list so the
// loop's title-match visibility check sees the controlled tab as visible.
let liveTabTitle = "Your listings";
const Module = require("module");
const screenStub = {
  __stub: true,
  async screenshot() {
    return { png: WHITE_PNG, width: 1512, height: 982, scaleFactor: 1, offsetX: 0, offsetY: 0 };
  },
  async size() {
    return { width: 1512, height: 982 };
  },
  async sleep(_ms: number) {
    /* fast: no real wait in the test */
  },
  async raiseMacApp() {
    return true;
  },
  async listMacWindows() {
    return [{ id: 1, owner: "Google Chrome", name: `${liveTabTitle} - Google Chrome`, layer: 0, x: 0, y: 0, width: 1512, height: 982 }];
  },
  async getBrowserUrl() {
    return undefined;
  },
  async getMacWindowBounds() {
    return null;
  },
  async captureWindowDirect() {
    return null;
  },
  async clickObstruction() {
    return null;
  },
  async frontWindowAtPoint() {
    return null;
  },
  async hover() {},
  async click() {},
  async drag() {},
  async move() {},
  async typeText() {},
  async pressCombo() {},
  async scroll() {},
};
const origLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  let resolved = request;
  try {
    resolved = Module._resolveFilename(request, parent);
  } catch {
    /* keep request */
  }
  if (
    resolved.endsWith("/src/screen.ts") ||
    resolved.endsWith("/src/screen.js") ||
    resolved.endsWith("/screen.ts")
  ) {
    return screenStub;
  }
  return origLoad.apply(this, arguments as unknown as [string, unknown, boolean]);
};

// ── fixture: a 3-listing "Your listings" page as a state machine ──────
interface Listing {
  id: number;
  name: string;
  price: string;
  desc: string;
}
const SELLING_URL = "https://www.facebook.com/marketplace/you/selling";
const editUrl = (id: number) =>
  `https://www.facebook.com/marketplace/edit/?listing_id=${id}`;

class FakeBrowser {
  name = "fake";
  listings: Listing[] = [
    { id: 101, name: "Blue Lamp", price: "$30", desc: "A blue lamp." },
    { id: 102, name: "Red Chair", price: "$40", desc: "A red chair." },
    { id: 103, name: "Desk Fan", price: "$25", desc: "A desk fan." },
  ];
  page: { kind: "list" } | { kind: "edit"; id: number } = { kind: "list" };
  pendingDesc: string | null = null;
  descFocused = false;
  edited = new Set<number>();

  private listingByEditRef(ref: string): Listing | undefined {
    // e30→101, e31→102, e32→103 (the "Edit" link per row)
    const m = ref.match(/^e3(\d)$/i);
    if (!m) return undefined;
    return this.listings[Number(m[1])];
  }

  async available() {
    return true;
  }
  async isActive() {
    return true;
  }
  async bringToFront() {}
  async close() {}
  async listTabs() {
    return [];
  }
  async switchTab() {
    return {} as never;
  }
  async geometry() {
    return null;
  }
  async setInputFiles() {}
  async scrollElement() {}
  async scrollPage() {}

  async snapshot() {
    if (this.page.kind === "list") {
      const rows = this.listings
        .map(
          (l, i) =>
            `[e2${i}] link "${l.name} — ${l.price}"\n[e3${i}] link "Edit ${l.name}"`,
        )
        .join("\n");
      liveTabTitle = "Your listings";
      return { url: SELLING_URL, title: "Your listings", ax: `[e1] heading "Your listings"\n${rows}` };
    }
    const l = this.listings.find((x) => x.id === (this.page as { id: number }).id)!;
    // A real textbox reflects focus + typed value, so a click/type on it
    // is never a "no-op" the no-effect guard would penalize.
    const focus = this.descFocused ? " (focused)" : "";
    liveTabTitle = `Edit ${l.name}`;
    return {
      url: editUrl(l.id),
      title: `Edit ${l.name}`,
      ax: `[e1] textbox "Description"${focus} value "${this.pendingDesc ?? l.desc}"\n[e2] button "Save"`,
    };
  }

  async readText() {
    if (this.page.kind === "list") {
      return (
        "Your listings. " +
        this.listings
          .map((l) => `${l.name} ${l.price}. Edit (${editUrl(l.id)}).`)
          .join(" ")
      );
    }
    const l = this.listings.find((x) => x.id === (this.page as { id: number }).id)!;
    return `Editing ${l.name}. Description: ${this.pendingDesc ?? l.desc}. Save button below.`;
  }

  async navigate(url: string) {
    const m = url.match(/listing_id=(\d+)/);
    if (m) {
      this.page = { kind: "edit", id: Number(m[1]) };
      this.pendingDesc = null;
      this.descFocused = false;
    } else if (/you\/selling/.test(url)) {
      this.page = { kind: "list" };
      this.pendingDesc = null;
      this.descFocused = false;
    }
  }

  async click(ref: string) {
    if (this.page.kind === "list") {
      const l = this.listingByEditRef(ref);
      if (l) {
        this.page = { kind: "edit", id: l.id };
        this.pendingDesc = null;
      }
      return;
    }
    // edit page: e1 = focus the description field, e2 = Save
    if (/^e1$/i.test(ref)) this.descFocused = true;
    if (/^e2$/i.test(ref)) this.save();
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
    this.descFocused = false;
    this.page = { kind: "list" };
  }
}

async function main() {
  const { runTask } = await import("../src/agent/loop");
  const { makeProvider, computeDefaultProvider } = await import("../src/agent/factory");
  const provider = makeProvider(computeDefaultProvider());
  if (provider.name !== "composite") {
    console.error(`FAIL: need composite provider, got "${provider.name}". Set GEMINI_API_KEY.`);
    process.exit(1);
  }

  const browser = new FakeBrowser();
  const transcript: string[] = [];
  const events = {
    onStatus: async (s: string) => transcript.push(`status: ${s}`),
    onAction: async (a: { type: string; payload: Record<string, unknown> }) =>
      transcript.push(`action: ${a.type} ${JSON.stringify(a.payload)}`),
    onError: async (e: string) => transcript.push(`error: ${e}`),
    onResult: async (r: string) => transcript.push(`result: ${r}`),
    onScreenshot: async () => {},
    onThought: async (t: string) => transcript.push(`thought: ${t.slice(0, 80)}`),
    onGround: async () => {},
  };

  const MAX = Number(process.env.MAX_STEPS ?? 28);
  const task =
    "go to my facebook marketplace and change the description on each of my 3 listings to mention a holiday discount";

  console.log(`▶ running real runTask (flat, decompose) against fake 3-listing page, maxSteps=${MAX}\n`);
  const t0 = Date.now();
  let outcome = "error";
  try {
    outcome = await runTask({
      task,
      provider: provider as never,
      events: events as never,
      browser: browser as never,
      router: null,
      flat: true,
      decompose: true,
      overallGoal: task,
      maxSteps: MAX,
      stepPause: 0,
      targetApp: "", // opt out of crop
      onHistory: (h: string) => transcript.push(`history: ${h.slice(0, 120)}`),
    });
  } catch (e) {
    console.error("runTask threw:", e instanceof Error ? e.message : e);
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n── outcome=${outcome} in ${secs}s ──`);
  console.log(`edited ${browser.edited.size}/3 listings: [${[...browser.edited].join(", ")}]`);
  browser.listings.forEach((l) =>
    console.log(`   ${l.id} ${l.name}: "${l.desc}"${browser.edited.has(l.id) ? "  ✏️" : ""}`),
  );

  // tail of the action sequence for eyeballing the iteration
  const actions = transcript.filter((t) => t.startsWith("action:") || t.startsWith("history:"));
  console.log(`\nlast ${Math.min(18, actions.length)} loop events:`);
  actions.slice(-18).forEach((a) => console.log(`   ${a.slice(0, 110)}`));

  const pass = browser.edited.size >= 2;
  console.log(`\n${pass ? "✅ PASS" : "❌ FAIL"} — iterated ${browser.edited.size}/3 (need ≥2)`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e?.message ?? e);
  process.exit(1);
});
