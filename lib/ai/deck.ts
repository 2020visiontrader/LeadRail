// Deck / document text extraction. Turns an uploaded pitch deck or one-pager
// (PDF, PPTX, DOCX, XLSX, TXT/MD) into plain text that the venture profiler
// feeds to the model. Server-only (Node runtime) — these libs pull native/heavy
// deps and must never bundle into the edge/browser build. Each format is
// guarded: a parse failure returns an empty string + reason, never throws, so
// one odd file can't 500 the upload route.

export interface DeckExtraction {
  text: string;
  chars: number;
  kind: string; // detected format
  ok: boolean;
  note?: string; // populated when extraction failed or was empty
}

function ext(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return (m?.[1] || '').toLowerCase();
}

async function fromPdf(buf: Buffer): Promise<string> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const res = await parser.getText();
    return stripPageMarkers(res?.text || '');
  } finally {
    await parser.destroy().catch(() => {});
  }
}

/** Remove pdf-parse's own page separators ("-- 1 of 3 --").
 *
 *  WHY THIS MATTERS FAR MORE THAN IT LOOKS. A scanned PDF has no text layer, so
 *  the parser returns ONLY these markers. Without stripping them the extractor
 *  sees 12 non-empty characters, reports success, and hands the model
 *  "-- 1 of 1 --" as the entire contents of the document someone attached — an
 *  answer confidently built on nothing, with no sign anything went wrong. That
 *  is precisely the failure the scanned-PDF branch below exists to prevent, and
 *  it was being skipped. Found by running an actual scanned-shaped PDF through
 *  this, which is the only way it could have been found. */
function stripPageMarkers(text: string): string {
  return text.replace(/^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/gim, '').trim();
}

async function fromDocx(buf: Buffer): Promise<string> {
  const mammoth = await import('mammoth');
  const res = await mammoth.extractRawText({ buffer: buf });
  return res?.value || '';
}

async function fromPptx(buf: Buffer): Promise<string> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buf);
  // Slide text lives in ppt/slides/slideN.xml as <a:t>…</a:t> runs.
  const slidePaths = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => {
      const n = (s: string) => Number(s.match(/slide(\d+)\.xml/)?.[1] || 0);
      return n(a) - n(b);
    });
  const out: string[] = [];
  for (const p of slidePaths) {
    const xml = await zip.files[p].async('string');
    const runs = xml.match(/<a:t>([\s\S]*?)<\/a:t>/g) || [];
    const text = runs
      .map((r) => r.replace(/<\/?a:t>/g, ''))
      .join(' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .trim();
    if (text) out.push(text);
  }
  return out.join('\n\n');
}

async function fromXlsx(buf: Buffer): Promise<string> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buf, { type: 'buffer' });
  const parts: string[] = [];
  for (const name of wb.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
    if (csv.trim()) parts.push(`# ${name}\n${csv}`);
  }
  return parts.join('\n\n');
}

const SUPPORTED = ['pdf', 'pptx', 'docx', 'xlsx', 'xls', 'csv', 'txt', 'md', 'json'];

export function isSupportedDeck(filename: string): boolean {
  return SUPPORTED.includes(ext(filename));
}

/**
 * Extract text from a deck/document buffer. Trims to a sane ceiling so a huge
 * spreadsheet can't blow the model context — the profiler only needs the gist.
 */
export async function extractDeckText(filename: string, buf: Buffer, maxChars = 60000): Promise<DeckExtraction> {
  const kind = ext(filename);
  const base: DeckExtraction = { text: '', chars: 0, kind, ok: false };
  try {
    let text = '';
    switch (kind) {
      case 'pdf': text = await fromPdf(buf); break;
      case 'pptx': text = await fromPptx(buf); break;
      case 'docx': text = await fromDocx(buf); break;
      case 'xlsx':
      case 'xls': text = await fromXlsx(buf); break;
      // CSV is read as text rather than through the xlsx path: a lead list is
      // the commonest thing anyone attaches here, and the raw rows are more
      // useful to a model than a re-serialised sheet.
      case 'csv':
      case 'json':
      case 'txt':
      case 'md': text = buf.toString('utf8'); break;
      default:
        return { ...base, note: `unsupported file type: .${kind || '?'} (use PDF, PPTX, DOCX, XLSX, TXT)` };
    }
    text = (text || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…[truncated]';
    if (!text) {
      // Distinguish the two cases, because the remedies differ completely and
      // "empty file?" sends someone to check a file that is perfectly fine.
      // A PDF with bytes but no text layer is a scan: the words are pixels.
      const scanned = kind === 'pdf' && buf.length > 2000;
      return {
        ...base,
        note: scanned
          ? 'This PDF has no text layer — it is a scan or an exported image, so the words are pixels. Nothing can be read from it without OCR.'
          : 'no extractable text (the file appears to be empty)',
      };
    }
    return { text, chars: text.length, kind, ok: true };
  } catch (e: any) {
    return { ...base, note: `could not read .${kind} file: ${e?.message || 'parse error'}` };
  }
}
