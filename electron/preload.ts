import { contextBridge, ipcRenderer } from "electron";

export type ProviderName = "remote" | "local" | "hcompany";

const api = {
  runTask: (prompt: string) => ipcRenderer.invoke("agent:run", prompt),
  cancel: () => ipcRenderer.invoke("agent:cancel"),
  setProvider: (name: ProviderName) => ipcRenderer.invoke("agent:setProvider", name),
  // Brain engine: local composite loop vs server-side AGP (Holo 3.1) brain.
  getEngine: () => ipcRenderer.invoke("agent:getEngine") as Promise<"composite" | "agp">,
  setEngine: (engine: "composite" | "agp") =>
    ipcRenderer.invoke("agent:setEngine", engine) as Promise<{
      ok: boolean;
      engine: "composite" | "agp";
    }>,
  // Recipe-first auto-replay: replay a saved automation that exactly matches.
  getAutoReplay: () => ipcRenderer.invoke("agent:getAutoReplay") as Promise<boolean>,
  setAutoReplay: (on: boolean) =>
    ipcRenderer.invoke("agent:setAutoReplay", on) as Promise<{
      ok: boolean;
      autoReplay: boolean;
    }>,
  warm: () => ipcRenderer.invoke("agent:warm"),
  getState: () => ipcRenderer.invoke("agent:state"),
  hideOverlay: () => ipcRenderer.invoke("overlay:hide"),
  setOverlayMode: (mode: "input" | "tail") =>
    ipcRenderer.invoke("overlay:setMode", mode),
  resizeOverlay: (size: { w: number; h: number }) =>
    ipcRenderer.invoke("overlay:resize", size),
  // Buddy input pill — renderer asks main to drop input mode (re-enable
  // click-through, hide pill, blur the window).
  dismissInputMode: () => ipcRenderer.invoke("buddy:dismissInput"),
  openAppWindow: () => ipcRenderer.invoke("app:show"),
  openSystemSettings: (pane: "accessibility" | "screen" | "input") =>
    ipcRenderer.invoke("perms:open", pane),
  reprobePermissions: () => ipcRenderer.invoke("perms:probe"),
  // Reveal the actual Electron binary (node_modules/electron/dist/Electron.app
  // in dev) in Finder, so the user can drag it into Privacy → Accessibility.
  revealBinary: () =>
    ipcRenderer.invoke("perms:revealBinary") as Promise<{
      ok: boolean;
      path?: string;
    }>,
  onState: (cb: (state: AgentStateMsg) => void): (() => void) => {
    const handler = (_e: unknown, payload: AgentStateMsg) => cb(payload);
    ipcRenderer.on("agent:state", handler);
    return () => {
      ipcRenderer.removeListener("agent:state", handler);
    };
  },
  getEnv: () =>
    ipcRenderer.invoke("env:public") as Promise<{
      convexUrl: string | null;
      provider: ProviderName;
      backgroundMode: boolean;
    }>,
  // ── Automations / recipes — list, fetch, reveal in editor.
  //    All data comes from ~/.ponder/recipes/. The renderer's
  //    Automations tab uses listRecipes for the index, getRecipe
  //    for detail, and revealRecipe to pop the .recipe.ts in the
  //    user's default editor.
  listRecipes: () =>
    ipcRenderer.invoke("recipes:list") as Promise<
      Array<{
        id: string;
        task: string;
        startedAt: string;
        steps: number;
        outcome?: string;
        durationMs?: number;
        recipePath: string;
        jsonPath: string;
      }>
    >,
  getRecipe: (id: string) =>
    ipcRenderer.invoke("recipes:get", id) as Promise<{
      task: string;
      startedAt: string;
      durationMs?: number;
      outcome?: string;
      surface?: string;
      provider?: string;
      steps: Array<{
        t: number;
        intent?: string;
        executed: { type: string; payload: Record<string, unknown> };
        url?: string;
      }>;
    } | null>,
  recipePaths: (id: string) =>
    ipcRenderer.invoke("recipes:paths", id) as Promise<{
      jsonPath: string;
      recipePath: string;
    }>,
  revealRecipe: (id: string) =>
    ipcRenderer.invoke("recipes:reveal", id) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  // Deterministic replay of a saved recipe (reground:true re-grounds each step
  // via vision → survives DOM drift; far faster than a fresh agent loop).
  replayRecipe: (id: string, opts?: { reground?: boolean; stepDelayMs?: number }) =>
    ipcRenderer.invoke("recipes:replay", id, opts) as Promise<{
      ok: boolean;
      failed?: number;
      healed?: number;
      error?: string;
    }>,
  // Freeze the most recent run into a saved automation (recipe).
  saveLastAsRecipe: (task?: string) =>
    ipcRenderer.invoke("recipes:saveLast", task) as Promise<{
      ok: boolean;
      id?: string;
      error?: string;
    }>,
  // Freeze a PAST run (from History) into a saved automation.
  saveSessionAsRecipe: (sessionId: string, task?: string) =>
    ipcRenderer.invoke("recipes:saveFromSession", sessionId, task) as Promise<{
      ok: boolean;
      id?: string;
      error?: string;
    }>,
  // Open a selling channel (or any URL) in the default browser to sign in.
  openChannel: (url: string) =>
    ipcRenderer.invoke("channels:open", url) as Promise<{ ok: boolean; error?: string }>,
};

export interface AgentStateMsg {
  warmup: "cold" | "warming" | "ready" | "error";
  provider: ProviderName;
  activeSessionId: string | null;
  errorMessage?: string;
}

contextBridge.exposeInMainWorld("agent", api);

// ---------------------------------------------------------------------------
// Buddy bridge — channels for the full-screen Buddy window only.
// ---------------------------------------------------------------------------
const buddyApi = {
  onCursor: (cb: (p: { x: number; y: number }) => void): (() => void) => {
    const handler = (_e: unknown, p: { x: number; y: number }) => cb(p);
    ipcRenderer.on("buddy:cursor", handler);
    return () => {
      ipcRenderer.removeListener("buddy:cursor", handler);
    };
  },
  onMode: (cb: (mode: "active" | "hidden") => void): (() => void) => {
    const handler = (_e: unknown, m: "active" | "hidden") => cb(m);
    ipcRenderer.on("buddy:mode", handler);
    return () => {
      ipcRenderer.removeListener("buddy:mode", handler);
    };
  },
  onSay: (
    cb: (payload: {
      // "answer" is the extractor's end-of-run reply — the variable-length
      // textual answer to the user's original question (e.g. the list of
      // FB Marketplace items). Distinct from "thought" (planner reasoning,
      // narrator fluff) so the renderer can style it as a persistent reply
      // bubble instead of a transient thought bubble.
      kind: "thought" | "action" | "error" | "status" | "answer";
      text: string;
    }) => void,
  ): (() => void) => {
    const handler = (
      _e: unknown,
      p: {
        kind: "thought" | "action" | "error" | "status" | "answer";
        text: string;
      },
    ) => cb(p);
    ipcRenderer.on("buddy:say", handler);
    return () => {
      ipcRenderer.removeListener("buddy:say", handler);
    };
  },
  // Toggle the input pill. When `visible: true` main has already flipped the
  // window interactive (setIgnoreMouseEvents(false)); the pill mounts and focuses.
  onInputMode: (
    cb: (payload: { visible: boolean; x: number; y: number }) => void,
  ): (() => void) => {
    const handler = (
      _e: unknown,
      p: { visible: boolean; x: number; y: number },
    ) => cb(p);
    ipcRenderer.on("buddy:inputMode", handler);
    return () => {
      ipcRenderer.removeListener("buddy:inputMode", handler);
    };
  },
  // Fired once on app boot so the buddy plays the typewriter "hi i'm holo3"
  // greeting exactly once. We deliberately don't reuse `onMode("active")`
  // for this — that fires on every task start and would spam the welcome.
  onWelcome: (cb: () => void): (() => void) => {
    const handler = () => cb();
    ipcRenderer.on("buddy:welcome", handler);
    return () => {
      ipcRenderer.removeListener("buddy:welcome", handler);
    };
  },
  // Agent cursor target — fires on each ground (and null on task end). The
  // renderer animates a blue agent triangle from its current position to
  // the target so the user sees what the agent is "doing" without their
  // own mouse being affected (background mode).
  onAgentCursor: (
    cb: (
      coords: { x: number; y: number; kind: "click" | "double" } | null,
    ) => void,
  ): (() => void) => {
    const handler = (
      _e: unknown,
      payload: { x: number; y: number; kind: "click" | "double" } | null,
    ) => cb(payload);
    ipcRenderer.on("buddy:agentCursor", handler);
    return () => {
      ipcRenderer.removeListener("buddy:agentCursor", handler);
    };
  },
};

contextBridge.exposeInMainWorld("buddy", buddyApi);

export type AgentApi = typeof api;
export type BuddyApi = typeof buddyApi;
declare global {
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface Window {
    agent: AgentApi;
    buddy: BuddyApi;
  }
}
