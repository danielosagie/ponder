/**
 * Tree → text serializer, shared by every platform provider. Output
 * shape mirrors BrowserSnapshot.ax (Vimium-style flat lines with [eN]
 * refs) so the planner prompt template is reusable.
 *
 * Example output:
 *   [e1] window "Bluetooth"
 *     [e2] button "Back"
 *     [e3] switch "Bluetooth" (value: 1)
 *     [e4] table
 *       [e5] row "Magic Mouse" (value: Connected)
 *
 * Indentation reflects tree depth. Only "interesting" nodes are
 * surfaced (interactable controls, named groups, text with content) —
 * a typical window emits 30-200 lines.
 */

import type { OsElement } from "./types.js";

/** Roles we skip entirely unless they have children worth showing. */
const STRUCTURAL_ROLES = new Set([
  "axgroup",
  "axsplitgroup",
  "axlayoutarea",
  "axunknown",
  "group", // win UIA
  "pane",
  "custom",
]);

/** Roles we always surface even with no name. */
const INTERACTIVE_ROLES = new Set([
  "axbutton",
  "axcheckbox",
  "axradiobutton",
  "axtextfield",
  "axtextarea",
  "axsearchfield",
  "axpopupbutton",
  "axmenubutton",
  "axslider",
  "axswitch",
  "axlink",
  "axtab",
  "axdisclosuretriangle",
  "button",
  "checkbox",
  "radiobutton",
  "edit",
  "combobox",
  "slider",
  "hyperlink",
  "tabitem",
  "menuitem",
  "treeitem",
]);

function normalizeRole(role: string): string {
  return role.toLowerCase();
}

/** Strip the "AX" prefix for the serialized form so output is readable. */
function displayRole(role: string): string {
  const lower = role.toLowerCase();
  return lower.startsWith("ax") ? lower.slice(2) : lower;
}

function quote(s: string): string {
  // Keep names short and one-line. Long values get truncated; the
  // planner doesn't need every word of a tooltip.
  const trimmed = s.replace(/\s+/g, " ").trim();
  const max = 80;
  const body = trimmed.length > max ? trimmed.slice(0, max - 1) + "…" : trimmed;
  return `"${body.replace(/"/g, '\\"')}"`;
}

function shouldSurface(el: OsElement): boolean {
  const role = normalizeRole(el.role);
  if (INTERACTIVE_ROLES.has(role)) return true;
  if (el.name && el.name.trim().length > 0) return true;
  if (el.value && el.value.trim().length > 0) return true;
  // Structural-only nodes get pruned but their children may still
  // matter — caller decides via descend-without-emit below.
  if (STRUCTURAL_ROLES.has(role)) return false;
  // Everything else with at least a role — emit so we don't drop
  // signal accidentally during the prototype.
  return true;
}

function serialize(el: OsElement, depth: number, out: string[]): void {
  const indent = "  ".repeat(depth);
  const role = displayRole(el.role);
  const parts: string[] = [`[${el.ref}]`, role];
  if (el.name) parts.push(quote(el.name));
  const flags: string[] = [];
  if (el.value && el.value.length > 0) flags.push(`value: ${quote(el.value)}`);
  if (el.enabled === false) flags.push("disabled");
  if (el.focused === true) flags.push("focused");
  if (flags.length > 0) parts.push(`(${flags.join(", ")})`);
  out.push(indent + parts.join(" "));
}

/**
 * Walk the tree, emit lines for interesting nodes. Non-interesting
 * structural nodes are skipped but their children are visited at the
 * same indent depth so the output stays flat-ish.
 */
export function serializeTree(roots: OsElement[]): string {
  const out: string[] = [];

  function walk(el: OsElement, depth: number): void {
    const surface = shouldSurface(el);
    if (surface) {
      serialize(el, depth, out);
    }
    const childDepth = surface ? depth + 1 : depth;
    for (const child of el.children ?? []) {
      walk(child, childDepth);
    }
  }

  for (const r of roots) walk(r, 0);
  return out.join("\n");
}
