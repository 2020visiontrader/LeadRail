// Unit tests for the pure pieces of lib/agent/comprehension.ts — sampling,
// parsing, and the text-building helpers — driven directly, with no DB, no
// tool registry, no agent loop standing up. The end-to-end regression this
// module exists to fix (the 34,649-character real transcript being routed on
// its opening small talk) is covered separately in
// tests/coordinator-fanout-comprehension.test.ts, which drives the real
// runAgent/runAgentStream loop with a mocked comprehend() call.

import { readFileSync } from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import {
  sampleAcrossDocument, parseUnderstanding,
  formatUnderstandingBlock, type Understanding,
} from '@/lib/agent/comprehension';

const TRANSCRIPT = readFileSync(
  path.join(__dirname, 'fixtures', 'meeting-transcript.txt'),
  'utf8',
);

describe('sampleAcrossDocument', () => {
  it('returns the material unchanged when it already fits the budget', () => {
    expect(sampleAcrossDocument('short text', 1000)).toBe('short text');
  });

  it('never returns just the head — the excerpt reaches the END of the document', () => {
    const budget = 2000;
    const excerpt = sampleAcrossDocument(TRANSCRIPT, budget);
    // The real regression: the caller's opening small talk ("we are equity
    // agency… over 20 million kind of Euros in revenue…") sits in the first
    // ~1200 characters. A head slice at this budget would contain it and
    // nothing past it. Sampling across the document must reach material near
    // the end too.
    const tail = TRANSCRIPT.slice(-200);
    expect(excerpt).not.toBe(TRANSCRIPT.slice(0, budget));
    expect(excerpt.includes(tail.slice(0, 50)) || excerpt.includes(tail.slice(-50))).toBe(true);
  });

  it('stays within the requested budget (plus separators)', () => {
    const budget = 5000;
    const excerpt = sampleAcrossDocument(TRANSCRIPT, budget);
    // 5 segments joined by a short separator — allow generous slack for the
    // separators themselves rather than pinning an exact byte count.
    expect(excerpt.length).toBeLessThan(budget + 500);
  });

  it('the regression fixture: the substance-bearing back half of the transcript is reachable', () => {
    // Measured directly against the real file: the product/demo/Q&A content
    // that a correct comprehension pass needs lives well past character 1200
    // (the old ROUTING_DIGEST_CHARS head slice). Confirms the fixture itself
    // still reproduces the shape of the bug this module fixes.
    expect(TRANSCRIPT.length).toBeGreaterThan(30_000);
    const head1200 = TRANSCRIPT.slice(0, 1200);
    expect(head1200).not.toMatch(/demo|product|dashboard|platform/i);
  });
});

describe('parseUnderstanding', () => {
  it('parses a well-formed comprehension response', () => {
    const raw = JSON.stringify({
      ask: 'Analyse the attached sales call and summarize it.',
      askType: 'analyse',
      material: {
        kind: 'sales call transcript',
        subject: 'a creator-analytics product pitch, live demo, and Q&A',
        participants: ['Speaker 1', 'Speaker 2'],
        quality: 'raw ASR with heavy transcription errors',
        keyPoints: ['Pitches a creator-analytics dashboard', 'Live product demo', 'Investor Q&A on pricing'],
      },
      outputShape: 'a short summary of the pitch, demo, and open questions',
      needs: ['summarization'],
    });
    const out = parseUnderstanding(raw);
    expect(out?.ask).toContain('Analyse');
    expect(out?.material?.subject).toContain('creator-analytics');
    expect(out?.material?.keyPoints.length).toBe(3);
    expect(out?.needs).toEqual(['summarization']);
  });

  it('returns null for a response with no usable "ask"', () => {
    expect(parseUnderstanding(JSON.stringify({ action: 'final', message: 'not a comprehension response' }))).toBeNull();
  });

  it('returns null for unparseable garbage', () => {
    expect(parseUnderstanding('not json at all')).toBeNull();
  });

  it('tolerates a near-miss (unquoted key) the same way json-envelope.ts repairs tool calls', () => {
    const raw = '{"ask":"summarize this", askType:"analyse","needs":["summarization"]}';
    const out = parseUnderstanding(raw);
    expect(out?.ask).toBe('summarize this');
    expect(out?.askType).toBe('analyse');
  });

  it('defaults askType to "other" when the value is not one of the known ones', () => {
    const out = parseUnderstanding(JSON.stringify({ ask: 'do a thing', askType: 'wat', needs: [] }));
    expect(out?.askType).toBe('other');
  });

  it('omits material when the model omitted it', () => {
    const out = parseUnderstanding(JSON.stringify({ ask: 'draft a follow-up email', askType: 'build', needs: ['copywriting'] }));
    expect(out?.material).toBeUndefined();
  });
});

describe('formatUnderstandingBlock', () => {
  it('produces a compact grounding block, not the whole document', () => {
    const understanding: Understanding = {
      ask: 'Analyse the transcript',
      askType: 'analyse',
      material: { kind: 'transcript', subject: 'a product pitch', keyPoints: ['Point A', 'Point B'] },
      outputShape: 'a summary',
      needs: ['summarization'],
    };
    const block = formatUnderstandingBlock(understanding);
    expect(block).toContain('a product pitch');
    expect(block).toContain('Point A');
    expect(block.length).toBeLessThan(1000);
  });
});
