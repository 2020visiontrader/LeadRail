// Item 1 of the deliverable-formats packet: observation-render.ts must render
// a produced-file result (createFile's shape — url + filename, +optional
// format/mimeType/bytes/description) as readable prose naming the file and
// its link, never raw JSON — and it must do this by PAYLOAD SHAPE, not by
// checking which tool ran. See observation-render.ts's header comment and
// CLAUDE.md ("Render by payload shape, never by a tool-name allowlist").

import { describe, it, expect } from 'vitest';
import { renderObservation, renderJsonValue, parseFileFromObservation } from '@/lib/agent/observation-render';

const FILE_RESULT = {
  url: 'https://storage.example.com/bucket/abc123-report.xlsx',
  filename: 'report.xlsx',
  format: 'xlsx',
  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  bytes: 16384,
  description: 'Q3 pipeline export',
};

describe('renderJsonValue — file shape', () => {
  it('renders a file result as prose naming the file and its link, never raw JSON', () => {
    const out = renderJsonValue(FILE_RESULT);
    expect(out).not.toContain('{');
    expect(out).toContain('report.xlsx');
    expect(out).toContain('https://storage.example.com/bucket/abc123-report.xlsx');
    expect(out).toContain('16 KB');
    expect(out).toContain('Q3 pipeline export');
  });

  it('renders fine with only the required url + filename fields', () => {
    const out = renderJsonValue({ url: 'https://x.test/f.csv', filename: 'f.csv' });
    expect(out).toContain('f.csv');
    expect(out).toContain('https://x.test/f.csv');
  });

  it('does NOT mis-fire on a record that has a url but no filename (e.g. a lead with a company website)', () => {
    const lead = { name: 'Jane Doe', company: 'Acme', url: 'https://acme.example.com' };
    const out = renderJsonValue(lead);
    // Falls through to the generic labelled-fields rendering, not the file rendering.
    expect(out).toContain('name: Jane Doe');
    expect(out).toContain('company: Acme');
    expect(out).not.toMatch(/^File ready/);
  });

  it('does NOT mis-fire on a record that has a filename-like field but no url', () => {
    const rec = { filename: 'notes.txt', owner: 'ops' };
    const out = renderJsonValue(rec);
    expect(out).toContain('filename: notes.txt');
    expect(out).not.toMatch(/^File ready/);
  });

  it('still renders the subject/body drafted-email shape unaffected', () => {
    const out = renderJsonValue({ subject: 'Hi', body: 'Body text' });
    expect(out).toContain('Subject: Hi');
    expect(out).toContain('Body text');
  });
});

describe('renderObservation — full pipeline for createFile\'s digest+raw shape', () => {
  it('renders the digest line plus a readable file rendering, not the raw JSON', () => {
    const digest = `File ready: report.xlsx (16 KB) — ${FILE_RESULT.url}`;
    const raw = JSON.stringify(FILE_RESULT);
    const observation = `${digest}\n${raw}`;
    const out = renderObservation(observation, 4000);
    expect(out).toContain('report.xlsx');
    expect(out).toContain(FILE_RESULT.url);
    // The raw JSON braces from the second line must not survive verbatim.
    expect(out).not.toContain('"mimeType"');
  });
});

describe('parseFileFromObservation', () => {
  it('extracts the structured file fields from a digest+raw observation', () => {
    const digest = `File ready: report.xlsx (16 KB) — ${FILE_RESULT.url}`;
    const raw = JSON.stringify(FILE_RESULT);
    const parsed = parseFileFromObservation(`${digest}\n${raw}`);
    expect(parsed).toBeDefined();
    expect(parsed!.url).toBe(FILE_RESULT.url);
    expect(parsed!.filename).toBe(FILE_RESULT.filename);
    expect(parsed!.format).toBe('xlsx');
    expect(parsed!.bytes).toBe(16384);
  });

  it('extracts from a raw-JSON-only observation (no digest line)', () => {
    const parsed = parseFileFromObservation(JSON.stringify(FILE_RESULT));
    expect(parsed?.filename).toBe('report.xlsx');
  });

  it('returns undefined for a non-file payload', () => {
    expect(parseFileFromObservation(JSON.stringify({ name: 'Jane', company: 'Acme' }))).toBeUndefined();
  });

  it('returns undefined (never throws) for unparseable text', () => {
    expect(parseFileFromObservation('not json at all')).toBeUndefined();
  });
});
