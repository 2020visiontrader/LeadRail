// The duplication bug, reproduced and pinned.
//
// Shipped dictation produced: "Take a look at Take a look at the ventures we
// have. Take a look at the ventures we have Starting with retention rail…" —
// each pass containing every previous one. It was not the transcriber
// repeating itself. It was the typed-prefix snapshot being retaken after every
// interim, with that interim already inside it.
//
// The previous test (dictation-compose) checked the composition RULE and
// passed, because the rule was right. What it never modelled was WHEN the base
// is captured — so it could not see the bug. This models the render sequence.

import { describe, it, expect } from 'vitest';

/** compose(), as AgentConsole applies it. */
const compose = (base: string, spoken: string) =>
  !spoken ? base : base ? `${base.trim()} ${spoken}` : spoken;

/** A dictation session, parameterised by WHEN the base is snapshotted. */
function runSession(opts: { resnapshotEveryRender: boolean }) {
  let input = '';
  let base = '';
  const start = () => { base = input; };

  // Interim passes over a lengthening recording of ONE sentence. Each returns a
  // revised transcript of everything said so far — not the next words.
  const passes = [
    'Take a look at',
    'Take a look at the ventures we have',
    'Take a look at the ventures we have starting with retention rail',
  ];

  start();
  for (const p of passes) {
    // THE BUG: onActiveChange fired on every render because its identity
    // changed every render, and the parent used it to re-snapshot the base.
    if (opts.resnapshotEveryRender) base = input;
    input = compose(base, p);
  }
  return input;
}

describe('when the base is snapshotted once, at start', () => {
  it('ends with exactly what was said', () => {
    expect(runSession({ resnapshotEveryRender: false }))
      .toBe('Take a look at the ventures we have starting with retention rail');
  });

  it('never repeats the opening phrase', () => {
    const out = runSession({ resnapshotEveryRender: false });
    expect(out.match(/Take a look at/g)).toHaveLength(1);
  });
});

describe('the bug, so it stays fixed', () => {
  it('re-snapshotting on every render compounds the text', () => {
    // Reproduces the screenshot. Kept as a test so the failure mode is
    // documented rather than remembered.
    const out = runSession({ resnapshotEveryRender: true });
    expect(out.match(/Take a look at/g)!.length).toBeGreaterThan(1);
    expect(out).toContain('Take a look at Take a look at');
  });

  it('the two orderings genuinely differ — this is not a no-op test', () => {
    expect(runSession({ resnapshotEveryRender: false }))
      .not.toBe(runSession({ resnapshotEveryRender: true }));
  });
});

describe('growth is bounded', () => {
  it('twenty passes over one sentence leave one sentence', () => {
    let input = '';
    let base = '';
    base = input;
    for (let i = 0; i < 20; i++) input = compose(base, 'find marketing agencies');
    expect(input).toBe('find marketing agencies');
  });

  it('keeps a typed prefix without absorbing the dictated span', () => {
    let input = 'Draft this:';
    const base = input;
    for (const p of ['find', 'find marketing', 'find marketing agencies']) {
      input = compose(base, p);
    }
    expect(input).toBe('Draft this: find marketing agencies');
  });
});
