/**
 * extract — the "read" half of a data task.
 *
 * Turns a whole page's text (from browser_read, Firecrawl-style) into
 * structured rows in ONE fast model pass, instead of the vision loop reading
 * the page one screenshot at a time. Pairs with src/agent/export.ts (copy_table
 * / write_csv) to do "list/export X into a sheet" in a couple of steps.
 *
 * Reuses the planner's TEXT endpoint (DeepSeek v4 Flash via OpenRouter by
 * default) so it shares one API config — no new keys, and it honors the
 * "use the API" provider direction.
 */

import { plannerConfigFromEnv } from "./providers/planner";

export interface ExtractInput {
  /** Page text, typically from browser_read (whole-page cleaned markdown). */
  pageText: string;
  /** Desired columns, in order. If omitted the model infers sensible ones. */
  columns?: string[];
  /** Freeform guidance: what to pull, how to filter. */
  instructions?: string;
  /** Cap on page text sent to the model (token guard). Default 14000 chars. */
  maxChars?: number;
  signal?: AbortSignal;
}

export interface ExtractResult {
  headers: string[];
  rows: string[][];
}

const SYSTEM = `You extract structured tabular data from web page text.
Return ONLY a JSON object of the form {"headers": string[], "rows": string[][]}.
Rules:
- Each row is one record from the page (a listing, product, search result, comment, etc.).
- Use ONLY values actually present in the page text. NEVER invent, guess, or estimate.
- If a value is missing for a row, use an empty string "".
- Every row array length MUST equal headers length.
- Output the JSON object only — no prose, no markdown, no code fences.`;

function buildUser(input: ExtractInput): string {
  const cols =
    input.columns && input.columns.length
      ? `Extract these columns, in this exact order: ${input.columns.join(", ")}.`
      : "Infer a sensible set of columns from the data.";
  const extra = input.instructions ? `\nExtra instructions: ${input.instructions}` : "";
  const max = input.maxChars ?? 14000;
  const text =
    input.pageText.length > max ? input.pageText.slice(0, max) + "\n…(truncated)" : input.pageText;
  return `${cols}${extra}\n\nPAGE TEXT:\n${text}`;
}

/** Tolerant parse: strip think-blocks / code fences, slice to the {...} object.
 *  Falls back to salvage when the model TRUNCATED its JSON (long lists overflow
 *  max_tokens → "Unterminated string"); salvage recovers every COMPLETE row
 *  instead of dropping the whole page. */
export function parseResult(raw: string): ExtractResult {
  let s = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  const sliced = start >= 0 && end > start ? s.slice(start, end + 1) : s;
  try {
    const obj = JSON.parse(sliced) as { headers?: unknown; rows?: unknown };
    const headers = Array.isArray(obj.headers) ? obj.headers.map((h) => String(h)) : [];
    const rows = Array.isArray(obj.rows)
      ? (obj.rows as unknown[]).map((r) =>
          Array.isArray(r) ? r.map((c) => (c == null ? "" : String(c))) : [String(r)],
        )
      : [];
    return { headers, rows };
  } catch {
    return salvageResult(s); // truncated/malformed → recover complete rows
  }
}

/**
 * Recover headers + every COMPLETE row array from a truncated/partial JSON
 * payload. Used when JSON.parse fails (model hit max_tokens mid-array). Scans
 * the "rows" array for balanced [...] sub-arrays (string-aware) and stops at the
 * first incomplete one — so a 200-row list that truncated at row 173 yields 172
 * rows instead of zero.
 */
/** Scan for the next BALANCED [...] array at/after `from`, string-aware (so
 *  brackets inside quoted cells don't fool it). Returns the array text + the
 *  index just past it, or null if none / unterminated (truncated). */
function scanArray(s: string, from: number): { text: string; end: number } | null {
  const i = s.indexOf("[", from);
  if (i < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = i; j < s.length; j++) {
    const ch = s[j]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return { text: s.slice(i, j + 1), end: j + 1 };
    }
  }
  return null; // unterminated
}

function salvageResult(s: string): ExtractResult {
  let headers: string[] = [];
  const hIdx = s.indexOf('"headers"');
  if (hIdx >= 0) {
    const arr = scanArray(s, hIdx); // string-aware — survives a "]" inside a header
    if (arr) {
      try {
        headers = (JSON.parse(arr.text) as unknown[]).map((h) => String(h));
      } catch {
        /* leave empty */
      }
    }
  }
  const rows: string[][] = [];
  const rIdx = s.indexOf('"rows"');
  if (rIdx >= 0) {
    let i = s.indexOf("[", rIdx);
    if (i >= 0) {
      i += 1; // step inside the rows array
      while (i < s.length) {
        while (i < s.length && /[\s,]/.test(s[i]!)) i++; // skip separators
        if (i >= s.length || s[i] !== "[") break; // end of array or truncated
        const arr = scanArray(s, i);
        if (!arr) break; // last row cut off mid-way → stop
        try {
          const a = JSON.parse(arr.text) as unknown[];
          rows.push(a.map((c) => (c == null ? "" : String(c))));
        } catch {
          break;
        }
        i = arr.end;
      }
    }
  }
  return { headers, rows };
}

async function extractOnce(input: ExtractInput): Promise<ExtractResult> {
  const cfg = plannerConfigFromEnv();
  if (!cfg) {
    throw new Error(
      "Extraction needs a text model. Set OPENROUTER_API_KEY (and ensure PONDER_PLANNER is not 'off').",
    );
  }
  // Extraction is on the latency critical path (single ≤10s / bulk ≤30s
  // targets). The default TEXT model (deepseek-v4-flash via OpenRouter) measured
  // ~31s on a 4.6k-char page — far too slow. Use a FAST model: EXTRACT_MODEL
  // override, else the planner's vision endpoint (gemini-2.5-flash), which is
  // a few seconds for the same input. It's a plain text→JSON task, so the
  // vision-capable model handles it fine.
  const overrideModel = process.env.EXTRACT_MODEL?.trim();
  const ep = overrideModel
    ? { ...cfg.text, model: overrideModel }
    : cfg.vision ?? cfg.text;
  const url = `${ep.apiBase}/chat/completions`;
  const res = await (cfg.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ep.apiKey}`,
      ...(ep.apiBase.includes("openrouter.ai")
        ? { "HTTP-Referer": "https://holo.company", "X-Title": "holo3-agent" }
        : {}),
    },
    body: JSON.stringify({
      model: ep.model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: buildUser(input) },
      ],
      temperature: 0,
      // Long lists overflow a small cap and truncate the JSON. 8000 covers the
      // common page; parseResult salvages complete rows if it still truncates.
      max_tokens: 8000,
      response_format: { type: "json_object" },
    }),
    signal: input.signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`extract model ${ep.model} ${res.status}: ${body.slice(0, 300)}`);
  }
  const out = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const raw = out.choices?.[0]?.message?.content ?? "";
  if (!raw.trim()) throw new Error("extract model returned empty content.");
  const result = parseResult(raw);
  // Headers missing but rows present → synthesize generic ones so writers work.
  if (!result.headers.length && result.rows.length) {
    const n = Math.max(...result.rows.map((r) => r.length));
    result.headers = Array.from({ length: n }, (_, i) => `col${i + 1}`);
  }
  return result;
}

/** Split text into ≤max-char chunks at line boundaries (never mid-line). */
function chunkByLines(text: string, max: number): string[] {
  const lines = text.split("\n");
  const chunks: string[] = [];
  let cur = "";
  for (const line of lines) {
    if (cur && cur.length + line.length + 1 > max) {
      chunks.push(cur);
      cur = "";
    }
    cur += (cur ? "\n" : "") + line;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** Merge chunk results: first non-empty headers, rows concatenated + deduped. */
function mergeResults(parts: ExtractResult[]): ExtractResult {
  const headers = parts.find((p) => p.headers.length)?.headers ?? [];
  const seen = new Set<string>();
  const rows: string[][] = [];
  for (const p of parts) {
    for (const r of p.rows) {
      const key = r.join("").toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        rows.push(r);
      }
    }
  }
  return { headers, rows };
}

/**
 * Extract rows from page text. Small inputs → one model pass (fast). Large
 * inputs (> maxChars) → split at line boundaries, extract the chunks IN
 * PARALLEL, then merge + dedupe. This COMPLETES long lists (vs the old
 * truncate-and-lose, which dropped most of a 100-row table) and keeps
 * wall-clock down by parallelizing — the #6 benchmark showed extraction, not
 * fetch, is the bottleneck and the 14k cap was costing rows.
 */
export async function extractRows(input: ExtractInput): Promise<ExtractResult> {
  const max = input.maxChars ?? 14000;
  if (input.pageText.length <= max) return extractOnce(input);
  const chunks = chunkByLines(input.pageText, max);
  const CONCURRENCY = 4; // bound parallel model calls (rate / cost)
  const parts: ExtractResult[] = [];
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(
      batch.map((c) =>
        extractOnce({ ...input, pageText: c, maxChars: max }).catch(
          () => ({ headers: [], rows: [] }) as ExtractResult,
        ),
      ),
    );
    parts.push(...settled);
  }
  return mergeResults(parts);
}
