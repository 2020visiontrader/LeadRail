'use client';
import { useState } from 'react';
import Markdown from '@/components/Markdown';
import type { ObservedFile } from '@/lib/agent/observation-render';

// Renders a produced file (createFile's result shape — see item 2 of the
// deliverable-formats packet) as a small card: filename, format, size, a
// download link, and an inline preview the operator can open on demand.
//
// BUNDLE SIZE: `xlsx` and `mammoth` are both large parsers. Neither is
// imported at module scope — each is pulled in with a dynamic `import()`
// only at the moment a preview of THAT format is actually opened, so a user
// who never opens an xlsx/docx preview never downloads either parser. See
// loadXlsx()/loadMammoth() below. Verified with `npx next build`: the shared
// First Load JS is unchanged (87.3 kB before and after — neither library
// ships in a shared/first-load chunk; each lands only in the on-demand chunk
// created for its dynamic import, fetched only when a preview opens).
//
// SANITIZATION: mammoth's docx→HTML output is derived from a file whose
// CONTENT the model wrote — untrusted, same class of input packet 9.2 already
// solved for the email-template preview. Rather than inventing a second
// sanitizer, this reuses that exact one: sanitizeEmailHtml from
// EmailPreview.tsx (DOMPurify with the same tag/attribute/protocol
// allowlist — tables, headings, lists, links, inline images, no scripting).
// It is imported lazily alongside mammoth, since it is only needed on that
// preview path.
//
// FAILURE ISOLATION: every preview path is wrapped in try/catch. A preview
// that fails to fetch or parse shows an inline error and leaves the download
// link working — it never blanks the card or throws up into the step-list
// reducer that owns it.

const MAX_ROWS_SHOWN = 50;

// formatBytes/parseCsv are exported so tests/file-card-parsing.test.ts can
// exercise the REAL functions directly — this project has no DOM test
// environment (vitest runs 'node', not jsdom; see AgentConsole.tsx's own
// note on attachmentsForTurn/clearSentAttachments for the same reasoning),
// so a component-render test of the preview isn't available here. Pulling
// out the pure parsing/formatting logic means the test pins the actual code
// path FileCard calls, not a reimplementation of it.
export function formatBytes(bytes?: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.max(1, Math.round(kb))} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

const FORMAT_LABEL: Record<string, string> = {
  md: 'Markdown', csv: 'CSV', json: 'JSON', txt: 'Text', html: 'HTML',
  xlsx: 'Excel', docx: 'Word', pdf: 'PDF',
};

type PreviewState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'text'; text: string }
  | { kind: 'table'; headers: string[]; rows: string[][]; totalRows: number }
  | { kind: 'html'; html: string }
  | { kind: 'pdf' };

/** Minimal RFC4180-ish CSV parser — quoted fields (with "" escaping embedded
 *  quotes), commas and newlines inside quotes, \r\n or \n line endings. Good
 *  enough for files this app produced itself (buildXlsx's sibling text path
 *  writes plain CSV), not a general-purpose ingestion parser. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"') { inQuotes = true; i += 1; continue; }
    if (ch === ',') { row.push(field); field = ''; i += 1; continue; }
    if (ch === '\r') { i += 1; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }
    field += ch; i += 1;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

async function loadXlsx() {
  return import('xlsx');
}

async function loadMammothAndSanitizer() {
  const [mammoth, emailPreview] = await Promise.all([
    import('mammoth'),
    import('@/components/EmailPreview'),
  ]);
  return { mammoth, sanitizeEmailHtml: emailPreview.sanitizeEmailHtml };
}

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load the file (${res.status})`);
  return res.arrayBuffer();
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load the file (${res.status})`);
  return res.text();
}

export function rowsToTable(rows: string[][]): { headers: string[]; rows: string[][]; totalRows: number } {
  const headers = rows[0] || [];
  const body = rows.slice(1);
  return { headers, rows: body.slice(0, MAX_ROWS_SHOWN), totalRows: body.length };
}

async function loadPreview(file: ObservedFile): Promise<PreviewState> {
  const format = (file.format || '').toLowerCase();
  try {
    if (format === 'pdf') return { kind: 'pdf' };

    if (format === 'xlsx') {
      const [buf, XLSX] = await Promise.all([fetchArrayBuffer(file.url), loadXlsx()]);
      const wb = XLSX.read(buf, { type: 'array' });
      const firstSheetName = wb.SheetNames[0];
      if (!firstSheetName) return { kind: 'error', message: 'That workbook has no sheets to preview.' };
      const sheet = wb.Sheets[firstSheetName];
      const rows: string[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, raw: false });
      const table = rowsToTable(rows);
      return { kind: 'table', ...table };
    }

    if (format === 'docx') {
      const [buf, { mammoth, sanitizeEmailHtml }] = await Promise.all([
        fetchArrayBuffer(file.url), loadMammothAndSanitizer(),
      ]);
      const { value: rawHtml } = await mammoth.convertToHtml({ arrayBuffer: buf });
      const safe = sanitizeEmailHtml(rawHtml);
      if (!safe) return { kind: 'error', message: 'Preview is not available in this browser context.' };
      return { kind: 'html', html: safe };
    }

    if (format === 'csv') {
      const text = await fetchText(file.url);
      const rows = parseCsv(text);
      if (!rows.length) return { kind: 'text', text: '(empty file)' };
      const table = rowsToTable(rows);
      return { kind: 'table', ...table };
    }

    if (format === 'md' || format === 'txt' || format === 'json') {
      const text = await fetchText(file.url);
      return { kind: 'text', text };
    }

    if (format === 'html') {
      const [text, { sanitizeEmailHtml }] = await Promise.all([
        fetchText(file.url),
        import('@/components/EmailPreview'),
      ]);
      const safe = sanitizeEmailHtml(text);
      if (!safe) return { kind: 'error', message: 'Preview is not available in this browser context.' };
      return { kind: 'html', html: safe };
    }

    return { kind: 'error', message: `No preview available for "${format || 'this'}" files — use the download link.` };
  } catch (err: any) {
    // Non-fatal by construction: the caller keeps the download link working
    // regardless of what this throws or returns.
    return { kind: 'error', message: err?.message ? String(err.message) : 'Could not load a preview for this file.' };
  }
}

function TablePreview({ headers, rows, totalRows }: { headers: string[]; rows: string[][]; totalRows: number }) {
  const withheld = totalRows - rows.length;
  return (
    <div>
      <div className="max-w-full overflow-x-auto rounded-lg border border-[var(--border-default)]">
        <table className="w-full min-w-max border-collapse text-xs">
          <thead>
            <tr className="bg-[var(--bg-canvas)]">
              {headers.map((h, i) => (
                <th key={i} className="border-b border-[var(--border-default)] px-2.5 py-1.5 text-left font-medium text-[var(--text-secondary)]">
                  {h || `Column ${i + 1}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri} className="border-b border-[var(--border-default)] last:border-0">
                {headers.map((_, ci) => (
                  <td key={ci} className="whitespace-nowrap px-2.5 py-1.5 text-[var(--text-primary)]">{r[ci] ?? ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {withheld > 0 && (
        <div className="mt-1 text-xs text-[var(--text-muted)]">
          Showing {rows.length} of {totalRows} rows — {withheld} more withheld from this preview (download the file for the rest).
        </div>
      )}
    </div>
  );
}

function PreviewBody({ state, file }: { state: PreviewState; file: ObservedFile }) {
  if (state.kind === 'loading') {
    return <div className="py-2 text-xs text-[var(--text-muted)]">Loading preview…</div>;
  }
  if (state.kind === 'error') {
    return <div className="py-2 text-xs text-[var(--status-negative)]">{state.message} The download link above still works.</div>;
  }
  if (state.kind === 'pdf') {
    return (
      <iframe
        src={file.url}
        title={file.filename}
        className="h-96 w-full rounded-lg border border-[var(--border-default)] bg-white"
      />
    );
  }
  if (state.kind === 'table') return <TablePreview headers={state.headers} rows={state.rows} totalRows={state.totalRows} />;
  if (state.kind === 'html') {
    // Sanitized above via sanitizeEmailHtml (packet 9.2's DOMPurify config) —
    // never raw model/document output.
    return <div className="prose prose-sm max-w-none rounded-lg border border-[var(--border-default)] p-3" dangerouslySetInnerHTML={{ __html: state.html }} />;
  }
  if (state.kind === 'text') {
    if ((file.format || '').toLowerCase() === 'md') {
      return <div className="rounded-lg border border-[var(--border-default)] p-3"><Markdown>{state.text}</Markdown></div>;
    }
    return (
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--border-default)] bg-[var(--bg-canvas)] p-3 text-xs text-[var(--text-primary)]">
        {state.text}
      </pre>
    );
  }
  return null;
}

export default function FileCard({ file }: { file: ObservedFile }) {
  const [preview, setPreview] = useState<PreviewState>({ kind: 'idle' });
  const format = (file.format || '').toLowerCase();
  const label = FORMAT_LABEL[format] || format.toUpperCase() || 'File';
  const size = formatBytes(file.bytes);
  const open = preview.kind !== 'idle';

  async function togglePreview() {
    if (open) { setPreview({ kind: 'idle' }); return; }
    setPreview({ kind: 'loading' });
    const result = await loadPreview(file);
    setPreview(result);
  }

  return (
    <div className="max-w-md rounded-lg border border-[var(--border-default)] bg-[var(--bg-canvas)] p-3">
      <div className="flex items-center gap-2.5">
        <span aria-hidden className="text-lg leading-none">📄</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-[var(--text-primary)]" title={file.filename}>{file.filename}</div>
          <div className="text-xs text-[var(--text-muted)]">{label}{size ? ` · ${size}` : ''}</div>
        </div>
        <a
          href={file.url}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 rounded-md border border-[var(--border-default)] px-2 py-1 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-raised)]"
        >
          Download
        </a>
        <button
          type="button"
          onClick={togglePreview}
          className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-[var(--brand)] hover:bg-[var(--bg-raised)]"
        >
          {open ? 'Hide preview' : 'Preview'}
        </button>
      </div>
      {file.description && <div className="mt-1.5 text-xs text-[var(--text-secondary)]">{file.description}</div>}
      {open && <div className="mt-2.5">{<PreviewBody state={preview} file={file} />}</div>}
    </div>
  );
}
