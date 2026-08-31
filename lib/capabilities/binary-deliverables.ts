// Binary deliverable renderers — xlsx / docx / pdf.
//
// createFile (lib/capabilities/deliverables.ts) cannot ask the model to emit
// binary bytes, so for these three formats the model supplies SOURCE and the
// server renders it. This module owns that rendering, plus the validation
// that turns a malformed source into a clear thrown Error instead of a file
// that does not open.

import * as XLSX from 'xlsx';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import PDFDocument from 'pdfkit';
import { parseMarkdownBlocks, blocksHaveText, type InlineRun } from './markdown-blocks';

// ---------------------------------------------------------------------------
// xlsx
// ---------------------------------------------------------------------------
//
// CONTRACT (documented to the model in the capability description):
//   content is a JSON string, either:
//     - an array of flat objects -> one sheet named "Sheet1"
//       e.g. `[{"Name":"Acme","Deals":3},{"Name":"Globex","Deals":1}]`
//     - {"sheets": {"<name>": [ {...}, ... ], ...}} -> one sheet per key,
//       in key order.
//   Every row must be a plain object (no arrays/nulls as rows); values must
//   be string, number, boolean, or null.
//
// CACHED-VALUE RULE (the reason this file exists): SheetJS, like openpyxl,
// writes formulas with NO cached value, and any reader that trusts cached
// values (most previewers, pandas, most importers) then reads the cell as
// blank. LeadRail's deploy target has no LibreOffice to recalculate on
// write. So this builder writes computed VALUES only — json_to_sheet never
// emits a formula, only the literal value that was in the row — and this
// module never accepts or emits a `f` (formula) key on any cell. If formula
// support is ever added here, it MUST set the cell's `v` (value) alongside
// `f`, never `f` alone.

type XlsxRow = Record<string, string | number | boolean | null>;

function isPlainRow(row: unknown): row is XlsxRow {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return false;
  return Object.values(row as Record<string, unknown>).every(
    (v) => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
  );
}

function isRowArray(v: unknown): v is XlsxRow[] {
  return Array.isArray(v) && v.every(isPlainRow);
}

export function buildXlsx(content: string): Buffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(
      'xlsx content must be JSON: either an array of row objects, or {"sheets": {"Name": [rows]}}. That JSON did not parse.',
    );
  }

  let sheets: Array<[string, XlsxRow[]]>;
  if (isRowArray(parsed)) {
    if (!parsed.length) throw new Error('xlsx content is an empty array — there are no rows to write.');
    sheets = [['Sheet1', parsed]];
  } else if (
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
    'sheets' in (parsed as any) && typeof (parsed as any).sheets === 'object' && (parsed as any).sheets !== null
  ) {
    const raw = (parsed as any).sheets as Record<string, unknown>;
    const names = Object.keys(raw);
    if (!names.length) throw new Error('xlsx content has an empty "sheets" object — there are no sheets to write.');
    sheets = names.map((name) => {
      const rows = raw[name];
      if (!isRowArray(rows) || !rows.length) {
        throw new Error(`xlsx sheet "${name}" must be a non-empty array of flat row objects (string/number/boolean/null values only).`);
      }
      return [name.slice(0, 31) || 'Sheet1', rows] as [string, XlsxRow[]];
    });
  } else {
    throw new Error(
      'xlsx content must be either a JSON array of row objects (e.g. [{"Name":"Acme","Deals":3}]) or {"sheets": {"Name": [rows]}} for multiple sheets.',
    );
  }

  const wb = XLSX.utils.book_new();
  for (const [name, rows] of sheets) {
    // json_to_sheet writes each row's own value into every cell — there is no
    // code path here that ever produces a formula, so there is no cached-value
    // gap to fall into.
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

// ---------------------------------------------------------------------------
// docx / pdf — shared markdown source
// ---------------------------------------------------------------------------
//
// CONTRACT (documented to the model): content is Markdown text using only
// `#`/`##`/`###` headings, `-`/`*` bullet lists, `1.` numbered lists, plain
// paragraphs, and **bold**/*italic* inline emphasis. Anything else (tables,
// images, links, code fences) is rendered as plain text rather than
// rejected — the file still opens.

function validateMarkdownSource(content: string, format: 'docx' | 'pdf'): void {
  if (!content.trim()) {
    throw new Error(`${format} content is empty — there is no text to render.`);
  }
  const blocks = parseMarkdownBlocks(content);
  if (!blocksHaveText(blocks)) {
    throw new Error(`${format} content has no readable text after parsing as Markdown — nothing would appear in the document.`);
  }
}

export async function buildDocx(content: string): Promise<Buffer> {
  validateMarkdownSource(content, 'docx');
  const blocks = parseMarkdownBlocks(content);

  const toTextRuns = (runs: InlineRun[]): TextRun[] =>
    runs.map((r) => new TextRun({ text: r.text, bold: r.bold, italics: r.italic }));

  const HEADING_STYLE = {
    1: HeadingLevel.HEADING_1,
    2: HeadingLevel.HEADING_2,
    3: HeadingLevel.HEADING_3,
  } as const;

  const children: Paragraph[] = [];
  for (const block of blocks) {
    if (block.type === 'heading') {
      children.push(new Paragraph({ heading: HEADING_STYLE[block.level], children: toTextRuns(block.runs) }));
    } else if (block.type === 'paragraph') {
      children.push(new Paragraph({ children: toTextRuns(block.runs) }));
    } else if (block.type === 'bullet') {
      for (const item of block.items) {
        children.push(new Paragraph({ bullet: { level: 0 }, children: toTextRuns(item) }));
      }
    } else if (block.type === 'numbered') {
      block.items.forEach((item, idx) => {
        children.push(new Paragraph({ children: [new TextRun({ text: `${idx + 1}. `, bold: false }), ...toTextRuns(item)] }));
      });
    }
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

export async function buildPdf(content: string): Promise<Buffer> {
  validateMarkdownSource(content, 'pdf');
  const blocks = parseMarkdownBlocks(content);

  const doc = new PDFDocument({ margin: 54 });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));

  const HEADING_SIZE = { 1: 22, 2: 17, 3: 14 } as const;

  const writeRuns = (runs: InlineRun[], size: number) => {
    for (const r of runs) {
      doc.fontSize(size).font(r.bold ? 'Helvetica-Bold' : (r.italic ? 'Helvetica-Oblique' : 'Helvetica'));
      doc.text(r.text, { continued: true });
    }
    doc.text('', { continued: false }); // close the line
  };

  for (const block of blocks) {
    if (block.type === 'heading') {
      writeRuns(block.runs, HEADING_SIZE[block.level]);
      doc.moveDown(0.5);
    } else if (block.type === 'paragraph') {
      writeRuns(block.runs, 11);
      doc.moveDown(0.5);
    } else if (block.type === 'bullet') {
      for (const item of block.items) {
        doc.fontSize(11).font('Helvetica').text('•  ', { continued: true });
        writeRuns(item, 11);
      }
      doc.moveDown(0.5);
    } else if (block.type === 'numbered') {
      block.items.forEach((item, idx) => {
        doc.fontSize(11).font('Helvetica').text(`${idx + 1}.  `, { continued: true });
        writeRuns(item, 11);
      });
      doc.moveDown(0.5);
    }
  }

  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  doc.end();
  return done;
}
