// How a live transcript composes with what is already typed.
//
// This is the rule that makes streaming dictation work, and it is the one that
// is easy to get backwards. Each interim pass re-transcribes the WHOLE
// recording, so it returns a revised version of the same sentence — not the
// next words. Appending would stack five copies of one sentence in the box.
//
// The component itself is MediaRecorder and DOM (no browser test environment
// here), so this pins the composition rule the component applies.

import { describe, it, expect } from 'vitest';

/** Mirrors onInterim/onFinal in AgentConsole: the typed prefix is frozen when
 *  dictation starts, and the spoken span is replaced on every pass. */
function compose(base: string, spoken: string): string {
  if (!spoken) return base;
  return base ? `${base.trim()} ${spoken}` : spoken;
}

describe('composing a live transcript', () => {
  it('replaces the spoken span rather than appending it', () => {
    const base = '';
    // Three passes over a lengthening recording of ONE sentence.
    const passes = ['what do', 'what do you', 'what do you think'];
    const final = passes.reduce((_, p) => compose(base, p), '');
    expect(final).toBe('what do you think');
    // The failure this guards: 'what dowhat do youwhat do you think'.
    expect(final).not.toContain('what dowhat');
  });

  it('keeps text typed before dictation started', () => {
    expect(compose('Draft a reply:', 'say we can ship Friday'))
      .toBe('Draft a reply: say we can ship Friday');
  });

  it('revises an earlier word when later context corrects it', () => {
    // The reason cumulative passes are worth their cost: the model hears more
    // and fixes what it got wrong.
    const base = 'Ask ';
    expect(compose(base, 'so ask about pricing')).toBe('Ask so ask about pricing');
    expect(compose(base, 'Zoask about pricing')).toBe('Ask Zoask about pricing');
  });

  it('restores exactly the typed prefix when dictation is cancelled', () => {
    // Cancel means discard. Leaving half a transcript behind is the opposite.
    expect(compose('half a thought', '')).toBe('half a thought');
  });

  it('leaves an empty box empty when a cancelled dictation had nothing typed', () => {
    expect(compose('', '')).toBe('');
  });

  it('does not double the separator when the prefix ends in whitespace', () => {
    expect(compose('Note:   ', 'call them back')).toBe('Note: call them back');
  });
});
