/**
 * Ref store — assigns "e1", "e2", … to elements during a snapshot walk
 * and lets the provider translate a ref back to its platform-specific
 * handle (mac: AXIdentifier or AXUIElementRef; win: runtimeId array).
 *
 * Lifecycle: refs are valid until the next snapshot() call. Stale-ref
 * lookups return undefined and the tool surfaces a clear "call
 * os_snapshot first" error to the planner.
 */

import type { OsElement } from "./types.js";

export class RefStore<Handle> {
  private nextId = 1;
  private byRef = new Map<string, { handle: Handle; element: OsElement }>();

  reset(): void {
    this.nextId = 1;
    this.byRef.clear();
  }

  /** Allocate a fresh "eN" ref and bind it to the given handle. */
  assign(handle: Handle, element: OsElement): string {
    const ref = `e${this.nextId++}`;
    element.ref = ref;
    this.byRef.set(ref, { handle, element });
    return ref;
  }

  lookup(ref: string): { handle: Handle; element: OsElement } | undefined {
    return this.byRef.get(ref);
  }

  /** Linear scan for name/value/description match — used by the `text`
   *  selector fallback. Case-insensitive substring match. Returns the
   *  first hit; callers should re-snapshot for ambiguity. */
  findByText(text: string): { handle: Handle; element: OsElement } | undefined {
    const q = text.toLowerCase();
    for (const entry of this.byRef.values()) {
      const e = entry.element;
      if (
        (e.name && e.name.toLowerCase().includes(q)) ||
        (e.value && e.value.toLowerCase().includes(q)) ||
        (e.description && e.description.toLowerCase().includes(q))
      ) {
        return entry;
      }
    }
    return undefined;
  }

  size(): number {
    return this.byRef.size;
  }
}
