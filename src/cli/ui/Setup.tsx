/**
 * Ponder setup wizard — the gemini-cli-flavored onboarding flow.
 *
 * Steps:
 *   1. Probe the Playwriter CLI; install globally if missing.
 *   2. Open chrome://extensions/ so the user can install the
 *      Playwriter Chrome extension.
 *   3. Probe the Playwriter relay — wait up to 60s for the user
 *      to click the green icon. We poll once a second and animate
 *      a spinner so the wait doesn't feel dead.
 *   4. Show a short doctor summary at the end.
 *
 * Each step is a row in the same Ink Box, so the screen reads as
 * a single evolving checklist rather than a stream of console lines.
 * The amber spinner highlights the in-flight step; ✓ / ✗ icons
 * land in pistachio / red-coral.
 */

import React, { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { spawn } from "node:child_process";
import { createPonderClient, ensureAttached } from "../sdk.js";
import { Banner } from "./Banner.js";
import { Step, type StepStatus, KV, Section } from "./components.js";
import { THEME } from "./theme.js";

type StepId = "playwriter" | "extension" | "attach" | "doctor";

interface StepState {
  status: StepStatus;
  detail?: string;
  hint?: string;
}

function useStepStates(): [
  Record<StepId, StepState>,
  (id: StepId, patch: Partial<StepState>) => void,
] {
  const [states, setStates] = useState<Record<StepId, StepState>>({
    playwriter: { status: "pending" },
    extension: { status: "pending" },
    attach: { status: "pending" },
    doctor: { status: "pending" },
  });
  const update = (id: StepId, patch: Partial<StepState>): void => {
    setStates((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  };
  return [states, update];
}

async function whichBin(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = spawn(bin, ["--version"], { stdio: "ignore" });
    c.on("exit", (code) => resolve(code === 0));
    c.on("error", () => resolve(false));
  });
}

async function installPlaywriterGlobal(): Promise<boolean> {
  const ua = process.env.npm_config_user_agent ?? "";
  const pm = ua.startsWith("pnpm")
    ? "pnpm"
    : ua.startsWith("yarn")
      ? "yarn"
      : ua.startsWith("bun")
        ? "bun"
        : "npm";
  const args =
    pm === "yarn"
      ? ["global", "add", "playwriter"]
      : pm === "bun"
        ? ["add", "-g", "playwriter"]
        : pm === "pnpm"
          ? ["add", "-g", "playwriter"]
          : ["install", "-g", "playwriter"];
  return new Promise((resolve) => {
    const c = spawn(pm, args, { stdio: "ignore" });
    c.on("exit", (code) => resolve(code === 0));
    c.on("error", () => resolve(false));
  });
}

function openChromeExtensions(): void {
  // The Web Store install page is the most useful destination —
  // it skips the chrome://extensions/ + Developer-mode dance. We
  // open the Playwriter site since the upstream store URL is
  // unstable; the site has a current install link.
  try {
    spawn("open", ["https://playwriter.dev"], { stdio: "ignore" }).unref();
  } catch {
    /* non-fatal */
  }
}

export function Setup(): React.ReactElement {
  const { exit } = useApp();
  const [states, set] = useStepStates();
  const [waitSeconds, setWaitSeconds] = useState(0);
  const [summary, setSummary] = useState<null | {
    recipesDir: string;
    bridge: boolean;
    provider: string;
  }>(null);

  useEffect(() => {
    let cancelled = false;
    let waitTimer: NodeJS.Timeout | null = null;

    void (async () => {
      // STEP 1: Playwriter CLI
      set("playwriter", { status: "running", detail: "probing" });
      const has = await whichBin("playwriter");
      if (cancelled) return;
      if (has) {
        set("playwriter", { status: "ok", detail: "installed" });
      } else {
        set("playwriter", { status: "running", detail: "installing globally…" });
        const installed = await installPlaywriterGlobal();
        if (cancelled) return;
        if (installed) {
          set("playwriter", { status: "ok", detail: "installed (just now)" });
        } else {
          set("playwriter", {
            status: "warn",
            detail: "could not install automatically",
            hint: "Install manually: npm i -g playwriter",
          });
        }
      }

      // STEP 2: Extension page
      set("extension", {
        status: "running",
        detail: "opening playwriter.dev",
      });
      openChromeExtensions();
      // Give Chrome a beat to open before we start polling for the relay.
      await new Promise((r) => setTimeout(r, 1500));
      if (cancelled) return;
      set("extension", {
        status: "ok",
        detail: "page opened",
        hint: "Install the Playwriter extension if you haven't already.",
      });

      // STEP 3: Wait for the user to click the green icon. Poll the
      // relay every second; spinner animates the wait.
      set("attach", {
        status: "running",
        detail: "waiting for green icon (up to 60s)…",
      });
      waitTimer = setInterval(() => {
        setWaitSeconds((s) => s + 1);
      }, 1000);
      try {
        await ensureAttached({ timeoutMs: 60_000 });
        if (cancelled) return;
        set("attach", { status: "ok", detail: "tab attached" });
      } catch (e) {
        if (cancelled) return;
        set("attach", {
          status: "warn",
          detail: "no tab attached yet",
          hint:
            "Open Chrome, install Playwriter from playwriter.dev, and click " +
            "its icon on the tab you want to drive. Then run `ponder doctor` to verify.",
        });
      } finally {
        if (waitTimer) clearInterval(waitTimer);
      }

      // STEP 4: Summary line
      set("doctor", { status: "running", detail: "compiling summary…" });
      const client = createPonderClient({});
      const bridgeAlive = await client.health();
      const { computeDefaultProvider, isProviderConfigured, humanProviderLabel } =
        await import("../../agent/factory.js");
      const providerName = computeDefaultProvider();
      const providerOk = isProviderConfigured(providerName);
      if (cancelled) return;
      const { RECIPES_DIR } = await import("../../agent/recorder.js");
      setSummary({
        recipesDir: RECIPES_DIR,
        bridge: bridgeAlive,
        provider: providerOk
          ? humanProviderLabel(providerName)
          : `${humanProviderLabel(providerName)} (not configured)`,
      });
      set("doctor", { status: "ok", detail: "ready" });

      // Hand back to the caller. Tiny pause so the user sees the
      // last spinner snap to ✓.
      setTimeout(() => exit(), 400);
    })();

    return () => {
      cancelled = true;
      if (waitTimer) clearInterval(waitTimer);
    };
  }, []);

  return (
    <Box flexDirection="column" padding={1}>
      <Banner />

      <Section title="Setup">
        <Step
          status={states.playwriter.status}
          label="Playwriter CLI"
          {...(states.playwriter.detail ? { detail: states.playwriter.detail } : {})}
          {...(states.playwriter.hint ? { hint: states.playwriter.hint } : {})}
        />
        <Step
          status={states.extension.status}
          label="Chrome extension"
          {...(states.extension.detail ? { detail: states.extension.detail } : {})}
          {...(states.extension.hint ? { hint: states.extension.hint } : {})}
        />
        <Step
          status={states.attach.status}
          label="Attach a Chrome tab"
          detail={
            states.attach.status === "running"
              ? `waiting ${waitSeconds}s — click the green Playwriter icon`
              : states.attach.detail
          }
          {...(states.attach.hint ? { hint: states.attach.hint } : {})}
        />
        <Step
          status={states.doctor.status}
          label="Doctor summary"
          {...(states.doctor.detail ? { detail: states.doctor.detail } : {})}
        />
      </Section>

      {summary ? (
        <Section title="Ready to go">
          <KV label="Recipes dir" value={summary.recipesDir} />
          <KV
            label="Vision provider"
            value={summary.provider}
            color={
              summary.provider.includes("not configured")
                ? THEME.warning
                : THEME.text
            }
          />
          <KV
            label="HTTP bridge"
            value={summary.bridge ? "alive" : "not running"}
            color={summary.bridge ? THEME.success : THEME.muted}
          />
          <Box marginTop={1}>
            <Text color={THEME.muted}>Next:</Text>
            <Text color={THEME.text}> ponder attach</Text>
            <Text color={THEME.muted}>  ·  </Text>
            <Text color={THEME.text}>ponder doctor</Text>
            <Text color={THEME.muted}>  ·  </Text>
            <Text color={THEME.text}>ponder grant my-app</Text>
          </Box>
        </Section>
      ) : null}
    </Box>
  );
}
