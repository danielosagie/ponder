/**
 * OsClient — structured OS accessibility-tree control, parallel to
 * BrowserClient (src/agent/browser/types.ts) but for native windows
 * instead of Chrome tabs. The point is the same: an a11y snapshot with
 * stable refs (e1, e2, …) so the planner picks an element instead of
 * pixel coordinates, and the click resolves in ~ms instead of a vision
 * round-trip.
 *
 * Per-platform providers (mac.ts via AXUIElement, windows.ts via UIA)
 * implement OsClient. The factory in client.ts picks one at runtime.
 *
 * Vision stays primary for surfaces with broken a11y trees (Electron
 * apps that fake out AX, games, remote desktops). OsClient is opt-in
 * per step — the planner only surfaces os.* verbs when `available()`
 * returns true.
 */

/** One element in the OS accessibility tree. */
export interface OsElement {
  /** Stable ref assigned during snapshot ("e1", "e2", …). Invalid after
   *  the next snapshot() call. */
  ref: string;
  /** Native role string. macOS: AXRole ("AXButton", "AXTextField"); win:
   *  ControlType ("Button", "Edit"). Lowercased to a common token at
   *  serialization time. */
  role: string;
  /** Display name — AXTitle or AutomationProperties.Name. Often the
   *  human-visible label. */
  name?: string;
  /** Current value for editable controls (AXValue / ValuePattern.Value). */
  value?: string;
  /** Help text / longer description. */
  description?: string;
  /** Screen-space bounds. macOS returns global coords (with the existing
   *  multi-monitor offsetX/offsetY math in src/screen.ts); win returns
   *  physical pixels, divide by DPI scale. */
  bounds?: { x: number; y: number; w: number; h: number };
  /** Whether the element currently has keyboard focus. */
  focused?: boolean;
  /** Whether the element responds to actions (AXEnabled / IsEnabled). */
  enabled?: boolean;
  /** Recursive children — populated during tree walks. */
  children?: OsElement[];
}

export interface OsSnapshot {
  /** App / process name of the frontmost window. */
  app: string;
  /** Window title. */
  window: string;
  /** Vimium-style serialized tree text. Same shape as
   *  BrowserSnapshot.ax so the planner prompt template is reusable. */
  ax: string;
  /** When the snapshot was captured (Date.now()). Refs in `ax` are
   *  valid only against the most recent snapshot. */
  capturedAt: number;
}

/** Selector union accepted by os_click / os_type / os_hover / os_drag.
 *  Resolution order in the provider: ref → text → coords. */
export type OsSelector =
  | { ref: string }
  | { text: string }
  | { coords: [number, number] };

export interface OsClientStatus {
  /** Whether the provider is usable on this OS right now. False when
   *  Accessibility permission is denied, the helper binary is missing,
   *  the platform is unsupported, etc. */
  available: boolean;
  /** "mac" | "windows" | "linux" | "null". */
  platform: string;
  /** Human-readable reason when available=false. */
  reason?: string;
}

export interface OsClient {
  /** Probe whether a snapshot would succeed right now. Never throws. */
  available(): Promise<boolean>;
  /** Diagnostic info for tooling / boot logs. */
  status(): Promise<OsClientStatus>;
  /** Capture a structured snapshot of the frontmost window. */
  snapshot(): Promise<OsSnapshot>;
  /** Resolve the selector to (x, y), then click. Reuses src/screen.ts
   *  primitives so cliclick background mode is honored automatically. */
  click(
    selector: OsSelector,
    opts?: {
      button?: "left" | "right";
      mode?: "single" | "double" | "triple";
    },
  ): Promise<{ resolved: ResolvedTarget }>;
  /** Type into the selected element. Prefers AX setValue (no focus
   *  race) when the role supports it; falls back to focus + keystrokes. */
  type(
    selector: OsSelector,
    text: string,
    opts?: { submit?: boolean; clear?: boolean },
  ): Promise<{ resolved: ResolvedTarget }>;
  /** Move the cursor over the element. Caveat: src/screen.ts move() is
   *  a no-op in cliclick background mode — hover returns
   *  noop=true so the planner doesn't loop expecting tooltips. */
  hover(selector: OsSelector): Promise<{ resolved: ResolvedTarget; noop: boolean }>;
  /** Press at `from`, drag to `to`, release. Drag always moves the
   *  visible cursor (CGEvent constraint — see src/screen.ts:584-592). */
  drag(
    from: OsSelector,
    to: OsSelector,
  ): Promise<{ from: ResolvedTarget; to: ResolvedTarget }>;
  /** Release any cached resources (helper subprocesses, etc.). */
  close(): Promise<void>;
}

/** What a selector resolved to — surfaced in tool responses so the
 *  planner knows which element the action actually hit. */
export interface ResolvedTarget {
  x: number;
  y: number;
  ref?: string;
  role?: string;
  name?: string;
  source: "ref" | "text" | "coords";
}
