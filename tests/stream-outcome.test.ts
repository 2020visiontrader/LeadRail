// Three delegate steps read "Milo is working on the messaging…" for hours, on a
// turn that had already errored server-side and been logged as errored before
// the user even looked at it.
//
// Nothing was hung. The turn was over. The read loop broke on a clean `done`
// and fell straight through to cleanup, so no step was ever closed and nothing
// was ever said. Only a THROWN error closed anything, and a server that dies
// after the stream is open does not throw at the client — it just stops
// sending.
//
// These drive real SSE bytes through the shipped loop rather than a copy of it,
// because every individual function here was already correct. The defect was
// the path between them, and a test that re-implements that path cannot see it.

import { describe, it, expect, vi } from 'vitest';
import {
  consumeEventStream, finalizeStream, closeOpenSteps, parseSseFrames,
  isTerminalEvent, DEAD_STREAM_MESSAGE, type Step,
} from '@/lib/agent/stream-outcome';

const enc = new TextEncoder();
const frame = (o: any) => `data: ${JSON.stringify(o)}\n\n`;

/** A reader over a fixed set of chunks — the real interface, so the loop under
 *  test is the one that ships. */
function readerOf(chunks: string[], opts: { throwAtEnd?: any } = {}) {
  let i = 0;
  return {
    async read() {
      if (i < chunks.length) return { value: enc.encode(chunks[i++]), done: false };
      if (opts.throwAtEnd) throw opts.throwAtEnd;
      return { value: undefined, done: true };
    },
  };
}

/** Two tool steps mid-flight, which is what was left spinning. */
const openSteps = (): Step[] => [
  { kind: 'tool', text: 'Milo is working on the messaging…' },
  { kind: 'tool', text: 'Iris is pulling the numbers…' },
];

describe('a stream that just stops', () => {
  it('is treated as a failure, not a success', async () => {
    const steps = openSteps();
    const { sawTerminal } = await consumeEventStream({
      reader: readerOf([frame({ type: 'step_start', text: 'working' })]),
      onEvent: () => {},
    });
    expect(sawTerminal).toBe(false);

    finalizeStream({ steps, sawTerminal, aborted: false });
    expect(steps.every((s) => s.kind === 'error' || s.done)).toBe(true);
  });

  it('closes the spinners — the actual symptom', async () => {
    const steps = openSteps();
    const { sawTerminal } = await consumeEventStream({ reader: readerOf([]), onEvent: () => {} });
    finalizeStream({ steps, sawTerminal, aborted: false });
    expect(steps.filter((s) => s.kind === 'tool').every((s) => s.done)).toBe(true);
  });

  it('marks the unfinished tools failed, not quietly succeeded', async () => {
    // A green tick on a call that never returned is worse than no tick: it
    // reports work that did not happen.
    const steps = openSteps();
    finalizeStream({ steps, sawTerminal: false, aborted: false });
    expect(steps.filter((s) => s.kind === 'tool').every((s) => s.ok === false)).toBe(true);
  });

  it('says so, instead of leaving a turn that silently stops', async () => {
    const steps = openSteps();
    finalizeStream({ steps, sawTerminal: false, aborted: false });
    const note = steps[steps.length - 1];
    expect(note.kind).toBe('error');
    expect(note.text).toBe(DEAD_STREAM_MESSAGE);
    // It must not imply the work was lost — it was saved server-side.
    expect(note.text).toContain('Nothing was lost');
  });
});

describe('endings that are NOT failures stay untouched', () => {
  it('a final leaves no error behind', async () => {
    const steps = openSteps();
    const { sawTerminal } = await consumeEventStream({
      reader: readerOf([frame({ type: 'final', message: 'Here you go.' })]),
      onEvent: () => {},
    });
    expect(sawTerminal).toBe(true);
    const r = finalizeStream({ steps, sawTerminal, aborted: false });
    expect(r.closed).toBe(false);
    expect(steps.some((s) => s.kind === 'error')).toBe(false);
  });

  it('needs_approval is an ending too — a paused turn is not a dead one', async () => {
    const { sawTerminal } = await consumeEventStream({
      reader: readerOf([frame({ type: 'needs_approval', message: 'ok?' })]),
      onEvent: () => {},
    });
    expect(sawTerminal).toBe(true);
    expect(finalizeStream({ steps: openSteps(), sawTerminal, aborted: false }).closed).toBe(false);
  });

  it('a reported error is an ending, so the user is not told twice', async () => {
    const { sawTerminal } = await consumeEventStream({
      reader: readerOf([frame({ type: 'error', message: 'no' })]),
      onEvent: () => {},
    });
    expect(finalizeStream({ steps: openSteps(), sawTerminal, aborted: false }).closed).toBe(false);
  });

  it('an abort is the user pressing Stop, not a fault', async () => {
    const steps = openSteps();
    const r = finalizeStream({ steps, sawTerminal: false, aborted: true });
    expect(r.closed).toBe(false);
    expect(steps.some((s) => s.text === DEAD_STREAM_MESSAGE)).toBe(false);
  });

  it('does not report a dropped connection twice', async () => {
    // The transport error is announced where it is raised; finalize must then
    // stay quiet rather than stacking a second message on the same failure.
    const onTransportError = vi.fn();
    const { sawTerminal, transportFailed } = await consumeEventStream({
      reader: readerOf([frame({ type: 'step_start' })], { throwAtEnd: new Error('socket') }),
      onEvent: () => {},
      onTransportError,
    });
    expect(transportFailed).toBe(true);
    expect(onTransportError).toHaveBeenCalledTimes(1);
    const steps = openSteps();
    finalizeStream({ steps, sawTerminal: sawTerminal || transportFailed, aborted: false });
    expect(steps.some((s) => s.text === DEAD_STREAM_MESSAGE)).toBe(false);
  });

  it('an AbortError mid-read is not reported as a fault', async () => {
    const onTransportError = vi.fn();
    const err: any = new Error('aborted');
    err.name = 'AbortError';
    const { transportFailed } = await consumeEventStream({
      reader: readerOf([], { throwAtEnd: err }),
      onEvent: () => {},
      onTransportError,
    });
    expect(transportFailed).toBe(false);
    expect(onTransportError).not.toHaveBeenCalled();
  });
});

describe('frame reading', () => {
  it('delivers events split across chunk boundaries', async () => {
    // A frame arriving in two TCP reads must not be dropped or double-counted.
    const whole = frame({ type: 'final', message: 'split' });
    const cut = Math.floor(whole.length / 2);
    const seen: any[] = [];
    const { sawTerminal } = await consumeEventStream({
      reader: readerOf([whole.slice(0, cut), whole.slice(cut)]),
      onEvent: (e) => seen.push(e),
    });
    expect(seen).toHaveLength(1);
    expect(sawTerminal).toBe(true);
  });

  it('ignores [DONE] — it is a sentinel, not a terminal event', async () => {
    // The trap: treating [DONE] as an ending would mask exactly the dead
    // stream this fix exists to catch, since the server sends it either way.
    const seen: any[] = [];
    const { sawTerminal } = await consumeEventStream({
      reader: readerOf([frame({ type: 'step_start' }) + 'data: [DONE]\n\n']),
      onEvent: (e) => seen.push(e),
    });
    expect(seen).toHaveLength(1);
    expect(sawTerminal).toBe(false);
  });

  it('skips a torn frame without stranding the rest of the turn', async () => {
    const seen: any[] = [];
    await consumeEventStream({
      reader: readerOf(['data: {not json\n\n' + frame({ type: 'final', message: 'ok' })]),
      onEvent: (e) => seen.push(e),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].message).toBe('ok');
  });

  it('keeps a partial trailing frame buffered rather than parsing it early', () => {
    const { events, rest } = parseSseFrames(frame({ type: 'a' }) + 'data: {"type":"b"');
    expect(events).toHaveLength(1);
    expect(rest).toBe('data: {"type":"b"');
  });
});

describe('closeOpenSteps', () => {
  it('leaves already-finished steps alone', () => {
    const steps: Step[] = [{ kind: 'tool', done: true, ok: true }];
    closeOpenSteps(steps, true);
    expect(steps[0].ok).toBe(true);   // not retroactively failed
  });

  it('does not mark non-tool steps as failed', () => {
    const steps: Step[] = [{ kind: 'note', text: 'thinking' }];
    closeOpenSteps(steps, true);
    expect(steps[0].done).toBe(true);
    expect(steps[0].ok).toBeUndefined();
  });

  it('tolerates an empty step list', () => {
    expect(() => closeOpenSteps([], true)).not.toThrow();
  });
});

describe('isTerminalEvent', () => {
  it('accepts only the three endings', () => {
    for (const t of ['final', 'needs_approval', 'error']) expect(isTerminalEvent({ type: t })).toBe(true);
    for (const t of ['step_start', 'tool', 'final_delta', 'evidence', 'claim', 'compaction_suggested']) {
      expect(isTerminalEvent({ type: t })).toBe(false);
    }
    expect(isTerminalEvent(null)).toBe(false);
  });
});
