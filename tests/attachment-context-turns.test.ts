// C5 — a document is read in full once, then by handle.
//
// Production trace this closes: a 34,456-char voice transcript sat in every
// single prompt of a long chat, and the user's explicit instruction ("focus
// on the marketing leads, not the demo call") was overridden nine times
// across turns 41-76 because the transcript outweighed it in context. These
// tests pin the three behaviours that fix that:
//
//   1. A document is injected in FULL the first turn it appears, and as a
//      compact STUB (name, summary, size, id, "call readDocument") on every
//      later turn of the SAME conversation.
//   2. Two stored attachments with byte-identical extracted text are
//      injected ONCE, not once per row.
//   3. A library-scoped document (ambient on every chat on the account) is
//      NEVER injected in full here — only as a stub, regardless of whether
//      this is the first turn it's been seen.

import { describe, it, expect } from 'vitest';
import { attachmentContextBlock } from '../lib/documents/attachments';

// A summary stub legitimately quotes the OPENING of the document (the first
// 300 chars), so "does the block contain the document's own words" is not a
// safe way to tell full-text from stub. Instead the fixture puts a unique
// marker WELL PAST the 300-char summary window — that marker can only appear
// in the block if the FULL text was injected, never from a stub's summary.
const MARKER = 'UNIQUE_MARKER_PAST_SUMMARY_WINDOW';
const longText = () => `This is the sales call transcript. ${'filler content. '.repeat(30)}${MARKER} — the rest of the call continues here.`;

const doc = (over: Partial<any> = {}): any => ({
  id: 'a1', account_id: 'acc', conversation_id: 'c1', scope: 'conversation',
  filename: 'transcript.txt', mime_type: 'text/plain', bytes: 34456,
  storage_path: 'acc/x.txt', kind: 'txt',
  extracted_text: longText(),
  chars: longText().length,
  status: 'ready', note: null, created_at: new Date().toISOString(), ...over,
});

describe('C5 — full once, then a stub', () => {
  it('injects the document in full on the turn it first appears', () => {
    const d = doc();
    const block = attachmentContextBlock([d], { alreadyShown: new Set() });
    expect(block).toContain('sales call transcript');
    expect(block).not.toContain('Not shown in full here');
  });

  it('represents the same document as a compact stub once it has been shown before', () => {
    const d = doc();
    const block = attachmentContextBlock([d], { alreadyShown: new Set([d.id]) });
    // The full text must NOT be present...
    expect(block).not.toContain(MARKER);
    // ...and the stub must carry filename, size, id, and a pointer at readDocument.
    expect(block).toContain('transcript.txt');
    expect(block).toContain('Not shown in full here');
    expect(block).toContain(String(d.chars));
    expect(block).toContain(d.id);
    expect(block).toMatch(/readDocument/);
  });

  it('the stub summary is capped at 300 characters', () => {
    const d = doc({ extracted_text: 'y'.repeat(10_000) });
    const block = attachmentContextBlock([d], { alreadyShown: new Set([d.id]) });
    const summaryLine = block.split('\n').find((l) => l.startsWith('Summary:'))!;
    expect(summaryLine).toBeTruthy();
    // "Summary: " (9 chars) + up to 300 chars of content + an ellipsis marker.
    expect(summaryLine.length).toBeLessThanOrEqual(9 + 300 + 1);
  });

  it('a fresh conversation with no prior bindings shows every document in full', () => {
    const a = doc({ id: 'a1', filename: 'one.txt' });
    const b = doc({ id: 'b1', filename: 'two.txt', extracted_text: 'Completely different content about pricing.' });
    const block = attachmentContextBlock([a, b], { alreadyShown: new Set() });
    expect(block).toContain('sales call transcript');
    expect(block).toContain('pricing');
  });
});

describe('C5 — dedupe by content', () => {
  it('renders two attachments with byte-identical extracted text once', () => {
    const text = 'Identical transcript content, uploaded twice by accident.';
    const a = doc({ id: 'dup-1', filename: 'copy-one.txt', extracted_text: text, chars: text.length });
    const b = doc({ id: 'dup-2', filename: 'copy-two.txt', extracted_text: text, chars: text.length });
    const block = attachmentContextBlock([a, b], { alreadyShown: new Set() });

    // The content appears exactly once, not twice.
    const occurrences = block.split('Identical transcript content').length - 1;
    expect(occurrences).toBe(1);
    // Only one BEGIN DOCUMENT marker was emitted for the pair.
    expect(block.split('--- BEGIN DOCUMENT').length - 1).toBe(1);
    // Said explicitly, not silently collapsed.
    expect(block).toMatch(/identical to 1 other upload/i);
  });

  it('does not merge two different unreadable files that both have no text', () => {
    const a = doc({ id: 'u1', filename: 'scan-a.pdf', status: 'unreadable', extracted_text: null, note: 'no text layer' });
    const b = doc({ id: 'u2', filename: 'scan-b.pdf', status: 'unreadable', extracted_text: null, note: 'no text layer' });
    const block = attachmentContextBlock([a, b], { alreadyShown: new Set() });
    expect(block.split('--- BEGIN DOCUMENT').length - 1).toBe(2);
    expect(block).toContain('scan-a.pdf');
    expect(block).toContain('scan-b.pdf');
  });

  it('every id in a duplicate group is still a valid readDocument target (the primary id shown is one of the group)', () => {
    const text = 'Same file, uploaded three times.';
    const a = doc({ id: 'x1', extracted_text: text, chars: text.length });
    const b = doc({ id: 'x2', extracted_text: text, chars: text.length });
    const c = doc({ id: 'x3', extracted_text: text, chars: text.length });
    // Stubbed (already shown), so the id in the stub is what a model would call readDocument with.
    const block = attachmentContextBlock([a, b, c], { alreadyShown: new Set(['x1']) });
    expect(block).toContain('x1');
  });
});

describe('C5 — library documents stop being ambient', () => {
  it('never injects a library document in full, even on its first appearance', () => {
    const d = doc({ id: 'lib-1', scope: 'library', filename: 'brand-book.pdf' });
    const block = attachmentContextBlock([d], { alreadyShown: new Set() });
    expect(block).not.toContain(MARKER);
    expect(block).toContain('Not shown in full here');
    expect(block).toMatch(/readDocument/);
  });

  it('still stubs a library document even if it happens to be in alreadyShown', () => {
    const d = doc({ id: 'lib-2', scope: 'library' });
    const block = attachmentContextBlock([d], { alreadyShown: new Set(['lib-2']) });
    expect(block).not.toContain(MARKER);
    expect(block).toContain('Not shown in full here');
  });

  it('a conversation-scoped document on the same turn is still shown in full', () => {
    const lib = doc({ id: 'lib-3', scope: 'library', filename: 'brand-book.pdf' });
    const convo = doc({ id: 'convo-1', scope: 'conversation', filename: 'brief.txt', extracted_text: 'This turn\'s actual brief content.' });
    const block = attachmentContextBlock([lib, convo], { alreadyShown: new Set() });
    expect(block).not.toContain(MARKER); // lib's text, stubbed
    expect(block).toContain("This turn's actual brief content."); // convo's text, full
  });
});

describe('backward compatibility — no options passed', () => {
  it('with no alreadyShown set at all, a conversation-scoped document is shown in full (unchanged default)', () => {
    const d = doc();
    const block = attachmentContextBlock([d]);
    expect(block).toContain('sales call transcript');
  });
});
