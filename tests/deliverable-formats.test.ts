// tests/deliverable-formats.test.ts — xlsx/docx/pdf deliverables.
//
// Covers: buildXlsx/buildDocx/buildPdf as pure renderers (byte-level checks,
// including the xlsx cached-value rule), createFile's binary path end to end
// with storage mocked, the storage-unconfigured failure, malformed-source
// rejection for each binary format, and that the five pre-existing text
// formats are byte-for-byte unchanged.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as XLSX from 'xlsx';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import { buildXlsx, buildDocx, buildPdf } from '@/lib/capabilities/binary-deliverables';

// --- mock storage + db readiness so createFile's binary path is testable
// without a real Supabase project. ---------------------------------------
const putPrivateMock = vi.fn(async (_bucket: string, path: string, _bytes: Buffer, _mime?: string) => ({ path }));
const signUrlMock = vi.fn(async (_bucket: string, path: string, _ttl: number) => `https://storage.example/${path}?sig=fake`);
const ensurePrivateBucketMock = vi.fn(async (_bucket: string) => {});
let dbReadyValue = true;

vi.mock('@/lib/db', () => ({
  dbReady: () => dbReadyValue,
}));

vi.mock('@/lib/storage', () => ({
  DELIVERABLE_BUCKET: 'chat-deliverables',
  DELIVERABLE_URL_TTL: 60 * 60 * 24 * 7,
  ensurePrivateBucket: (bucket: string) => ensurePrivateBucketMock(bucket),
  putPrivate: (bucket: string, path: string, bytes: Buffer, mime?: string) => putPrivateMock(bucket, path, bytes, mime),
  signUrl: (bucket: string, path: string, ttl: number) => signUrlMock(bucket, path, ttl),
}));

// Imported AFTER the mocks so the module under test picks them up.
const { DELIVERABLE_CAPABILITIES } = await import('@/lib/capabilities/deliverables');
const createFile = DELIVERABLE_CAPABILITIES.find((c) => c.name === 'createFile')!;

const ACCOUNT = 'test-account-1';

beforeEach(() => {
  dbReadyValue = true;
  putPrivateMock.mockClear();
  signUrlMock.mockClear();
  ensurePrivateBucketMock.mockClear();
});


// ---------------------------------------------------------------------------
// xlsx — buildXlsx
// ---------------------------------------------------------------------------
describe('buildXlsx', () => {
  it('single-sheet array round-trips with real cell VALUES (not blank/undefined)', () => {
    const rows = [
      { Name: 'Acme', Deals: 3, Active: true },
      { Name: 'Globex', Deals: 1, Active: false },
    ];
    const buf = buildXlsx(JSON.stringify(rows));
    const wb = XLSX.read(buf, { type: 'buffer' });
    expect(wb.SheetNames).toEqual(['Sheet1']);
    const parsed = XLSX.utils.sheet_to_json(wb.Sheets['Sheet1']);
    expect(parsed).toEqual(rows);
    // THE cached-value rule: read the raw cell objects directly, not just via
    // sheet_to_json, and assert real values landed on `.v` — this is exactly
    // what a previewer/pandas/most importers read, and what SheetJS leaves
    // blank when a formula is written without a cached value alongside it.
    const ws = wb.Sheets['Sheet1'];
    expect(ws['A2'].v).toBe('Acme');
    expect(ws['B2'].v).toBe(3);
    expect(ws['A2'].v).not.toBeUndefined();
    expect(ws['B2'].v).not.toBeUndefined();
  });

  it('multi-sheet {sheets: {...}} produces one sheet per key, in order, with real values', () => {
    const content = JSON.stringify({
      sheets: {
        Leads: [{ Name: 'Ada', Score: 91 }],
        Deals: [{ Company: 'Acme', Amount: 5000 }, { Company: 'Globex', Amount: 250 }],
      },
    });
    const buf = buildXlsx(content);
    const wb = XLSX.read(buf, { type: 'buffer' });
    expect(wb.SheetNames).toEqual(['Leads', 'Deals']);
    expect(XLSX.utils.sheet_to_json(wb.Sheets['Leads'])).toEqual([{ Name: 'Ada', Score: 91 }]);
    expect(XLSX.utils.sheet_to_json(wb.Sheets['Deals'])).toEqual([
      { Company: 'Acme', Amount: 5000 },
      { Company: 'Globex', Amount: 250 },
    ]);
    // Cached-value check on the second sheet too.
    expect(wb.Sheets['Deals']['B3'].v).toBe(250);
  });

  it('rejects malformed JSON', () => {
    expect(() => buildXlsx('{not json')).toThrow(/JSON/i);
  });

  it('rejects a JSON value that is neither a row array nor {sheets: …}', () => {
    expect(() => buildXlsx(JSON.stringify({ hello: 'world' }))).toThrow(/array of row objects|sheets/i);
  });

  it('rejects rows that are not flat objects', () => {
    expect(() => buildXlsx(JSON.stringify([{ nested: { a: 1 } }]))).toThrow();
    expect(() => buildXlsx(JSON.stringify(['just a string']))).toThrow();
  });

  it('rejects an empty array', () => {
    expect(() => buildXlsx(JSON.stringify([]))).toThrow(/empty/i);
  });
});

// ---------------------------------------------------------------------------
// docx — buildDocx
// ---------------------------------------------------------------------------
describe('buildDocx', () => {
  it('produces a real zip (PK magic bytes, [Content_Types].xml present)', async () => {
    const buf = await buildDocx('# Title\n\nSome body text.');
    expect(buf.subarray(0, 2).toString('binary')).toBe('PK');
    const zip = await JSZip.loadAsync(buf);
    expect(zip.files['[Content_Types].xml']).toBeTruthy();
  });

  it('round-trips body text via mammoth, including heading/bullet/bold content', async () => {
    const md = [
      '# Quarterly Report',
      '',
      'Revenue grew **significantly** this quarter.',
      '',
      '- First point',
      '- Second point',
      '',
      '1. Step one',
      '2. Step two',
    ].join('\n');
    const buf = await buildDocx(md);
    const res = await mammoth.extractRawText({ buffer: buf });
    const text = res.value;
    expect(text).toContain('Quarterly Report');
    expect(text).toContain('Revenue grew');
    expect(text).toContain('significantly');
    expect(text).toContain('First point');
    expect(text).toContain('Second point');
    expect(text).toContain('Step one');
  });

  it('rejects empty content', async () => {
    await expect(buildDocx('')).rejects.toThrow(/empty/i);
    await expect(buildDocx('   \n  ')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// pdf — buildPdf
// ---------------------------------------------------------------------------
describe('buildPdf', () => {
  it('starts with the %PDF- magic bytes and is non-trivial in size', async () => {
    const buf = await buildPdf('# Report\n\nA paragraph of real content that should take up some bytes.');
    expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(500);
  });

  it('rejects empty content', async () => {
    await expect(buildPdf('')).rejects.toThrow(/empty/i);
  });
});

// ---------------------------------------------------------------------------
// createFile — binary formats end to end (storage mocked)
// ---------------------------------------------------------------------------
describe('createFile: binary formats', () => {
  it('xlsx: stores bytes via putPrivate and returns a signed URL with the right MIME type', async () => {
    const result: any = await createFile.run(ACCOUNT, {
      filename: 'report',
      format: 'xlsx',
      content: JSON.stringify([{ Name: 'Acme', Deals: 3 }]),
    });
    expect(putPrivateMock).toHaveBeenCalledTimes(1);
    const [bucket, path, bytes, mime] = putPrivateMock.mock.calls[0];
    expect(bucket).toBe('chat-deliverables');
    expect(path.startsWith(`${ACCOUNT}/`)).toBe(true);
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(mime).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(result.url).toMatch(/^https:\/\/storage\.example\//);
    expect(result.mimeType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(result.filename).toBe('report.xlsx');
    expect(result.format).toBe('xlsx');
    expect(result.bytes).toBeGreaterThan(0);
  });

  it('docx: correct MIME type and filename', async () => {
    const result: any = await createFile.run(ACCOUNT, {
      filename: 'memo',
      format: 'docx',
      content: '# Memo\n\nBody text.',
    });
    expect(result.mimeType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(result.filename).toBe('memo.docx');
  });

  it('pdf: correct MIME type and filename', async () => {
    const result: any = await createFile.run(ACCOUNT, {
      filename: 'summary',
      format: 'pdf',
      content: '# Summary\n\nBody text.',
    });
    expect(result.mimeType).toBe('application/pdf');
    expect(result.filename).toBe('summary.pdf');
  });

  it('fails with a clear error when storage is unconfigured, and never falls back to the local path', async () => {
    dbReadyValue = false;
    await expect(
      createFile.run(ACCOUNT, { filename: 'x', format: 'xlsx', content: JSON.stringify([{ a: 1 }]) }),
    ).rejects.toThrow(/storage is not configured/i);
    expect(putPrivateMock).not.toHaveBeenCalled();
  });

  it('malformed xlsx source is rejected before any storage call is made', async () => {
    await expect(
      createFile.run(ACCOUNT, { filename: 'x', format: 'xlsx', content: 'not json' }),
    ).rejects.toThrow();
    expect(putPrivateMock).not.toHaveBeenCalled();
  });

  it('malformed docx/pdf source (empty markdown) is rejected before any storage call is made', async () => {
    await expect(
      createFile.run(ACCOUNT, { filename: 'x', format: 'docx', content: '   ' }),
    ).rejects.toThrow();
    await expect(
      createFile.run(ACCOUNT, { filename: 'x', format: 'pdf', content: '   ' }),
    ).rejects.toThrow();
    expect(putPrivateMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createFile — the five TEXT formats now go through DELIVERABLE_BUCKET too,
// same as the three binary formats — never `public/generated/files`.
// ---------------------------------------------------------------------------
describe('createFile: text formats route through storage, not public/generated', () => {
  it.each(['md', 'csv', 'txt', 'html'] as const)('%s: stores bytes via putPrivate and returns a signed storage URL', async (format) => {
    const content = `hello ${format} world`;
    const result: any = await createFile.run(ACCOUNT, { filename: `pin-${format}`, format, content });
    expect(putPrivateMock).toHaveBeenCalledTimes(1);
    const [bucket, path, bytes] = putPrivateMock.mock.calls[0];
    expect(bucket).toBe('chat-deliverables');
    expect(path.startsWith(`${ACCOUNT}/`)).toBe(true);
    // Bytes handed to storage are the literal utf8 content, byte-for-byte —
    // this is what pins "content is unchanged", now that it's not read back
    // off disk.
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.toString('utf8')).toBe(content);
    expect(result.url).toMatch(/^https:\/\/storage\.example\//);
    expect(result.filename).toBe(`pin-${format}.${format}`);
    expect(result.bytes).toBe(Buffer.byteLength(content, 'utf8'));
  });

  it('json: valid JSON is accepted and stored verbatim', async () => {
    const content = JSON.stringify({ a: 1, b: [1, 2, 3] });
    const result: any = await createFile.run(ACCOUNT, { filename: 'pin-json', format: 'json', content });
    expect(result.mimeType).toBe('application/json');
    expect(result.url).toMatch(/^https:\/\/storage\.example\//);
    const [, , bytes] = putPrivateMock.mock.calls[0];
    expect(bytes.toString('utf8')).toBe(content);
  });

  it('json: invalid JSON is rejected with the original message, before any storage call', async () => {
    await expect(
      createFile.run(ACCOUNT, { filename: 'bad', format: 'json', content: '{not json' }),
    ).rejects.toThrow(/not valid JSON/i);
    expect(putPrivateMock).not.toHaveBeenCalled();
  });

  it('fails with a clear error when storage is unconfigured, and never falls back to a local path', async () => {
    dbReadyValue = false;
    await expect(
      createFile.run(ACCOUNT, { filename: 'x', format: 'md', content: 'hello' }),
    ).rejects.toThrow(/storage is not configured/i);
    expect(putPrivateMock).not.toHaveBeenCalled();
  });
});
