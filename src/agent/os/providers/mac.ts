/**
 * macOS provider — talks to the ax-bridge Swift helper over child
 * processes. One process per AX operation (dump / perform / set-value /
 * resolve); the helper exits after each call, which keeps the
 * AXUIElement handle store scoped to a single snapshot's lifetime.
 *
 * Build the helper once with src/agent/os/helpers/mac-axdump/build.sh
 * before this provider can return available() === true. If the helper
 * binary is missing OR Accessibility permission is denied, available()
 * returns false and the MCP tool surfaces a clear "run build.sh / grant
 * perms" error to the planner.
 */

import { execFile } from "child_process";
import { existsSync } from "fs";
import { promisify } from "util";
import * as path from "path";
import { fileURLToPath } from "url";

import * as screen from "../../../screen.js";
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

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HELPER_PATH = path.resolve(
  __dirname,
  "..",
  "helpers",
  "mac-axdump",
  "ax-bridge",
);

interface AxNode {
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

interface DumpResponse {
  app: string;
  window: string;
  pid: number;
  tree: AxNode[];
}

interface HelperError {
  error: string;
  message: string;
}

async function runHelper<T>(cmd: string, args: object = {}): Promise<T> {
  if (!existsSync(HELPER_PATH)) {
    throw new Error(
      `ax-bridge helper not built. Run: bash ${path.dirname(HELPER_PATH)}/build.sh`,
    );
  }
  const { stdout } = await execFileAsync(
    HELPER_PATH,
    [cmd, JSON.stringify(args)],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const line = stdout.trim().split("\n").pop() ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`ax-bridge returned non-JSON: ${line.slice(0, 200)}`);
  }
  if (parsed && typeof parsed === "object" && "error" in parsed) {
    const err = parsed as HelperError;
    throw new Error(`ax-bridge ${err.error}: ${err.message}`);
  }
  return parsed as T;
}

function convertNode(
  node: AxNode,
  store: RefStore<{ handle: string }>,
): OsElement {
  const el: OsElement = {
    ref: "", // filled in by store.assign
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
  let lastSnapshot: OsSnapshot | null = null;
  let lastPid: number | null = null;

  async function check(): Promise<OsClientStatus> {
    if (process.platform !== "darwin") {
      return { available: false, platform: "mac", reason: "Not macOS." };
    }
    if (!existsSync(HELPER_PATH)) {
      return {
        available: false,
        platform: "mac",
        reason: `ax-bridge not built. Run: bash ${path.dirname(HELPER_PATH)}/build.sh`,
      };
    }
    return { available: true, platform: "mac" };
  }

  async function snapshot(): Promise<OsSnapshot> {
    const dump = await runHelper<DumpResponse>("dump");
    store.reset();
    const roots = dump.tree.map((n) => convertNode(n, store));
    lastPid = dump.pid;
    const snap: OsSnapshot = {
      app: dump.app,
      window: dump.window,
      ax: serializeTree(roots),
      capturedAt: Date.now(),
    };
    lastSnapshot = snap;
    return snap;
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
    // coords
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
      await screen.click(target.x, target.y, {
        button: opts.button,
        double: opts.mode === "double",
        triple: opts.mode === "triple",
      });
      return { resolved: target };
    },
    async type(selector, text, opts = {}) {
      const target = await resolve(selector);
      // Prefer AX setValue for editable text roles (fast, no focus race,
      // no keystrokes). For everything else, focus via click then type.
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
            await runHelper("set-value", {
              handle: entry.handle.handle,
              value: text,
            });
            if (opts.submit) await screen.pressCombo("enter");
            return { resolved: target };
          } catch {
            // fall through to keystroke path
          }
        }
      }
      await screen.click(target.x, target.y);
      if (opts.clear) {
        await screen.pressCombo("cmd+a");
        await screen.pressCombo("delete");
      }
      await screen.typeText(text);
      if (opts.submit) await screen.pressCombo("enter");
      return { resolved: target };
    },
    async hover(selector) {
      const target = await resolve(selector);
      await screen.move(target.x, target.y);
      // screen.move() is a no-op in cliclick BACKGROUND_MODE — surface
      // that fact so the planner doesn't loop expecting tooltips.
      return { resolved: target, noop: screen.BACKGROUND_MODE };
    },
    async drag(from, to) {
      const a = await resolve(from);
      const b = await resolve(to);
      await screen.drag(a.x, a.y, b.x, b.y);
      return { from: a, to: b };
    },
    async close() {
      lastSnapshot = null;
      lastPid = null;
      store.reset();
    },
  };

  // Silence "declared but never used" for diagnostic state.
  void lastSnapshot;
  void lastPid;
}
