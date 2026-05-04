import { Ollama } from "ollama";
import type { ProviderClient, PlanResult, GroundResult } from "../types";

interface LocalConfig {
  host?: string;
  model?: string;
}

const PLAN_SYSTEM = `You are the Brain of a computer-use agent. Look at the screenshot and decide the SINGLE next action.

Allowed actions:
  - click <thing>            (single left click)
  - double click <thing>
  - type "text"
  - press KEY                (e.g. press enter, press esc, press cmd+space)
  - hotkey KEY+KEY           (e.g. hotkey cmd+tab to switch apps)
  - drag <source> to <target>  (drag-and-drop one element onto another)
  - scroll up | scroll down  (optionally with N steps)
  - wait Ns                  (when waiting for an app to load)
  - DONE                     (when the user's goal is visibly achieved)

PREFER KEYBOARD SHORTCUTS when they're faster or more reliable than clicking.
Useful ones on macOS:
  • hotkey cmd+tab     switch to another open app
  • hotkey cmd+space   open Spotlight, then type the app name + press enter
  • hotkey cmd+\`       cycle windows within the current app
  • hotkey cmd+w       close window
  • hotkey cmd+t       new tab (browsers)
  • press tab          move to next form field
  • press enter        submit the focused field
  • press esc          close popovers / cancel modals

DRAG when an element needs to MOVE, not just be clicked:
  drag the file icon to the trash
  drag the slider handle to the right end
  drag the email to the archive folder
Both endpoints must be visible on screen; if not, scroll first.

STOP CRITERIA — return DONE when ANY of these are true:
  • The user's goal is already visible on screen.
  • The requested app/window is now in the foreground.
  • Further actions would not bring you closer to the goal.
If unsure whether the task is complete, prefer DONE over guessing more actions.

Return ONLY one action sentence (or the literal word DONE). No commentary, no explanations, no lists.`;

const GROUND_SYSTEM = `You return (x,y) coordinates to click as JSON: {"x": <int 0-1000>, "y": <int 0-1000>}
where coordinates are normalized to a 1000x1000 grid over the screenshot.
Return ONLY the JSON object.`;

export function createLocalProvider(cfg: LocalConfig = {}): ProviderClient {
  const ollama = new Ollama({
    host: cfg.host ?? process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434",
  });
  const model = cfg.model ?? process.env.OLLAMA_MODEL ?? "holo3";

  async function ensurePresent(): Promise<void> {
    const list = await ollama.list();
    const present = list.models.some(
      (m) => m.name === model || m.name === `${model}:latest`,
    );
    if (present) return;
    // `holo3` is imported locally via scripts/setup-local.sh — never pulled from
    // a registry. If it's missing, fail loudly so the user runs the setup.
    if (model === "holo3") {
      throw new Error(
        "Local model `holo3` not found in Ollama. " +
          "Run `bash scripts/setup-local.sh` (downloads Holo3 GGUF + imports into Ollama).",
      );
    }
    const stream = await ollama.pull({ model, stream: true });
    for await (const _ of stream) {
      /* discard progress */
    }
  }

  return {
    name: "local",
    async warm() {
      const t0 = Date.now();
      await ensurePresent();
      // single-token nudge to load weights into memory
      await ollama.generate({ model, prompt: "warmup", options: { num_predict: 1 } });
      return { ready: true, warmSeconds: (Date.now() - t0) / 1000 };
    },

    async plan(args): Promise<PlanResult> {
      const history = args.history.slice(-3).map((h) => `- ${h}`).join("\n") || "(none)";
      const dup =
        args.history.length >= 2 && args.history.at(-1) === args.history.at(-2)
          ? "\nCRITICAL WARNING: last action repeated. If screen did not change, switch strategy."
          : "";
      const userText = `Task: ${args.task}\nScreen: ${args.screen[0]}x${args.screen[1]}\nRecent history:\n${history}${dup}\nWhat is the next single action?`;

      // Ollama doesn't expose AbortSignal on its high-level chat method, but
      // the loop bumps the cancel flag between awaits so the worst case is
      // one extra step. Bumped num_predict to 256 to match hcompany so the
      // action sentence isn't truncated mid-token.
      const res = await ollama.chat({
        model,
        messages: [
          { role: "system", content: PLAN_SYSTEM },
          { role: "user", content: userText, images: [args.screenshotB64] },
        ],
        options: { temperature: 0.2, num_predict: 256 },
      });
      const text = res.message.content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      return { action: text };
    },

    async ground(args): Promise<GroundResult> {
      const res = await ollama.chat({
        model,
        format: "json",
        messages: [
          { role: "system", content: GROUND_SYSTEM },
          {
            role: "user",
            content: `Click target: ${args.instruction}`,
            images: [args.screenshotB64],
          },
        ],
        options: { temperature: 0, num_predict: 128 },
      });
      const raw = res.message.content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      const xy = parseXY(raw);
      if (!xy) return { x: 0, y: 0, error: `parse: ${raw.slice(0, 100)}` };
      const [w, h] = args.screen;
      const x = xy.x <= 1000 ? Math.round((xy.x / 1000) * w) : Math.round(xy.x);
      const y = xy.y <= 1000 ? Math.round((xy.y / 1000) * h) : Math.round(xy.y);
      return {
        x: Math.max(0, Math.min(w - 1, x)),
        y: Math.max(0, Math.min(h - 1, y)),
        raw: [xy.x, xy.y],
      };
    },
  };
}

function parseXY(text: string): { x: number; y: number } | null {
  try {
    const obj = JSON.parse(text);
    if (typeof obj.x === "number" && typeof obj.y === "number") return obj;
  } catch {
    /* fall through */
  }
  const nums = text.match(/\d+/g);
  if (nums && nums.length >= 2) return { x: parseInt(nums[0], 10), y: parseInt(nums[1], 10) };
  return null;
}
