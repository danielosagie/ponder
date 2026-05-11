/**
 * macOS provider — routes through the Electron bridge at 127.0.0.1:7900,
 * the same way every other screen.* primitive does (see
 * tryBridgeScreenCall in src/mcp/tools.ts). The bridge loads the
 * @ponder/mac-ax native addon, which walks AXUIElement inside the
 * Electron process — so the user's existing Accessibility grant on the
 * Holo3 app covers everything. No separate sidecar, no second perms
 * prompt for the tsx MCP child.
 *
 * Provider responsibilities:
 *   • POST /os/snapshot, walk the returned raw tree, assign [eN] refs,
 *     serialize to Vimium-style text via shared snapshot.ts.
 *   • Resolve OsSelector → (x, y) using cached bounds.
 *   • For click/drag/hover, POST /screen/{click,drag} — same routes the
 *     vision-grounded path uses. Multi-monitor coord translation and
 *     cliclick background mode are handled there.
 *   • For type, prefer POST /os/set-value when the AX role accepts it
 *     (textfield, textarea, searchfield, combobox); fall back to focus
 *     click + /screen/type when it doesn't.
 *
 * If the bridge is down (no Electron app running), the provider's
 * available() returns false and the MCP tool surfaces a clear setup
 * hint pointing at `npm run dev` and the native build step.
 */

import { RefStore } from "../refs.js";
import { serializeTree } from "../snapshot.js";
import type {
  OsClient,
  OsClientStatus,
  OsElement,
  OsSelector,
  OsSnapshot,
  ResolvedTarget,
} from "../types.js";

const BRIDGE_PORT = Number(process.env.PONDER_BRIDGE_PORT ?? 7900);
const BRIDGE_BASE = `http://127.0.0.1:${BRIDGE_PORT}`;

interface AxNodeRaw {
  handle: string;
  role?: string;
  name?: string;
  value?: string;
  description?: string;
  enabled?: boolean;
  focused?: boolean;
  bounds?: { x: number; y: number; w: number; h: number };
  children?: AxNodeRaw[];
}

interface DumpResponse {
  app?: string;
  window?: string;
  pid?: number;
  tree?: AxNodeRaw[];
  error?: string;
}

async function bridgeFetch<T>(
  path: string,
  body?: object,
  timeoutMs = 3000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BRIDGE_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
    const parsed = (await res.json()) as unknown;
    if (!res.ok) {
      const detail =
        parsed && typeof parsed === "object" && "error" in parsed
          ? (parsed as { error: unknown }).error
          : `HTTP ${res.status}`;
      throw new Error(`bridge ${path} failed: ${String(detail)}`);
    }
    return parsed as T;
  } finally {
    clearTimeout(timer);
  }
}

async function bridgeHealthy(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 800);
    const res = await fetch(`${BRIDGE_BASE}/health`, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

function convertNode(
  node: AxNodeRaw,
  store: RefStore<{ handle: string }>,
): OsElement {
  const el: OsElement = {
    ref: "",
    role: node.role ?? "unknown",
    name: node.name,
    value: node.value,
    description: node.description,
    enabled: node.enabled,
    focused: node.focused,
    bounds: node.bounds,
    children: undefined,
  };
  store.assign({ handle: node.handle }, el);
  if (node.children && node.children.length > 0) {
    el.children = node.children.map((c) => convertNode(c, store));
  }
  return el;
}

export function createMacOsClient(): OsClient {
  const store = new RefStore<{ handle: string }>();

  async function check(): Promise<OsClientStatus> {
    if (process.platform !== "darwin") {
      return { available: false, platform: "mac", reason: "Not macOS." };
    }
    if (!(await bridgeHealthy())) {
      return {
        available: false,
        platform: "mac",
        reason:
          "Electron bridge at 127.0.0.1:" +
          BRIDGE_PORT +
          " is not reachable. Start the Holo3 app (`npm run dev`) so the bridge is alive.",
      };
    }
    // Cheapest probe of the native addon: a tiny dump with maxDepth 0
    // is bounded by the time to walk an app + its root window only.
    try {
      const probe = await bridgeFetch<DumpResponse>(
        "/os/snapshot",
        { maxDepth: 0 },
        1500,
      );
      if (probe.error) {
        return {
          available: false,
          platform: "mac",
          reason: probe.error,
        };
      }
      return { available: true, platform: "mac" };
    } catch (e) {
      return {
        available: false,
        platform: "mac",
        reason: e instanceof Error ? e.message : String(e),
      };
    }
  }

  async function snapshot(): Promise<OsSnapshot> {
    const dump = await bridgeFetch<DumpResponse>("/os/snapshot");
    if (dump.error) {
      throw new Error(dump.error);
    }
    if (!dump.tree) {
      throw new Error("bridge returned no tree");
    }
    store.reset();
    const roots = dump.tree.map((n) => convertNode(n, store));
    return {
      app: dump.app ?? "Unknown",
      window: dump.window ?? "",
      ax: serializeTree(roots),
      capturedAt: Date.now(),
    };
  }

  async function resolve(selector: OsSelector): Promise<ResolvedTarget> {
    if ("ref" in selector) {
      const entry = store.lookup(selector.ref);
      if (!entry) {
        throw new Error(
          `Ref '${selector.ref}' not found; call os_snapshot first (refs are invalidated on every snapshot).`,
        );
      }
      const b = entry.element.bounds;
      if (!b) throw new Error(`Ref '${selector.ref}' has no bounds.`);
      return {
        x: b.x + b.w / 2,
        y: b.y + b.h / 2,
        ref: selector.ref,
        role: entry.element.role,
        name: entry.element.name,
        source: "ref",
      };
    }
    if ("text" in selector) {
      if (store.size() === 0) await snapshot();
      const entry = store.findByText(selector.text);
      if (!entry) {
        throw new Error(
          `No element matches text '${selector.text}' in the current snapshot.`,
        );
      }
      const b = entry.element.bounds;
      if (!b) throw new Error(`Matched element has no bounds.`);
      return {
        x: b.x + b.w / 2,
        y: b.y + b.h / 2,
        ref: entry.element.ref,
        role: entry.element.role,
        name: entry.element.name,
        source: "text",
      };
    }
    return {
      x: selector.coords[0],
      y: selector.coords[1],
      source: "coords",
    };
  }

  return {
    available: async () => (await check()).available,
    status: check,
    snapshot,
    async click(selector, opts = {}) {
      const target = await resolve(selector);
      const mode =
        opts.button === "right"
          ? "right"
          : opts.mode === "double"
            ? "double"
            : opts.mode === "triple"
              ? "triple"
              : "single";
      await bridgeFetch("/screen/click", {
        x: Math.round(target.x),
        y: Math.round(target.y),
        mode,
      });
      return { resolved: target };
    },
    async type(selector, text, opts = {}) {
      const target = await resolve(selector);
      const role = (target.role ?? "").toLowerCase();
      const canSetValue =
        role.includes("textfield") ||
        role.includes("textarea") ||
        role.includes("searchfield") ||
        role.includes("combobox");
      if (canSetValue && target.ref) {
        const entry = store.lookup(target.ref);
        if (entry) {
          try {
            const setRes = await bridgeFetch<{ ok?: boolean; error?: string }>(
              "/os/set-value",
              { handle: entry.handle.handle, value: text },
            );
            if (setRes.ok) {
              if (opts.submit) {
                await bridgeFetch("/screen/hotkey", { combo: "enter" });
              }
              return { resolved: target };
            }
            // fall through to keystroke path on error
          } catch {
            // fall through
          }
        }
      }
      await bridgeFetch("/screen/click", {
        x: Math.round(target.x),
        y: Math.round(target.y),
        mode: "single",
      });
      if (opts.clear) {
        await bridgeFetch("/screen/hotkey", { combo: "cmd+a" });
        await bridgeFetch("/screen/hotkey", { combo: "delete" });
      }
      await bridgeFetch("/screen/type", {
        text,
        ...(opts.submit ? { thenPress: "enter" } : {}),
      });
      return { resolved: target };
    },
    async hover(selector) {
      const target = await resolve(selector);
      // No bridge route for hover yet — and screen.move() is a no-op in
      // cliclick background mode anyway. Surface noop=true so the
      // planner doesn't loop waiting for tooltips.
      return { resolved: target, noop: true };
    },
    async drag(from, to) {
      const a = await resolve(from);
      const b = await resolve(to);
      await bridgeFetch("/screen/drag", {
        fromX: Math.round(a.x),
        fromY: Math.round(a.y),
        toX: Math.round(b.x),
        toY: Math.round(b.y),
      });
      return { from: a, to: b };
    },
    async close() {
      store.reset();
    },
  };
}
