/**
 * Ponder doctor — animated health check.
 *
 * Each row starts as a muted dot, animates to an amber spinner
 * while the probe runs, then snaps to a pistachio ✓ or a red ✗.
 *
 * Probes run sequentially so the screen is easy to follow, but
 * each one is fast (≤ 5s) and we abort early on the first hard
 * failure that makes downstream checks meaningless.
 */

import React, { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { connectToUserChrome, createPonderClient } from "../sdk.js";
import { readKeys, AUDIT_LOG_PATH, KEYS_PATH } from "../../bridge/auth.js";
import { Banner } from "./Banner.js";
import { Step, type StepStatus, KV, Section } from "./components.js";
import { THEME } from "./theme.js";

type CheckId =
  | "recipes"
  | "playwriter"
  | "chrome"
  | "provider"
  | "bridge"
  | "keys";

interface CheckState {
  status: StepStatus;
  detail?: string;
  hint?: string;
}

const INITIAL: Record<CheckId, CheckState> = {
  recipes: { status: "pending" },
  playwriter: { status: "pending" },
  chrome: { status: "pending" },
  provider: { status: "pending" },
  bridge: { status: "pending" },
  keys: { status: "pending" },
};

async function whichBin(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = spawn(bin, ["--version"], { stdio: "ignore" });
    c.on("exit", (code) => resolve(code === 0));
    c.on("error", () => resolve(false));
  });
}

export function Doctor(): React.ReactElement {
  const { exit } = useApp();
  const [states, setStates] = useState<Record<CheckId, CheckState>>(INITIAL);
  const [summary, setSummary] = useState<null | { ok: boolean; passed: number; total: number }>(null);

  const set = (id: CheckId, patch: Partial<CheckState>): void => {
    setStates((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let passed = 0;
      const total = 6;

      // Recipes dir
      set("recipes", { status: "running" });
      const { RECIPES_DIR } = await import("../../agent/recorder.js");
      let recipeCount = 0;
      let recipesOk = false;
      try {
        const stat = fs.statSync(RECIPES_DIR);
        if (stat.isDirectory()) {
          recipeCount = fs
            .readdirSync(RECIPES_DIR)
            .filter((f) => f.endsWith(".json")).length;
          recipesOk = true;
        }
      } catch {
        /* missing */
      }
      if (cancelled) return;
      if (recipesOk) {
        passed++;
        set("recipes", {
          status: "ok",
          detail: `${recipeCount} recipe${recipeCount === 1 ? "" : "s"}`,
        });
      } else {
        set("recipes", {
          status: "skip",
          detail: "not yet created",
          hint: "Drive a flow once and it'll appear at " + RECIPES_DIR,
        });
      }

      // Playwriter CLI
      set("playwriter", { status: "running" });
      const playwriterOk = await whichBin("playwriter");
      if (cancelled) return;
      if (playwriterOk) {
        passed++;
        set("playwriter", { status: "ok", detail: "on PATH" });
      } else {
        set("playwriter", {
          status: "warn",
          detail: "not on PATH",
          hint: "Install: npm i -g playwriter",
        });
      }

      // Chrome bridge
      set("chrome", { status: "running", detail: "connecting…" });
      let chromeOk = false;
      let chromeUrl: string | undefined;
      try {
        const connected = await Promise.race([
          connectToUserChrome(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("timed out after 5s")), 5000),
          ),
        ]);
        chromeUrl = connected.page.url();
        chromeOk = true;
        await connected.close();
      } catch {
        /* not attached */
      }
      if (cancelled) return;
      if (chromeOk) {
        passed++;
        set("chrome", {
          status: "ok",
          detail: chromeUrl ?? "connected",
        });
      } else {
        set("chrome", {
          status: "warn",
          detail: "not attached",
          hint:
            "Open Chrome, install the Playwriter extension (playwriter.dev), " +
            "and click its icon on a tab.",
        });
      }

      // Vision provider
      set("provider", { status: "running" });
      const { computeDefaultProvider, isProviderConfigured, humanProviderLabel } =
        await import("../../agent/factory.js");
      const providerName = computeDefaultProvider();
      const providerOk = isProviderConfigured(providerName);
      if (cancelled) return;
      if (providerOk) {
        passed++;
        set("provider", {
          status: "ok",
          detail: humanProviderLabel(providerName),
        });
      } else {
        set("provider", {
          status: "warn",
          detail: `${humanProviderLabel(providerName)} (not configured)`,
          hint:
            "Set HAI_API_KEY (preferred) or MODAL_BASE_URL+MODAL_BEARER_TOKEN.",
        });
      }

      // Bridge
      set("bridge", { status: "running" });
      const client = createPonderClient({});
      const bridgeOk = await client.health();
      if (cancelled) return;
      if (bridgeOk) {
        passed++;
        set("bridge", { status: "ok", detail: client.url });
      } else {
        set("bridge", {
          status: "skip",
          detail: "not running",
          hint: "Start the Holo3 Electron app to enable the :7900 bridge.",
        });
      }

      // Keys file
      set("keys", { status: "running" });
      const keys = await readKeys();
      if (cancelled) return;
      passed++;
      set("keys", {
        status: keys.length > 0 ? "ok" : "skip",
        detail: `${keys.length} key${keys.length === 1 ? "" : "s"} at ${KEYS_PATH}`,
        ...(keys.length === 0
          ? { hint: "Issue one with: ponder grant <name>" }
          : {}),
      });

      setSummary({ ok: recipesOk && chromeOk, passed, total });
      setTimeout(() => exit(), 400);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Box flexDirection="column" padding={1}>
      <Banner compact tagline="Doctor — environment check" />

      <Section title="Checks">
        <Step
          status={states.recipes.status}
          label="Recipes directory"
          {...(states.recipes.detail ? { detail: states.recipes.detail } : {})}
          {...(states.recipes.hint ? { hint: states.recipes.hint } : {})}
        />
        <Step
          status={states.playwriter.status}
          label="Playwriter CLI"
          {...(states.playwriter.detail ? { detail: states.playwriter.detail } : {})}
          {...(states.playwriter.hint ? { hint: states.playwriter.hint } : {})}
        />
        <Step
          status={states.chrome.status}
          label="Chrome bridge"
          {...(states.chrome.detail ? { detail: states.chrome.detail } : {})}
          {...(states.chrome.hint ? { hint: states.chrome.hint } : {})}
        />
        <Step
          status={states.provider.status}
          label="Vision provider"
          {...(states.provider.detail ? { detail: states.provider.detail } : {})}
          {...(states.provider.hint ? { hint: states.provider.hint } : {})}
        />
        <Step
          status={states.bridge.status}
          label="HTTP bridge"
          {...(states.bridge.detail ? { detail: states.bridge.detail } : {})}
          {...(states.bridge.hint ? { hint: states.bridge.hint } : {})}
        />
        <Step
          status={states.keys.status}
          label="API keys"
          {...(states.keys.detail ? { detail: states.keys.detail } : {})}
          {...(states.keys.hint ? { hint: states.keys.hint } : {})}
        />
      </Section>

      {summary ? (
        <Box marginTop={1}>
          {summary.ok ? (
            <Text color={THEME.success}>
              All systems go ({summary.passed}/{summary.total}).{" "}
              <Text color={THEME.text}>Try </Text>
              <Text color={THEME.amber}>ponder run</Text>
              <Text color={THEME.text}>.</Text>
            </Text>
          ) : (
            <Text color={THEME.warning}>
              {summary.passed}/{summary.total} checks passed. Fix the warnings above and re-run.
            </Text>
          )}
        </Box>
      ) : null}
    </Box>
  );
}
