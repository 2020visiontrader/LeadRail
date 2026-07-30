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
    return res?.text || '';
  } finally {
    await parser.destroy().catch(() => {});
  }
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

const SUPPORTED = ['pdf', 'pptx', 'docx', 'xlsx', 'xls', 'txt', 'md'];

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
      case 'txt':
      case 'md': text = buf.toString('utf8'); break;
      default:
        return { ...base, note: `unsupported file type: .${kind || '?'} (use PDF, PPTX, DOCX, XLSX, TXT)` };
    }
    text = (text || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…[truncated]';
    if (!text) return { ...base, note: 'no extractable text (scanned image or empty file?)' };
    return { text, chars: text.length, kind, ok: true };
  } catch (e: any) {
    return { ...base, note: `could not read .${kind} file: ${e?.message || 'parse error'}` };
  }
}
