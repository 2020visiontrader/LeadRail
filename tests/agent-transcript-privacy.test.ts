// The model's private `plan` must not cross to the browser.
//
// tests/agent-plan-privacy.test.ts pins the RENDERING half — no thinking line,
// no observation, no answer ever carries it. Its header used to name one honest
// exclusion: the `final` SSE event's `transcript` field, where the raw envelope
// legitimately lives so a later step can read it, and which was handed to the
// client verbatim. This file closes that exclusion and pins it shut.
//
// FOUR client boundaries carry a transcript, not the two the packet named:
//   1. the SSE `final` / `needs_approval` events   (app/api/agent/stream/route.ts)
//   2. the JSON route's response body              (app/api/agent/route.ts)
//   3. GET /api/agent/conversations/:id            — the RELOAD path, and the
//      one most likely to be forgotten: it hands the browser the whole stored
//      history on every refresh
//   4. POST /api/agent/conversations/:id/rerun     — the truncated transcript
//
// All four call the same pure helper, which is what this file tests directly.
// The routes are thin enough that a test through them would mostly be testing
// Next.js; what can actually go wrong is the helper's handling of the shapes a
// real transcript contains, and the ORDER of strip-vs-save in the stream route
// (asserted at the bottom).

import { describe, it, expect } from 'vitest';
import { stripPrivateReasoning } from '@/lib/agent/transcript-privacy';

const PLAN = 'PRIVATEPLANMARKER I have not checked the budget and I am guessing';

describe('stripPrivateReasoning removes plan and nothing else', () => {
  it('drops plan from an assistant envelope, keeping every other field', () => {
    const out = stripPrivateReasoning([
      { role: 'assistant', content: JSON.stringify({ plan: PLAN, narration: 'Pulling your leads…', action: 'tool', tool: 'listLeads', args: { limit: 5 } }) },
    ]);
    const parsed = JSON.parse(out[0].content);
    expect(parsed).not.toHaveProperty('plan');
    expect(parsed).toEqual({ narration: 'Pulling your leads…', action: 'tool', tool: 'listLeads', args: { limit: 5 } });
    expect(JSON.stringify(out)).not.toContain('PRIVATEPLANMARKER');
  });

  it('keeps the message id, so the console can still key a vote or a retry', () => {
    // Migration 076: StoredMessage.id is what src/components/AgentConsole.tsx
    // attaches a thumbs vote and a rerun truncation point to. A strip that lost
    // it would break both, silently, on every envelope that had a plan.
    const out = stripPrivateReasoning([
      { role: 'assistant', id: 'msg-42', content: JSON.stringify({ plan: PLAN, action: 'final', message: 'done' }) },
    ]);
    expect(out[0].id).toBe('msg-42');
  });

  it('passes a prose assistant message through byte-identically, by reference', () => {
    // The composed final answer is plain prose and is the majority of what a
    // transcript holds — loop.ts overwrites the last envelope with it. Identity,
    // not deep equality: "unchanged" has to mean the object, or a future
    // re-serialisation could quietly reshape content nothing asked it to touch.
    const msg = { role: 'assistant' as const, content: 'You have one lead, Ada at Acme.' };
    const out = stripPrivateReasoning([msg]);
    expect(out[0]).toBe(msg);
  });

  it('passes user messages through by reference, even JSON ones carrying a plan key', () => {
    // StoredMessage is user|assistant only (lib/agent/transcript-store.ts), and
    // the user side is where OBSERVATION lines live. A `plan` key on a NON-
    // assistant message is not the model's private reasoning and must not be
    // silently rewritten — the strip is scoped by role, not by content.
    const u = { role: 'user' as const, content: JSON.stringify({ plan: 'the user typed this word' }) };
    const obs = { role: 'user' as const, content: 'OBSERVATION: {"rows":[]}' };
    const out = stripPrivateReasoning([u, obs]);
    expect(out[0]).toBe(u);
    expect(out[1]).toBe(obs);
  });

  it('passes an assistant envelope with no plan through by reference', () => {
    const msg = { role: 'assistant' as const, content: JSON.stringify({ narration: 'hi', action: 'final', message: 'hi' }) };
    const out = stripPrivateReasoning([msg]);
    expect(out[0]).toBe(msg);
  });

  it('leaves a truncated / unparseable envelope alone rather than guessing', () => {
    // A cut-off envelope reaches the transcript on a deadline salvage. Half an
    // object is not something to rewrite — guessing at it turns a privacy filter
    // into a corruption bug.
    const msg = { role: 'assistant' as const, content: '{"plan":"PRIVATEPLANMARKER unfinis' };
    const out = stripPrivateReasoning([msg]);
    expect(out[0]).toBe(msg);
  });

  it('leaves a JSON array or scalar content alone', () => {
    const arr = { role: 'assistant' as const, content: '[1,2,3]' };
    expect(stripPrivateReasoning([arr])[0]).toBe(arr);
  });

  it('handles an empty, null or undefined transcript without throwing', () => {
    expect(stripPrivateReasoning([])).toEqual([]);
    expect(stripPrivateReasoning(null)).toEqual([]);
    expect(stripPrivateReasoning(undefined)).toEqual([]);
  });

  it('does not mutate the input — the SERVER copy must survive intact', () => {
    // THE LOAD-BEARING ONE. app/api/agent/route.ts saves `transcriptWithIds`
    // and then responds with `stripPrivateReasoning(transcriptWithIds)`; the
    // stream route captures `finalTranscript = e.transcript` and sends
    // `stripPrivateReasoning(e.transcript)`. If the strip mutated in place, the
    // reasoning would be gone from what gets PERSISTED, and requirement 1 —
    // a later turn can read it — would be silently broken by the fix for
    // requirement 2. An in-place `delete` is the obvious implementation and
    // this is the only thing standing between it and shipping.
    const original = { role: 'assistant' as const, content: JSON.stringify({ plan: PLAN, action: 'final', message: 'done' }) };
    const transcript = [original];
    stripPrivateReasoning(transcript);
    expect(transcript[0]).toBe(original);
    expect(original.content).toContain('PRIVATEPLANMARKER');
    expect(JSON.parse(original.content).plan).toBe(PLAN);
  });

  it('strips every envelope in a multi-step turn, not just the last', () => {
    const out = stripPrivateReasoning([
      { role: 'user', content: 'who are my leads?' },
      { role: 'assistant', content: JSON.stringify({ plan: `${PLAN} step one`, action: 'tool', tool: 'listLeads', args: {} }) },
      { role: 'user', content: 'OBSERVATION: {"rows":[]}' },
      { role: 'assistant', content: JSON.stringify({ plan: `${PLAN} step two`, action: 'tool', tool: 'listCampaigns', args: {} }) },
      { role: 'user', content: 'OBSERVATION: {"rows":[]}' },
      { role: 'assistant', content: 'You have no leads yet.' },
    ]);
    expect(JSON.stringify(out)).not.toContain('PRIVATEPLANMARKER');
    // The turn is otherwise unchanged: same length, same roles, observations
    // and the composed answer intact.
    expect(out).toHaveLength(6);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(out[5].content).toBe('You have no leads yet.');
    expect(out[1].content).toContain('listLeads');
    expect(out[3].content).toContain('listCampaigns');
  });
});

describe('the routes strip on the way out and save on the way in', () => {
  // Not a mock of Next.js — a read of the source, because the defect this
  // guards against is an ORDERING one and ordering is exactly what a unit test
  // of the helper cannot see. The stream route must capture `finalTranscript`
  // from the RAW event (that object is what saveConversation writes) and strip
  // only inside `send`. Swapping those two lines persists a transcript with the
  // reasoning already gone, and every test above would still pass.
  const read = (p: string) => require('fs').readFileSync(require('path').join(process.cwd(), p), 'utf8');

  it('the stream route captures the raw transcript before it strips', () => {
    const src = read('app/api/agent/stream/route.ts');
    const capture = src.indexOf('finalTranscript = e.transcript');
    const strip = src.indexOf('stripPrivateReasoning(e.transcript)');
    expect(capture).toBeGreaterThan(-1);
    expect(strip).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(strip);
    // And what is saved is the captured (unstripped) object.
    expect(src).toContain('const toSave = finalTranscript ?? openingTranscript;');
    expect(src).toContain('const withIds = ensureMessageIds(toSave);');
  });

  it('the JSON route saves the unstripped copy and responds with the stripped one', () => {
    const src = read('app/api/agent/route.ts');
    expect(src).toContain('transcript: transcriptWithIds,');            // the save
    expect(src).toContain('transcript: stripPrivateReasoning(transcriptWithIds),'); // the response
  });

  it('the reload and rerun routes strip too', () => {
    expect(read('app/api/agent/conversations/[id]/route.ts')).toContain('stripPrivateReasoning(transcript)');
    expect(read('app/api/agent/conversations/[id]/rerun/route.ts')).toContain('stripPrivateReasoning(transcript)');
  });

  it('no OTHER route hands a transcript to a client unstripped', () => {
    // The registry-driven half: a fifth boundary added later fails here rather
    // than leaking quietly. Any route whose JSON response mentions `transcript`
    // must also mention the strip.
    const { execSync } = require('child_process');
    const files = execSync(
      "grep -rl 'transcript' app/api --include=*.ts || true",
      { cwd: process.cwd(), encoding: 'utf8' },
    ).split('\n').filter(Boolean);
    const leaking = files.filter((f: string) => {
      // IMPORT LINES ARE REMOVED FIRST, and that is not cosmetic. The first
      // version of this check asked whether the file merely CONTAINED the word
      // `stripPrivateReasoning` — which an `import { stripPrivateReasoning }`
      // line satisfies on its own. The revert-check for this packet deleted the
      // CALL from app/api/agent/conversations/[id]/route.ts, left the import
      // behind exactly as a careless edit would, and this test stayed green:
      // it was asserting that someone had imported the helper, not that anyone
      // had used it. Predicted two failures, observed one; the gap was here.
      const src = read(f).split('\n').filter((l: string) => !/^\s*import\b/.test(l)).join('\n');
      // Does this file put a transcript into a response body at all?
      const responds = /NextResponse\.json\([^)]*transcript|send\(\s*\{[\s\S]*?transcript|transcript:\s*(?:withIds|transcriptWithIds|transcript\b)/.test(src);
      if (!responds) return false;
      return !src.includes('stripPrivateReasoning(');
    });
    expect(leaking).toEqual([]);
  });
});
