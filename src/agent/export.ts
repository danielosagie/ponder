/**
 * Bulk export helpers — the "write" half of a data task.
 *
 * The agent reads a page into structured rows; these turn those rows into a
 * destination in ONE action instead of typing cells one by one:
 *   • toCsv / writeCsvFile — a .csv file on disk.
 *   • toTsv / copyToClipboard — TSV on the system clipboard. Paste (Cmd/Ctrl+V)
 *     into a Google Sheet / Excel cell and the grid fills itself — no Sheets
 *     API, no OAuth, reuses the browser session the agent already has.
 *
 * Pure Node (no Electron) so both the MCP server process and the Electron main
 * can import it. Cross-platform clipboard (pbcopy / clip / xclip|xsel).
 */

import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/** A table is rows of cells, either array-of-arrays or array-of-objects. */
export interface TableInput {
  rows: Array<Array<unknown>> | Array<Record<string, unknown>>;
  headers?: string[];
}

const cell = (v: unknown): string => (v == null ? "" : String(v));

/** Normalize either row shape → explicit headers + string matrix. */
export function normalizeTable(input: TableInput): { headers: string[]; rows: string[][] } {
  const rows = input.rows ?? [];
  let headers = input.headers ?? [];
  if (rows.length > 0 && !Array.isArray(rows[0])) {
    // array of objects — derive headers from the union of keys if not given.
    const objs = rows as Array<Record<string, unknown>>;
    if (headers.length === 0) {
      const seen = new Set<string>();
      for (const o of objs) for (const k of Object.keys(o)) seen.add(k);
      headers = [...seen];
    }
    return { headers, rows: objs.map((o) => headers.map((h) => cell(o[h]))) };
  }
  return { headers, rows: (rows as Array<Array<unknown>>).map((r) => r.map(cell)) };
}

/** RFC-4180 field quoting. */
function csvField(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(input: TableInput): string {
  const { headers, rows } = normalizeTable(input);
  const lines: string[] = [];
  if (headers.length) lines.push(headers.map(csvField).join(","));
  for (const r of rows) lines.push(r.map(csvField).join(","));
  return lines.join("\n");
}

export function toTsv(input: TableInput): string {
  const { headers, rows } = normalizeTable(input);
  // TSV cells can't hold tabs/newlines — collapse so a sheet paste stays aligned.
  const flat = (s: string): string => s.replace(/[\t\r\n]+/g, " ").trim();
  const lines: string[] = [];
  if (headers.length) lines.push(headers.map(flat).join("\t"));
  for (const r of rows) lines.push(r.map(flat).join("\t"));
  return lines.join("\n");
}

function timestamp(): string {
  // Date is fine here (real Node runtime, not a sandboxed workflow script).
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/** Write a CSV file, defaulting to ~/Downloads. Returns the absolute path. */
export function writeCsvFile(input: TableInput, path?: string): string {
  const target = path ?? join(homedir(), "Downloads", `holo3-export-${timestamp()}.csv`);
  writeFileSync(target, toCsv(input), "utf-8");
  return target;
}

/** Copy text to the OS clipboard (macOS pbcopy → win clip → linux xclip/xsel). */
export function copyToClipboard(text: string): void {
  const plat = process.platform;
  try {
    if (plat === "darwin") {
      execFileSync("pbcopy", { input: text });
    } else if (plat === "win32") {
      execFileSync("clip", { input: text });
    } else {
      try {
        execFileSync("xclip", ["-selection", "clipboard"], { input: text });
      } catch {
        execFileSync("xsel", ["--clipboard", "--input"], { input: text });
      }
    }
  } catch (e) {
    throw new Error(
      `Clipboard copy failed on ${plat}: ${(e as Error).message}. ` +
        (plat === "linux" ? "Install xclip or xsel." : ""),
    );
  }
}

/** Convenience: copy a table to the clipboard as TSV. Returns row/col counts. */
export function copyTableToClipboard(input: TableInput): { rows: number; cols: number } {
  const { headers, rows } = normalizeTable(input);
  copyToClipboard(toTsv(input));
  return { rows: rows.length, cols: headers.length || rows[0]?.length || 0 };
}
