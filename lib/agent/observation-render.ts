// General, reusable rendering of a tool OBSERVATION into readable prose.
//
// WHY THIS EXISTS (production defect, agent_conversations id
// 2ad98991-bae2-4847-a5a3-3f7422aad12e, message 48): lib/agent/loop.ts's
// buildSalvageMessage() used to render every observation with a flat
// `truncate(obs, 400)` — a lead LIST came through as raw `{"id":"4eeae0ec-…`
// JSON cut mid-value, a sender PERSONA (a single object) the same way, and a
// BATCH of 25 drafted emails as one unreadable clipped blob. Three different
// tools, three different payload shapes, all unreadable the same way.
//
// THE PRINCIPLE: every tool result that reaches a human must be readable
// prose, driven by the PAYLOAD'S OWN SHAPE — never a tool-name allowlist.
// There are 182 tools; an allowlist rots the moment one is added, and a
// listLeads-shaped array of records looks exactly like a listCompanies- or
// listSequences-shaped one from here, because they ARE the same shape.
//
// Deliberately NOT a re-summarization by another model call — the premise is
// that the model path already failed (or the caller just wants a synchronous
// render), so this mechanically formats what is already present. Never
// invents anything: an unparseable payload falls back to the previous
// truncated-raw-text behaviour for THAT item only, and nothing here throws —
// every entry point is wrapped so one bad payload cannot lose the rest of a
// larger message built around it.
//
// EXPORTED so any other call site that shows a tool result to a human (chat
// history displays, transcripts, debug/ops views) can reuse this instead of
// re-inventing flat truncation. Today the only caller is
// lib/agent/loop.ts's buildSalvageMessage(); candidates to adopt it next are
// noted in that function's own comment.

/** Matches batchSummary()'s (lib/agent/batch.ts) two header shapes exactly:
 *  "<tool>: all <N> succeeded." / "<tool>: <k> of <N> succeeded, <f> failed." */
const BATCH_HEADER_RE = /^(.+?): (?:all \d+ succeeded|\d+ of \d+ succeeded, \d+ failed)\.$/;
/** Matches one batchObservation() item line: "[n] ok — " / "[n] FAILED — ". */
const BATCH_ITEM_RE = /^\[(\d+)\] (ok — |FAILED — )/;

/** An array of RECORDS (objects) longer than this renders only the first N,
 *  with the rest folded into a stated "… and N more" line — never silently
 *  dropped, but also never dumping hundreds of rows into a chat message. */
const MAX_ARRAY_RECORDS = 20;

function truncate(s: string, limit: number): string {
  return s.length > limit ? `${s.slice(0, limit)}… [truncated]` : s;
}

/** Best-effort JSON.parse. Returns undefined (never throws) for anything
 *  that isn't a JSON object/array — including plain strings/numbers, which
 *  render fine as-is via the truncate() fallback and don't need parsing. */
function tryParseJson(s: string): any {
  const t = s.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** One record (object) rendered as `key: value, key: value, …` — every field
 *  IT actually has, in its own key order, nulls/undefined/empty dropped. No
 *  field-name allowlist: a lead reads as name/title/company/email because
 *  those are its keys, a company would read as whatever ITS keys are. */
function renderRecordFields(obj: Record<string, any>): string {
  const entries = Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!entries.length) return '(empty record)';
  return entries.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ');
}

/** Matches createFile's result shape (lib/capabilities/deliverables.ts) — and
 *  any other tool that hands back a file the same way, since this keys on
 *  shape, not on the tool name. A real produced-file result always carries a
 *  non-empty string `url` (where the bytes live) AND a non-empty string
 *  `filename` (what to call them) together; `format`/`mimeType`/`bytes`/
 *  `description` are read if present but not required. Requiring BOTH fields
 *  as non-empty strings is what keeps this from mis-firing: plenty of other
 *  records carry a bare `url` (a lead's company website, a social post link)
 *  but none of those also carry a `filename` — that pairing is specific to a
 *  produced file, so a listLeads row with a `url` field renders as a normal
 *  record, never as a bogus "file ready" line. */
function isFileValue(value: Record<string, any>): value is {
  url: string; filename: string; format?: string; mimeType?: string; bytes?: number; description?: string | null;
} {
  return typeof value.url === 'string' && value.url.length > 0
    && typeof value.filename === 'string' && value.filename.length > 0;
}

/** Render the file shape as prose naming the file and its link — never raw
 *  JSON. Mirrors createFile's own digest() line (lib/capabilities/
 *  deliverables.ts) so the two stay consistent, but this path also covers a
 *  tool that produced a file WITHOUT declaring a digest, or one whose digest
 *  fell through to the raw-JSON fallback (see buildObservation in
 *  lib/agent/loop.ts) — this is what renders that raw JSON readably. */
function renderFileValue(value: { url: string; filename: string; format?: string; mimeType?: string; bytes?: number; description?: string | null }): string {
  const kb = typeof value.bytes === 'number' && value.bytes >= 0 ? ` (${Math.max(1, Math.round(value.bytes / 1024))} KB)` : '';
  const kind = typeof value.format === 'string' && value.format ? ` (${value.format})` : '';
  const lines = [`File ready: ${value.filename}${kind}${kb}`, `Link: ${value.url}`];
  if (value.description) lines.push(String(value.description));
  return lines.join('\n');
}

/** Render one parsed JSON value as readable text. Shape-driven, in order:
 *   - An object carrying `url` + `filename` (a produced-file result, e.g.
 *     createFile's) renders as a readable "file ready" line with its link —
 *     because THOSE are its keys, not because of which tool ran.
 *   - An object with string `subject` + `body` (the drafted-email shape,
 *     e.g. draftOutreach's result) renders as a readable email — because
 *     THOSE are its keys, not because of which tool ran.
 *   - Any other single object renders as labelled fields, nulls/empties
 *     dropped (a sender persona with `role: null` shows no "role" line).
 *   - An array of objects (a lead list, a company list, …) renders as a
 *     readable list of records, each one's fields as above, capped at
 *     MAX_ARRAY_RECORDS with a stated omission count.
 *   - An array of primitives renders as a count plus its members.
 *   - Anything else (string/number/boolean) renders via String(). */
export function renderJsonValue(value: any): string {
  if (Array.isArray(value)) return renderArray(value);
  if (value && typeof value === 'object') return renderObjectValue(value);
  return String(value);
}

function renderObjectValue(value: Record<string, any>): string {
  if (isFileValue(value)) return renderFileValue(value);
  if (typeof value.subject === 'string' && typeof value.body === 'string') {
    const extras = Object.entries(value)
      .filter(([k, v]) => k !== 'subject' && k !== 'body' && v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    return [`Subject: ${value.subject}`, '', value.body, ...(extras.length ? ['', ...extras] : [])].join('\n');
  }
  const entries = Object.entries(value).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!entries.length) return '(empty result)';
  return entries.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n');
}

function renderArray(value: any[]): string {
  if (!value.length) return '(0 items)';
  const hasRecords = value.some((v) => v && typeof v === 'object' && !Array.isArray(v));
  if (!hasRecords) {
    return `${value.length} item${value.length === 1 ? '' : 's'}: ${value
      .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
      .join(', ')}`;
  }
  const shown = value.slice(0, MAX_ARRAY_RECORDS);
  const lines = shown.map((v, i) => {
    const rendered = v && typeof v === 'object' && !Array.isArray(v)
      ? renderRecordFields(v)
      : (typeof v === 'string' ? v : JSON.stringify(v));
    return `  ${i + 1}. ${rendered}`;
  });
  const omitted = value.length - shown.length;
  const header = `${value.length} record${value.length === 1 ? '' : 's'}:`;
  return [
    header,
    ...lines,
    ...(omitted > 0 ? [`  … and ${omitted} more (omitted for length — the count above still covers them).`] : []),
  ].join('\n');
}

/** Public shape of a produced file, as parsed off an observation's raw JSON
 *  by parseFileFromObservation() below. */
export interface ObservedFile {
  url: string; filename: string; format?: string; mimeType?: string; bytes?: number; description?: string | null;
}

/** Pull the file-shaped payload (if any) out of a raw observation string, for
 *  callers that want the structured fields themselves rather than
 *  renderObservation()'s prose — e.g. a UI that draws a file card with a
 *  preview. Same digest+raw / raw-alone parsing renderPayload() does, and the
 *  same isFileValue() shape predicate, so this can never disagree with what
 *  renderObservation() would have shown for the same text. Returns undefined
 *  (never throws) for anything that isn't a file-shaped payload. */
export function parseFileFromObservation(text: string): ObservedFile | undefined {
  try {
    const nl = text.indexOf('\n');
    const rest = nl > 0 ? text.slice(nl + 1) : text;
    const parsed = tryParseJson(rest) ?? tryParseJson(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && isFileValue(parsed)) {
      return parsed;
    }
  } catch {
    // Malformed payload — no file to show, same as "no digest".
  }
  return undefined;
}

/** Render one call's payload — the text after a batch item's "ok — ", or a
 *  whole non-batch observation. Two shapes it recognises, both produced by
 *  lib/agent/loop.ts's successObservation():
 *   1. `${digest}\n${raw}` — a short digest line followed by the raw
 *      `JSON.stringify(result)`. The digest is kept (it is already a
 *      truthful summary), and the raw JSON is parsed and rendered readably
 *      underneath it — not discarded, and never re-dumped as JSON.
 *   2. `raw` alone (no digest) — parsed and rendered readably on its own.
 *  Anything that will not parse as JSON falls back to the previous
 *  truncated-raw-text behaviour, bounded by `budget`. Never throws. */
export function renderPayload(text: string, budget: number): string {
  try {
    const nl = text.indexOf('\n');
    if (nl > 0) {
      const head = text.slice(0, nl).trim();
      const rest = text.slice(nl + 1);
      const parsed = tryParseJson(rest);
      if (head && parsed !== undefined) {
        const rendered = renderJsonValue(parsed);
        return truncate(`${head}\n${rendered}`, budget);
      }
    }
    const parsed = tryParseJson(text);
    if (parsed !== undefined) {
      return truncate(renderJsonValue(parsed), budget);
    }
  } catch {
    // Any unexpected failure above falls through to the plain-text fallback
    // below — a malformed payload degrades for THIS item only, it never
    // takes down whatever larger message is being built around it.
  }
  return truncate(text, budget);
}

/** Render one observation for a human. Detects the batchObservation() shape
 *  (a batchSummary() header line, then one `[n] ok — ` / `[n] FAILED — ` line
 *  per call) and renders every item — successes readably via renderPayload(),
 *  failures with their reason kept verbatim, budget spent per item rather
 *  than as one flat cap over the whole thing, and an item is either shown in
 *  full or (once the budget is spent) omitted and counted in a trailing
 *  "… and N more" line — never silently dropped. A non-batch observation
 *  renders as one payload via renderPayload(). Never throws — falls back to
 *  the previous flat-truncate behaviour for the whole text on any failure. */
export function renderObservation(observation: string, budget: number): string {
  try {
    const lines = observation.split('\n');
    if (BATCH_HEADER_RE.test(lines[0] || '')) {
      const header = lines[0];
      const items: { idx: string; ok: boolean; text: string }[] = [];
      for (let i = 1; i < lines.length; i++) {
        const m = BATCH_ITEM_RE.exec(lines[i]);
        if (m) {
          items.push({ idx: m[1], ok: m[2].startsWith('ok'), text: lines[i].slice(m[0].length) });
        } else if (items.length) {
          // A continuation line (e.g. a digest+raw item payload carrying its
          // own real newline) belongs to the item currently being built.
          items[items.length - 1].text += `\n${lines[i]}`;
        }
      }
      if (items.length) {
        const out = [header];
        let used = header.length;
        let shown = 0;
        for (const item of items) {
          const rendered = item.ok ? renderPayload(item.text, budget) : truncate(item.text, budget);
          const line = `  [${item.idx}] ${item.ok ? 'ok' : 'FAILED'} — ${rendered}`;
          if (shown > 0 && used + line.length + 1 > budget) break;
          out.push(line);
          used += line.length + 1;
          shown += 1;
        }
        if (shown < items.length) {
          out.push(`  … and ${items.length - shown} more (omitted for length — the counts above still cover them).`);
        }
        return out.join('\n');
      }
      // Header matched but no item lines parsed (shouldn't happen for a real
      // batchObservation) — fall through to plain payload rendering below.
    }
    return renderPayload(observation, budget);
  } catch {
    return truncate(observation, budget);
  }
}
