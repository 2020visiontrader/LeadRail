// The parser (parseFactsResult in lib/memory/extract.ts) against the real
// shapes model output actually takes. Production observation: the first
// real memory:extract row had facts: 0, parseFailed: true, promptChars at
// the 120k cap — the model was called, returned non-empty text, and the
// old `raw.match(/\{[\s\S]*\}/)` + JSON.parse couldn't read it. This file
// pins the parser against the shapes that regex chokes on, plus the
// observability that now logs a bounded raw sample only on that failure.

import { describe, it, expect } from 'vitest';
import { parseFactsResult } from '@/lib/memory/extract';

describe('parseFactsResult — real-world model output shapes', () => {
  it('parses a clean {"facts":[...]} object', () => {
    const raw = JSON.stringify({
      facts: [{ subject_type: 'contact', subject_label: 'Jane', predicate: 'has_role', object: 'VP', fact: 'Jane is VP.' }],
    });
    const r = parseFactsResult(raw);
    expect(r.ok).toBe(true);
    expect(r.facts).toHaveLength(1);
    expect(r.facts[0].subject_label).toBe('Jane');
  });

  it('parses a well-formed {"facts":[]} as ok — a normal "nothing durable" answer', () => {
    const r = parseFactsResult(JSON.stringify({ facts: [] }));
    expect(r.ok).toBe(true);
    expect(r.facts).toEqual([]);
  });

  it('parses a ```json fenced block', () => {
    const obj = { facts: [{ subject_type: 'company', subject_label: 'Acme', predicate: 'has_budget', object: '$65k', fact: 'Acme has a $65k budget.' }] };
    const raw = '```json\n' + JSON.stringify(obj) + '\n```';
    const r = parseFactsResult(raw);
    expect(r.ok).toBe(true);
    expect(r.facts).toHaveLength(1);
    expect(r.facts[0].object).toBe('$65k');
  });

  it('parses a bare ``` fence with no "json" tag', () => {
    const obj = { facts: [{ subject_type: 'deal', subject_label: 'Q3 Renewal', predicate: 'has_timeline', object: 'Q3 2026', fact: 'Renewal is targeted for Q3 2026.' }] };
    const raw = '```\n' + JSON.stringify(obj) + '\n```';
    const r = parseFactsResult(raw);
    expect(r.ok).toBe(true);
    expect(r.facts).toHaveLength(1);
  });

  it('parses an object wrapped in prose before and after it', () => {
    const obj = { facts: [{ subject_type: 'contact', subject_label: 'Bob', predicate: 'raised_objection', object: 'price', fact: 'Bob raised a price objection.' }] };
    const raw = `Sure, here is the extraction:\n${JSON.stringify(obj)}\nLet me know if you need anything else!`;
    const r = parseFactsResult(raw);
    expect(r.ok).toBe(true);
    expect(r.facts).toHaveLength(1);
    expect(r.facts[0].subject_label).toBe('Bob');
  });

  it('recovers the complete facts from a reply truncated mid-object, and drops the partial one — reporting ok:false', () => {
    const complete1 = { subject_type: 'contact', subject_label: 'Jane', predicate: 'has_role', object: 'VP Marketing', fact: 'Jane is VP Marketing.' };
    const complete2 = { subject_type: 'company', subject_label: 'Acme', predicate: 'has_budget', object: '$65k', fact: 'Acme has a $65k budget.' };
    // Third element is cut off partway through a string value — no closing
    // brace ever arrives, exactly what an output-token cutoff produces.
    const raw = `{"facts":[${JSON.stringify(complete1)},${JSON.stringify(complete2)},{"subject_type":"deal","subject_label":"Q3 Renewal","predicate":"has_timeline","object":"Q3`;

    const r = parseFactsResult(raw);
    expect(r.ok).toBe(false); // truncated is never a well-formed answer, even with usable content recovered
    expect(r.facts).toHaveLength(2);
    expect(r.facts[0].subject_label).toBe('Jane');
    expect(r.facts[1].subject_label).toBe('Acme');
    // Nothing invented for the partial third element.
    expect(r.facts.some((f: any) => f.subject_label === 'Q3 Renewal')).toBe(false);
  });

  it('accepts a bare array of facts instead of the requested {"facts":[...]} wrapper', () => {
    const arr = [{ subject_type: 'segment', subject_label: 'SMB', predicate: 'observed_pattern', object: 'faster close', fact: 'SMB deals close faster.' }];
    const r = parseFactsResult(JSON.stringify(arr));
    expect(r.ok).toBe(true);
    expect(r.facts).toHaveLength(1);
    expect(r.facts[0].subject_label).toBe('SMB');
  });

  it('recovers complete elements from a truncated bare array too', () => {
    const complete = { subject_type: 'segment', subject_label: 'SMB', predicate: 'observed_pattern', object: 'faster close', fact: 'SMB deals close faster.' };
    const raw = `[${JSON.stringify(complete)},{"subject_type":"segment","subject_label":"Enterprise","predicate":"observed_pat`;
    const r = parseFactsResult(raw);
    expect(r.ok).toBe(false);
    expect(r.facts).toHaveLength(1);
    expect(r.facts[0].subject_label).toBe('SMB');
  });

  it('reports ok:false and no facts for genuine prose garbage with no JSON at all', () => {
    const r = parseFactsResult('Sorry, I cannot help with that request.');
    expect(r.ok).toBe(false);
    expect(r.facts).toEqual([]);
  });

  it('reports ok:false and no facts for an empty reply', () => {
    const r = parseFactsResult('');
    expect(r.ok).toBe(false);
    expect(r.facts).toEqual([]);
  });

  it('never invents a fact for a bracket-balanced but syntactically broken element — skips it', () => {
    // Second element has a trailing comma before its closing brace: bracket-
    // balanced (findMatchingClose finds the close) but JSON.parse rejects it.
    const raw = `{"facts":[{"subject_type":"contact","subject_label":"Jane","predicate":"has_role","object":"VP","fact":"Jane is VP.",},{"subject_type":"contact","subject_label":"Bob","predicate":"has_role","object":"CFO","fact":"Bob is CFO.",}]}`;
    const r = parseFactsResult(raw);
    // The outer object itself is also malformed (both elements have trailing
    // commas), so the whole-object JSON.parse fails and this falls through to
    // element-by-element recovery — which skips every malformed element
    // rather than repairing or inventing one.
    expect(r.ok).toBe(false);
    expect(r.facts).toEqual([]);
  });
});

