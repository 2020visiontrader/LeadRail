// Deliverables — handing the user an actual file.
//
// THE GAP THIS CLOSES. Every capability in this registry either reads
// something or changes a record. Not one of them could produce a FILE. So the
// assistant could research five companies, write a content calendar, assemble
// a report — and then had no way to give it to anyone. The result lived in a
// chat message, and the user copy-pasted it out.
//
// That is a small-looking hole with a large blast radius, because it silently
// caps what a request can be. "Export the segment as a CSV", "write this up as
// a document", "give me the calendar as a file" all had the same answer, and
// the answer was no.
//
// Scope, deliberately narrow: TEXT deliverables the assistant composed itself
// (markdown, CSV, JSON, plain text). Not a filesystem tool. The agent cannot
// read arbitrary paths, cannot write outside the generated directory, and
// cannot name the file anything that escapes it — this is multi-tenant SaaS,
// and a general read_file/write_file pair of the kind a single-user desktop
// agent ships would be a tenancy boundary with a rope ladder over it.

import { z } from 'zod';
import { obj, S, type Capability, digestLine } from './types';

/** What the agent may produce. Each maps to a real content type and extension
 *  so the browser does something sensible when the link is opened. */
const FORMATS = {
  md: { ext: 'md', mime: 'text/markdown', label: 'Markdown document' },
  csv: { ext: 'csv', mime: 'text/csv', label: 'CSV spreadsheet' },
  json: { ext: 'json', mime: 'application/json', label: 'JSON file' },
  txt: { ext: 'txt', mime: 'text/plain', label: 'text file' },
  html: { ext: 'html', mime: 'text/html', label: 'HTML page' },
} as const;

type FormatKey = keyof typeof FORMATS;

// Bounded so one call cannot fill the disk. Generous enough for a long report
// or a few thousand CSV rows; a request bigger than this wants a real export
// job, not a chat turn.
const MAX_CONTENT_CHARS = 2_000_000;

/**
 * Reduce a model-supplied name to a safe basename.
 *
 * The agent picks this string, so it is untrusted input on a filesystem path.
 * Rather than blocklisting traversal sequences — which is the approach that
 * keeps being bypassed — this keeps only characters that are unambiguously
 * safe and rebuilds the name from those, so there is no sequence to smuggle.
 */
function safeBaseName(raw: string, fallback: string): string {
  const cleaned = (raw || '')
    .replace(/[^a-zA-Z0-9 _-]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

export const DELIVERABLE_CAPABILITIES: Capability[] = [
  {
    name: 'createFile',
    domain: 'workspace',
    title: 'Create a file for the user',
    description:
      "Turn something you have written into a real downloadable file and give the user its link. Formats: md (a document or report), csv (rows and columns — use for lists, exports, calendars), json (structured data), txt, html. Use this whenever the user asks for a document, a report, an export, a spreadsheet, or 'send me' / 'give me' something — do not paste a long table or a whole report into the chat instead. You compose the content yourself; this only stores it and returns the link.",
    gate: 'internal_write',
    inputSchema: obj({ filename: S.string, format: S.string, content: S.string, description: S.string }, ['filename', 'format', 'content']),
    zod: z.object({
      filename: z.string().min(1).max(120),
      format: z.enum(['md', 'csv', 'json', 'txt', 'html']),
      content: z.string().min(1).max(MAX_CONTENT_CHARS),
      description: z.string().max(300).optional(),
    }),
    run: async (accountId, a) => {
      const spec = FORMATS[a.format as FormatKey];
      // JSON is validated rather than trusted: handing someone a .json file
      // that does not parse is worse than refusing, because they find out
      // downstream in whatever tool they opened it with.
      if (a.format === 'json') {
        try { JSON.parse(a.content); }
        catch { throw new Error('That content is not valid JSON, so it was not saved. Fix the JSON or use the txt format.'); }
      }

      const { writeFile, mkdir } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const { randomUUID } = await import('node:crypto');

      const base = safeBaseName(a.filename.replace(/\.[a-z0-9]+$/i, ''), 'leadrail-export');
      // The uuid segment is what makes the URL unguessable. Two accounts can
      // both produce "q3-report.csv" and neither can reach the other's.
      const dir = join(process.cwd(), 'public', 'generated', 'files');
      await mkdir(dir, { recursive: true });
      const stored = `${randomUUID()}-${base}.${spec.ext}`;
      await writeFile(join(dir, stored), a.content, 'utf8');

      return {
        url: `/generated/files/${stored}`,
        filename: `${base}.${spec.ext}`,
        format: a.format,
        mimeType: spec.mime,
        bytes: Buffer.byteLength(a.content, 'utf8'),
        description: a.description ?? null,
      };
    },
    // The URL is the whole point of the call, so it is never clipped out of
    // the observation by a digest that summarised the file instead.
    digest: (_a, result) => {
      const r: any = result;
      if (!r?.url) return '';
      const kb = typeof r.bytes === 'number' ? ` (${Math.max(1, Math.round(r.bytes / 1024))} KB)` : '';
      return digestLine(`File ready: ${r.filename}${kb} — ${r.url}`, r.description || null);
    },
  },
];
