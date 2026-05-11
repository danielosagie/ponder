/**
 * macOS AX node addon. The module exports null when the native binary
 * isn't loaded (non-darwin platform, addon not rebuilt for the current
 * Electron ABI, etc.), so consumers must null-check.
 */

export interface AxNode {
  handle: string;
  role?: string;
  name?: string;
  value?: string;
  description?: string;
  enabled?: boolean;
  focused?: boolean;
  bounds?: { x: number; y: number; w: number; h: number };
  children?: AxNode[];
}

export interface DumpResult {
  app: string;
  window: string;
  pid: number;
  tree: AxNode[];
}

export interface MacAx {
  dump(opts?: { pid?: number; maxDepth?: number }): DumpResult;
  perform(opts: { handle: string; action: string }): { ok: true };
  setValue(opts: { handle: string; value: string }): { ok: true };
  resolve(opts: { handle: string }): {
    x?: number;
    y?: number;
    w?: number;
    h?: number;
    enabled?: boolean;
    focused?: boolean;
  };
  isTrusted(): boolean;
}

declare const mod: MacAx | null;
export default mod;
