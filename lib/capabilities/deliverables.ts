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
import { buildXlsx, buildDocx, buildPdf } from './binary-deliverables';
import { dbReady } from '@/lib/db';
import { DELIVERABLE_BUCKET, DELIVERABLE_URL_TTL, ensurePrivateBucket, putPrivate, signUrl } from '@/lib/storage';

/** What the agent may produce. Each maps to a real content type and extension
 *  so the browser does something sensible when the link is opened. */
const FORMATS = {
  md: { ext: 'md', mime: 'text/markdown', label: 'Markdown document' },
  csv: { ext: 'csv', mime: 'text/csv', label: 'CSV spreadsheet' },
  json: { ext: 'json', mime: 'application/json', label: 'JSON file' },
  txt: { ext: 'txt', mime: 'text/plain', label: 'text file' },
  html: { ext: 'html', mime: 'text/html', label: 'HTML page' },
  xlsx: { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: 'Excel spreadsheet' },
  docx: { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'Word document' },
  pdf: { ext: 'pdf', mime: 'application/pdf', label: 'PDF document' },
} as const;

type FormatKey = keyof typeof FORMATS;

// The three formats a model cannot emit directly — content is SOURCE the
// server renders into real bytes, not bytes the model writes itself. See
// the "Binary storage" split below for where the output goes.
const BINARY_FORMATS = new Set<FormatKey>(['xlsx', 'docx', 'pdf']);

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
    // NOTE: this string reaches the model prompt catalog as ONE LINE per tool
    // (lib/capabilities/registry.ts renderCatalogLine) — never put a literal
    // newline in here, or the catalog parser (and tests/parity.test.ts, which
    // pins the one-line-per-tool shape) breaks on this entry.
    description:
      "Turn something you have written into a real downloadable file and give the user its link. Text formats — md (a document or report), csv (rows and columns — use for lists, exports, calendars), json (structured data), txt, html — take `content` as the literal file text, written by you. Use this whenever the user asks for a document, a report, an export, a spreadsheet, or 'send me' / 'give me' something — do not paste a long table or a whole report into the chat instead. " +
      'Three more formats produce a REAL binary file you cannot write bytes for directly, so `content` is source that the server renders: ' +
      'xlsx (a real Excel workbook) — `content` is a JSON string, either an array of flat row objects, e.g. `[{"Name":"Acme","Deals":3},{"Name":"Globex","Deals":1}]`, for one sheet named "Sheet1", or `{"sheets": {"Leads": [...], "Deals": [...]}}` for multiple named sheets (every row is a flat object; values must be string, number, boolean, or null — no nested objects/arrays as values); ' +
      'docx (a real Word document) and pdf (a real PDF) — `content` is Markdown text using only `#`/`##`/`###` headings, `-`/`*` bullet lists, `1.` numbered lists, plain paragraphs, and **bold**/*italic* emphasis. ' +
      'For all three, you write the source; this call renders and stores the actual binary file.',
    gate: 'internal_write',
    inputSchema: obj({ filename: S.string, format: S.string, content: S.string, description: S.string }, ['filename', 'format', 'content']),
    zod: z.object({
      filename: z.string().min(1).max(120),
      format: z.enum(['md', 'csv', 'json', 'txt', 'html', 'xlsx', 'docx', 'pdf']),
      content: z.string().min(1).max(MAX_CONTENT_CHARS),
      description: z.string().max(300).optional(),
    }),
    run: async (accountId, a) => {
      const spec = FORMATS[a.format as FormatKey];
      const base = safeBaseName(a.filename.replace(/\.[a-z0-9]+$/i, ''), 'leadrail-export');
      const filename = `${base}.${spec.ext}`;

      if (BINARY_FORMATS.has(a.format as FormatKey)) {
        // BINARY PATH — xlsx/docx/pdf. Routed through Supabase Storage
        // (lib/storage.ts), never the local `public/generated/files` path the
        // text formats below use: that directory is gitignored local
        // filesystem whose survival across a redeploy depends on the deploy
        // target (unknown here — `infra/cloudflare` exists in this repo), and
        // writing binary bytes there with an implicit utf8 encoding would
        // corrupt them outright. The five text formats are left exactly as
        // they were — see BACKLOG.md for the plan to move them onto storage
        // too once the deploy target is confirmed.
        let bytes: Buffer;
        try {
          if (a.format === 'xlsx') bytes = buildXlsx(a.content);
          else if (a.format === 'docx') bytes = await buildDocx(a.content);
          else bytes = await buildPdf(a.content);
        } catch (err: any) {
          // Re-throw as-is: buildXlsx/buildDocx/buildPdf already raise clear,
          // specific messages ("xlsx content must be JSON: …") — wrapping them
          // here would only blur what's wrong with the source the model sent.
          throw err instanceof Error ? err : new Error(String(err?.message || err));
        }

        if (!dbReady()) {
          throw new Error(
            `Cannot create a .${spec.ext} file: durable storage is not configured on this deployment (Supabase URL/service key missing). Text formats (md, csv, json, txt, html) still work.`,
          );
        }

        const { randomUUID } = await import('node:crypto');
        const path = `${accountId}/${randomUUID()}-${filename}`;
        await ensurePrivateBucket(DELIVERABLE_BUCKET);
        const put = await putPrivate(DELIVERABLE_BUCKET, path, bytes, spec.mime);
        if (put.error) {
          const missingBucket = /bucket.*not.*found|does not exist/i.test(put.error);
          throw new Error(
            missingBucket
              ? `The "${DELIVERABLE_BUCKET}" storage bucket does not exist and could not be created automatically. Create it as a PRIVATE bucket in Supabase → Storage, or give the service key permission to create buckets.`
              : `Could not store that file: ${put.error}`,
          );
        }
        const url = await signUrl(DELIVERABLE_BUCKET, path, DELIVERABLE_URL_TTL);
        if (!url) throw new Error('The file was stored but a download link could not be signed. Try again.');

        return {
          url,
          filename,
          format: a.format,
          mimeType: spec.mime,
          bytes: bytes.length,
          description: a.description ?? null,
        };
      }

      // TEXT PATH — md/csv/json/txt/html. Unchanged from before this packet.
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

      // The uuid segment is what makes the URL unguessable. Two accounts can
      // both produce "q3-report.csv" and neither can reach the other's.
      const dir = join(process.cwd(), 'public', 'generated', 'files');
      await mkdir(dir, { recursive: true });
      const stored = `${randomUUID()}-${base}.${spec.ext}`;
      await writeFile(join(dir, stored), a.content, 'utf8');

      return {
        url: `/generated/files/${stored}`,
        filename,
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
