// Every case here is a REAL model response taken from production app_logs,
// recovered by the rawPreview logging added when parse failures were first
// found to be invisible. They are the reason a turn ran for eighteen minutes
// and ended on "I gathered the details but had trouble summarizing".
//
// Two parser bugs, both mine to have missed:
//
//   1. The scan was `/\{[\s\S]*\}/` — GREEDY, spanning the first `{` to the
//      LAST `}`. A model emitting two envelopes in one response produced a
//      match covering both plus the gap between them, which can never parse.
//      A perfectly good first envelope was thrown away whole.
//   2. Nothing repaired a near-miss. `"args":{limit: 200}` is a JavaScript
//      object literal one character from valid JSON, with unambiguous intent,
//      and it cost an entire step.

import { describe, it, expect } from 'vitest';
import { extractJson } from '@/lib/agent/json-envelope';

// No mocks and no test-only export hook: the parser is pure, so it is imported
// and called directly. That is the point of it being its own module — a test
// that has to stand up the database to reach a string function is a test
// nobody writes, which is how these bugs survived.
const parse = (raw: string) => extractJson(raw);

describe('real production failures that used to cost a whole turn', () => {
  it('parses an unquoted object key — {limit: 200}', async () => {
    const raw = '{"thought":"Listing leads to see contact details.","action":"tool","tool":"listLeads","args":{limit: 200}}';
    const out = parse(raw);
    expect(out?.tool).toBe('listLeads');
    expect(out?.args?.limit).toBe(200);
  });

  it('takes the FIRST envelope when the model emits two', async () => {
    // The greedy match spanned both and parsed neither.
    const raw = '{"thought":"a","action":"tool","tool":"listVentures","args":{}} {"thought":"b","action":"tool","tool":"listLeads","args":{}}';
    const out = parse(raw);
    // First, not last: the first envelope is the one it meant to act on — the
    // rest is it running ahead of itself.
    expect(out?.tool).toBe('listVentures');
  });

  it('handles both faults at once', async () => {
    const raw = '{"thought":"a","action":"tool","tool":"listLeads","args":{limit: 100}} {"thought":"b","action":"final","message":"done"}';
    const out = parse(raw);
    expect(out?.tool).toBe('listLeads');
    expect(out?.args?.limit).toBe(100);
  });

  it('still returns null for prose, so the nudge path is unchanged', async () => {
    const raw = 'The user wants to analyze leads for Retention Rail on the marketing side.';
    expect(parse(raw)).toBeNull();
  });
});

describe('the repair stays conservative', () => {
  it('does not touch a brace inside a message string', async () => {
    // A `}` in prose must not close the object early.
    const raw = '{"action":"final","message":"Use the shape {limit: 200} in your config, then stop."}';
    const out = parse(raw);
    expect(out?.action).toBe('final');
    expect(out?.message).toContain('{limit: 200}');
  });

  it('does not touch an escaped quote inside a string', async () => {
    const raw = '{"action":"final","message":"She said \\"no\\" and left."}';
    const out = parse(raw);
    expect(out?.message).toBe('She said "no" and left.');
  });

  it('drops a trailing comma', () => {
    const out = parse('{"action":"final","message":"ok",}');
    expect(out?.action).toBe('final');
  });

  it('never rewrites a VALUE — a wrong answer is worse than a parse failure', async () => {
    // `pending` here is an unquoted VALUE, not a key. Repairing it would be
    // guessing at content; refusing is correct.
    expect(parse('{"action":"final","status": pending}')).toBeNull();
  });

  it('handles a colon inside a string without quoting around it', () => {
    const out = parse('{"action":"final","message":"ratio: 4 to 8 percent"}');
    expect(out?.message).toBe('ratio: 4 to 8 percent');
  });
});

describe('unchanged behaviour', () => {
  it('parses ordinary valid JSON', () => {
    const out = parse('{"action":"final","message":"All done."}');
    expect(out).toEqual({ action: 'final', message: 'All done.' });
  });

  it('ignores leading prose before a valid envelope', () => {
    const out = parse('Here you go:\n{"action":"final","message":"ok"}');
    expect(out?.message).toBe('ok');
  });

  it('returns null on empty input', async () => {
    expect(parse('')).toBeNull();
  });
});
