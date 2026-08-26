// Real files through the real extractor. No mocks.
//
// The attachment feature shipped with an "Internal error" on upload and I could
// not tell from the code which stage failed, because nothing had ever run a
// file through it. These tests exercise the actual parse path per format, which
// is the part that either works on a real PDF or does not.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractDeckText, isSupportedDeck } from '../lib/ai/deck';

const fx = (n: string) => readFileSync(`tests/fixtures/${n}`);

describe('formats that must parse', () => {
  it('reads a PDF text layer', async () => {
    const r = await extractDeckText('brief.pdf', fx('brief.pdf'));
    expect(r.ok).toBe(true);
    expect(r.text).toContain('200 qualified leads');
  });

  it('reads a spreadsheet, keeping the sheet name and the rows', async () => {
    const r = await extractDeckText('leads.xlsx', fx('leads.xlsx'));
    expect(r.ok).toBe(true);
    expect(r.text).toContain('Leads');
    expect(r.text).toContain('ada@x.com');
  });

  it('reads CSV raw — the rows ARE the data for a lead list', async () => {
    const r = await extractDeckText('leads.csv', fx('leads.csv'));
    expect(r.ok).toBe(true);
    expect(r.text).toContain('grace@y.io');
  });

  it('reads plain text, markdown and json', async () => {
    for (const [f, needle] of [['brief.txt', 'Q3 goal'], ['notes.md', 'Ship the thing'], ['cfg.json', '200']] as const) {
      const r = await extractDeckText(f, fx(f));
      expect(r.ok, f).toBe(true);
      expect(r.text, f).toContain(needle);
    }
  });
});

describe('failing usefully', () => {
  it('names a scanned PDF as a scan, not as an empty file', async () => {
    // The two have completely different remedies, and "empty?" sends someone to
    // check a file that is perfectly fine.
    const r = await extractDeckText('scan.pdf', fx('scan.pdf'));
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/no text layer|scan/i);
  });

  it('rejects a type it cannot read, naming what it does accept', async () => {
    const r = await extractDeckText('thing.exe', Buffer.from('MZ'));
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/unsupported/i);
  });

  it('does not throw on a corrupt file of a supported type', async () => {
    // One bad file must never 500 the upload route.
    const r = await extractDeckText('broken.docx', Buffer.from('not a zip at all'));
    expect(r.ok).toBe(false);
    expect(r.note).toBeTruthy();
  });

  it('agrees with isSupportedDeck about what it accepts', async () => {
    for (const f of ['a.pdf', 'a.docx', 'a.pptx', 'a.xlsx', 'a.csv', 'a.txt', 'a.md', 'a.json']) {
      expect(isSupportedDeck(f), f).toBe(true);
    }
    expect(isSupportedDeck('a.exe')).toBe(false);
  });
});
