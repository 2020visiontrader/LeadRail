// pruneForWire (lib/agent/transcript-store.ts) — the route-pass-only
// transcript pruner. See the module comment in transcript-store.ts and the
// header of this task's plan for the full rationale: a route pass never
// needs to re-read old JSON envelopes or old tool JSON, only the plain-
// language digest a capability already put on the first line of its
// observation (successObservation, lib/agent/loop.ts).
//
// toWireMessages is UNCHANGED by this file's subject — pruneForWire is a
// separate, opt-in function, proven here in isolation. The persisted
// transcript (what saveConversation writes) is never touched by this
// function at all: callers pass a copy through it only on the way to a
// provider request, never back into `messages`.

import { describe, it, expect } from 'vitest';
import { pruneForWire, type StoredMessage } from '@/lib/agent/transcript-store';

function obs(text: string): StoredMessage {
  return { role: 'user', content: `OBSERVATION: ${text}` };
}

describe('pruneForWire', () => {
  it('drops a nudge message (content starting with "Respond with ONLY one JSON object")', () => {
    const messages: StoredMessage[] = [
      { role: 'user', content: 'What leads do we have?' },
      { role: 'user', content: 'Respond with ONLY one JSON object using the "tool" or "final" shape.' },
    ];
    const out = pruneForWire(messages);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe('What leads do we have?');
  });

  it('leaves the second-attempt JSON-contract nudge untouched (it does not share the drop prefix)', () => {
    // jsonNudge(attempt>1) in loop.ts starts with "Your last reply was not
    // valid JSON" — a different string from the dropped prefix — so it is
    // ordinary user content as far as pruneForWire is concerned.
    const text = 'Your last reply was not valid JSON, so it could not be used. Reply with ONE JSON object and nothing else: {"action":"final","message":"<your answer to the user>"}. No prose outside it, no code fences.';
    const messages: StoredMessage[] = [{ role: 'user', content: text }];
    const out = pruneForWire(messages);
    expect(out).toEqual([{ role: 'user', content: text }]);
  });

  it('collapses a tool envelope to "[called X]"', () => {
    const messages: StoredMessage[] = [
      { role: 'assistant', content: JSON.stringify({ plan: 'p', narration: 'n', action: 'tool', tool: 'listLeads', args: {} }) },
    ];
    const out = pruneForWire(messages);
    expect(out).toEqual([{ role: 'assistant', content: '[called listLeads]' }]);
  });

  it('collapses a tool envelope with no tool name to "[called tool]"', () => {
    const messages: StoredMessage[] = [
      { role: 'assistant', content: JSON.stringify({ action: 'tool' }) },
    ];
    const out = pruneForWire(messages);
    expect(out).toEqual([{ role: 'assistant', content: '[called tool]' }]);
  });

  it('collapses a final envelope to its message', () => {
    const messages: StoredMessage[] = [
      { role: 'assistant', content: JSON.stringify({ action: 'final', message: 'Here are your 3 leads.' }) },
    ];
    const out = pruneForWire(messages);
    expect(out).toEqual([{ role: 'assistant', content: 'Here are your 3 leads.' }]);
  });

  it('falls back to "answer"/"text" fields for a final envelope', () => {
    const out1 = pruneForWire([{ role: 'assistant', content: JSON.stringify({ action: 'final', answer: 'via answer' }) }]);
    expect(out1).toEqual([{ role: 'assistant', content: 'via answer' }]);
    const out2 = pruneForWire([{ role: 'assistant', content: JSON.stringify({ action: 'final', text: 'via text' }) }]);
    expect(out2).toEqual([{ role: 'assistant', content: 'via text' }]);
  });

  it('drops a final envelope with no usable message string', () => {
    const messages: StoredMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: JSON.stringify({ action: 'final', message: '   ' }) },
      { role: 'user', content: 'bye' },
    ];
    const out = pruneForWire(messages);
    expect(out).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'user', content: 'bye' },
    ]);
  });

  it('leaves unparseable / non-envelope assistant content byte-identical', () => {
    const messages: StoredMessage[] = [
      { role: 'assistant', content: 'this is not JSON at all' },
      { role: 'assistant', content: JSON.stringify({ action: 'tools', reads: [] }) },
      { role: 'assistant', content: JSON.stringify({ notAnAction: true }) },
    ];
    const out = pruneForWire(messages);
    expect(out).toEqual(messages.map(({ role, content }) => ({ role, content })));
  });

  it('keeps the most recent 2 observations in full, reduces an older 3rd to its digest line', () => {
    const messages: StoredMessage[] = [
      obs('short digest one\n{"a":1,"b":2,"c":3}'),
      obs('short digest two\n{"a":1,"b":2,"c":3}'),
      obs('short digest three\n{"a":1,"b":2,"c":3}'),
    ];
    const out = pruneForWire(messages);
    expect(out[0].content).toBe('OBSERVATION: short digest one'); // reduced (oldest, 3rd from the end)
    expect(out[1].content).toBe(messages[1].content); // kept in full (2nd most recent)
    expect(out[2].content).toBe(messages[2].content); // kept in full (most recent)
  });

  it('reduces an old observation with a JSON-looking first line by clipping with the truncation marker instead of using it as a digest', () => {
    const raw = JSON.stringify({ leads: Array.from({ length: 50 }, (_, i) => ({ id: i, name: `Lead ${i}` })) });
    const messages: StoredMessage[] = [
      obs(raw), // no digest — starts with '{' — will be the oldest of 3
      obs('recent 2'),
      obs('recent 1'),
    ];
    const out = pruneForWire(messages, { digestChars: 50 });
    expect(out[0].content.startsWith('OBSERVATION: {')).toBe(true);
    expect(out[0].content.endsWith('… [truncated]')).toBe(true);
    expect(out[0].content.length).toBeLessThan(raw.length);
  });

  it('clips an old observation whose first line has no newline and exceeds digestChars, rather than keeping it whole', () => {
    const longFirstLine = 'x'.repeat(3000); // no newline at all, single-line body
    const messages: StoredMessage[] = [
      obs(longFirstLine),
      obs('recent 2'),
      obs('recent 1'),
    ];
    const out = pruneForWire(messages, { digestChars: 2000 });
    expect(out[0].content).toBe(`OBSERVATION: ${longFirstLine.slice(0, 2000)}… [truncated]`);
  });

  it('respects a custom keepRecent', () => {
    const messages: StoredMessage[] = [obs('one'), obs('two'), obs('three')];
    const out = pruneForWire(messages, { keepRecent: 3 });
    expect(out).toEqual(messages.map(({ role, content }) => ({ role, content })));
  });

  it('preserves message order across drops, collapses, and reductions', () => {
    const messages: StoredMessage[] = [
      { role: 'user', content: 'question' },
      { role: 'assistant', content: JSON.stringify({ action: 'tool', tool: 'a' }) },
      obs('result a'),
      { role: 'user', content: 'Respond with ONLY one JSON object using the "tool" or "final" shape.' },
      { role: 'assistant', content: JSON.stringify({ action: 'tool', tool: 'b' }) },
      obs('result b'),
      { role: 'assistant', content: JSON.stringify({ action: 'tool', tool: 'c' }) },
      obs('result c'),
    ];
    const out = pruneForWire(messages);
    expect(out.map((m) => m.content)).toEqual([
      'question',
      '[called a]',
      'OBSERVATION: result a', // reduced, but "result a" has no newline/JSON so digest == full text here
      '[called b]',
      'OBSERVATION: result b',
      '[called c]',
      'OBSERVATION: result c',
    ]);
  });

  it('does not mutate the input array or its entries', () => {
    const messages: StoredMessage[] = [
      { role: 'user', content: 'hi', id: 'm1' },
      obs('one\n{"x":1}'),
      obs('two'),
      obs('three'),
    ];
    const snapshot = JSON.parse(JSON.stringify(messages));
    pruneForWire(messages);
    expect(messages).toEqual(snapshot);
  });

  it('handles a legacy transcript with no id fields', () => {
    const messages: StoredMessage[] = [
      { role: 'user', content: 'hi' }, // no id — pre-migration-076 shape
      { role: 'assistant', content: JSON.stringify({ action: 'final', message: 'hello' }) },
    ];
    const out = pruneForWire(messages);
    expect(out).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    expect(out.every((m) => !('id' in m))).toBe(true);
  });

  it('never leaks the id field on any passed-through or transformed message', () => {
    const messages: StoredMessage[] = [
      { role: 'user', content: 'hi', id: 'm1' },
      { role: 'assistant', content: 'plain text', id: 'm2' },
      { ...obs('digest\nrest'), id: 'm3' },
      { ...obs('kept'), id: 'm4' },
      { ...obs('kept2'), id: 'm5' },
    ];
    const out = pruneForWire(messages);
    for (const m of out) expect(Object.keys(m).sort()).toEqual(['content', 'role']);
  });
});
