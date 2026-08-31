// Item 2 of the deliverable-formats packet: FileCard's pure parsing/formatting
// helpers, pinned directly (no DOM test environment in this project — see
// FileCard.tsx's own comment on why these are exported).

import { describe, it, expect } from 'vitest';
import { formatBytes, parseCsv, rowsToTable } from '@/components/FileCard';

describe('formatBytes', () => {
  it('formats bytes under 1KB as bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
  });

  it('formats KB range', () => {
    expect(formatBytes(16384)).toBe('16 KB');
  });

  it('formats MB range with one decimal', () => {
    expect(formatBytes(2_500_000)).toBe('2.4 MB');
  });

  it('returns empty string for missing/invalid input', () => {
    expect(formatBytes(undefined)).toBe('');
    expect(formatBytes(-5)).toBe('');
    expect(formatBytes(NaN)).toBe('');
  });
});

describe('parseCsv', () => {
  it('parses a simple comma-separated file into rows', () => {
    const rows = parseCsv('Name,Deals\nAcme,3\nGlobex,1\n');
    expect(rows).toEqual([['Name', 'Deals'], ['Acme', '3'], ['Globex', '1']]);
  });

  it('handles quoted fields containing commas and embedded escaped quotes', () => {
    const rows = parseCsv('Name,Note\n"Acme, Inc.","Said ""hi"" to us"\n');
    expect(rows).toEqual([['Name', 'Note'], ['Acme, Inc.', 'Said "hi" to us']]);
  });

  it('handles a newline embedded inside a quoted field', () => {
    const rows = parseCsv('Name,Note\n"Acme","line one\nline two"\n');
    expect(rows).toEqual([['Name', 'Note'], ['Acme', 'line one\nline two']]);
  });

  it('handles CRLF line endings', () => {
    const rows = parseCsv('Name,Deals\r\nAcme,3\r\n');
    expect(rows).toEqual([['Name', 'Deals'], ['Acme', '3']]);
  });

  it('returns an empty array for empty input', () => {
    expect(parseCsv('')).toEqual([]);
  });
});

describe('rowsToTable', () => {
  it('splits header from body and reports zero withheld under the cap', () => {
    const rows = [['A', 'B'], ['1', '2'], ['3', '4']];
    const table = rowsToTable(rows);
    expect(table.headers).toEqual(['A', 'B']);
    expect(table.rows).toEqual([['1', '2'], ['3', '4']]);
    expect(table.totalRows).toBe(2);
  });

  it('caps displayed rows at 50 and reports the withheld count', () => {
    const header = ['Col'];
    const body = Array.from({ length: 120 }, (_, i) => [String(i)]);
    const table = rowsToTable([header, ...body]);
    expect(table.rows.length).toBe(50);
    expect(table.totalRows).toBe(120);
  });
});
