import { contextBridge, ipcRenderer } from "electron";

export type ProviderName = "remote" | "local" | "hcompany";

const api = {
  runTask: (prompt: string) => ipcRenderer.invoke("agent:run", prompt),
  cancel: () => ipcRenderer.invoke("agent:cancel"),
  setProvider: (name: ProviderName) => ipcRenderer.invoke("agent:setProvider", name),
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
