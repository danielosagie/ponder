/**
 * `ponder agp "<task>"` — run a browser task on the AGP server-side brain.
 *
 * holo3-agent acts as a thin DRIVER: the H-company agent plans/grounds on
 * the server and streams driver commands, which we execute against the
 * user's real Chrome (via the Playwriter relay). This is the fast path —
 * zero client-side model round-trips.
 *
 * Usage:
 *   tsx src/cli/agp.ts "find the cheapest 1997 Camry on marketplace"
 *   tsx src/cli/agp.ts --url https://example.com "what is the heading?"
 *   AGP_AGENT=surfer-h-ultra tsx src/cli/agp.ts "..."
 *   tsx src/cli/agp.ts --cdp-url http://127.0.0.1:9222 "..."   # no-extension
 */

import "dotenv/config";
import { runAgpTask } from "../agent/agp/loop";
import { createPlaywriterClient } from "../agent/browser/playwriter";
import { AgpClient } from "../agent/agp/client";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function gray(s: string): string {
  return `\x1b[90m${s}\x1b[0m`;
}
function bold(s: string): string {
  return `\x1b[1m${s}\x1b[0m`;
}

async function main(): Promise<void> {
  // Positional task = first arg that isn't a flag or a flag value.
  const argv = process.argv.slice(2);
  const flagNames = new Set(["url", "agent", "cdp-url", "timeout", "max"]);
  const taskParts: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      if (flagNames.has(a.slice(2))) i++; // skip its value
      continue;
    }
    taskParts.push(a);
  }
  const task = taskParts.join(" ").trim();
  if (!task) {
    console.error('Usage: tsx src/cli/agp.ts [--url URL] [--agent ID] [--cdp-url URL] "<task>"');
    process.exit(1);
  }

  const client = new AgpClient();
  if (!client.configured) {
    console.error("No HAI_API_KEY / HCOMPANY_API_KEY in env (.env). Aborting.");
    process.exit(1);
  }
  const quota = await client.getQuota().catch(() => null);
  console.log(gray(`[agp] base=${client.baseUrl} quota=${quota ? `${quota.available}/${quota.limit}` : "?"}`));

  const cdpUrl = flag("cdp-url") || process.env.CDP_URL;
  const browser = await createPlaywriterClient({
    cdpUrl,
    onStatus: (t) => console.log(gray(`[browser] ${t}`)),
  });

  // Wait for a controllable tab. With the relay/extension path this means
  // the relay starts in-process, your extension connects, and you click the
  // green Playwriter icon on the tab you want driven. We poll rawPage() (no
  // 1.5s cap, unlike available()) for up to ~90s so there's time to click.
  const attachDeadline = Date.now() + (cdpUrl ? 8_000 : 90_000);
  let page: unknown = null;
  let hinted = false;
  while (Date.now() < attachDeadline) {
    page = await browser.rawPage?.().catch(() => null);
    if (page) break;
    if (!cdpUrl && !hinted) {
      hinted = true;
      console.log(
        "\n" +
          bold("→ In your normal Chrome:") +
          " open the tab you want me to drive (e.g. your Marketplace listings,\n" +
          "  logged into Facebook + Google), then CLICK the Playwriter extension icon on it (it turns green).\n" +
          gray("  Waiting up to 90s for the tab to attach…\n"),
      );
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!page) {
    console.error(
      cdpUrl
        ? "\nNo controllable Chrome tab at the given --cdp-url."
        : "\nNo tab attached. Make sure the Playwriter extension is installed and you clicked its icon (green) on a tab.",
    );
    await browser.close().catch(() => {});
    process.exit(1);
  }

  const abort = new AbortController();
  process.on("SIGINT", () => {
    console.log(gray("\n[agp] interrupt — stopping…"));
    abort.abort();
  });

  if (!flag("agent") && !process.env.AGP_AGENT) {
    console.log(
      gray("[agp] using default agent holo-tab-holo3-1-flash-visual (Holo 3.1, EU region)."),
    );
  }

  console.log(bold(`\n▶ ${task}\n`));
  const result = await runAgpTask({
    task,
    startUrl: flag("url") ?? null,
    agentId: flag("agent"),
    client,
    browser,
    timeoutMs: flag("timeout") ? Number(flag("timeout")) * 1000 : undefined,
    maxCommands: flag("max") ? Number(flag("max")) : undefined,
    signal: abort.signal,
    cleanup: process.argv.includes("--keep") ? false : true,
    onEvent: (ev) => {
      if (process.env.AGP_DEBUG && (ev.kind === "error_event" || ev.kind === "observation_event" || ev.kind === "policy_event")) {
        console.log(gray(`  [raw ${ev.kind}] ${JSON.stringify(ev.raw).slice(0, 900)}`));
      }
      if (ev.kind === "policy_event") {
        if (ev.text) console.log(gray(`  · ${ev.text.replace(/\s+/g, " ").slice(0, 160)}`));
        if (ev.tools?.length) console.log(gray(`    → ${ev.tools.join(", ")}`));
      } else if (ev.kind === "observation_event" && ev.text) {
        console.log(gray(`  · obs: ${ev.text.slice(0, 100)}`));
      } else if (ev.kind === "error_event") {
        console.log(`  ${gray("!")} ${ev.error}`);
      } else if (ev.kind === "lifecycle" && ev.text) {
        console.log(gray(`  · ${ev.text}`));
      }
    },
    onCommand: (name, args) => {
      const argStr = Object.keys(args).length ? ` ${JSON.stringify(args).slice(0, 80)}` : "";
      console.log(gray(`  ⚙ ${name}${argStr}`));
    },
  });

  console.log(`\n${bold("status:")} ${result.status}  ${gray(`(${result.commandCount} commands, traj ${result.trajectoryId})`)}`);
  if (result.answer) console.log(`\n${bold("answer:")}\n${result.answer}`);
  if (result.error) console.log(`\n${bold("error:")} ${result.error}`);

  await browser.close().catch(() => {});
  process.exit(result.status === "failed" || result.status === "error" ? 1 : 0);
}

main().catch((e) => {
  console.error("[agp] fatal:", e);
  process.exit(1);
});
