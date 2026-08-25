// The evaluator is a gate. A gate with no tests is a gate that quietly opens.
//
// These pin the two properties that matter and are easiest to lose in a later
// edit: a BLOCK is reserved for things that genuinely cannot ship, and ad
// policy never blocks. The second one is a deliberate design choice rather
// than an oversight — see the note in evaluate.ts — so it is asserted here to
// stop a well-meaning future change from turning a warn into a block and
// silently killing legitimate ads.

import { describe, it, expect } from 'vitest';
import { evaluate } from '../lib/content/evaluate';
import type { PlatformSpec } from '../lib/content/store';

const spec = (over: Partial<PlatformSpec> = {}): PlatformSpec => ({
  platform: 'instagram',
  char_limit: 2200,
  image_specs: null,
  hashtag_strategy: null,
  cta_format: null,
  copy_tone: null,
  optimal_time: null,
  ...over,
});

const base = {
  hook: 'We cut onboarding from 14 days to 3.',
  body: 'The fix was removing two approval steps that existed for a client we lost in 2019.',
  cta: 'Reply "onboarding" and I will send the checklist.',
  spec: spec(),
  family: 'text' as const,
  intent: 'organic' as const,
};

describe('spec compliance', () => {
  it('passes clean copy inside the limit', () => {
    const r = evaluate(base);
    expect(r.pass).toBe(true);
    expect(r.issues.filter((i) => i.severity === 'block')).toHaveLength(0);
  });

  it('blocks copy over the platform limit', () => {
    const r = evaluate({ ...base, body: 'x'.repeat(3000) });
    expect(r.pass).toBe(false);
    expect(r.issues.some((i) => i.check === 'spec' && i.severity === 'block')).toBe(true);
  });

  it('blocks a short video that has no beats — a caption is not a shoot', () => {
    const r = evaluate({ ...base, family: 'short_video', production: {} });
    expect(r.pass).toBe(false);
    expect(r.issues.some((i) => /beats/i.test(i.message))).toBe(true);
  });

  it('passes a short video that carries its production artefacts', () => {
    const r = evaluate({
      ...base,
      family: 'short_video',
      production: { beats: [{ say: 'We cut onboarding to 3 days.' }], openingFrame: 'Hands closing a laptop.' },
    });
    expect(r.pass).toBe(true);
  });
});

describe('algorithmic fit', () => {
  it('warns on preamble but never blocks for it', () => {
    const r = evaluate({ ...base, hook: "In today's world, onboarding is hard." });
    const hit = r.issues.find((i) => i.check === 'algorithmic' && /preamble/i.test(i.message));
    expect(hit?.severity).toBe('warn');
    expect(r.pass).toBe(true);
  });

  it('flags a hook that outruns the platform hold window', () => {
    const r = evaluate({
      ...base,
      spec: spec({ hook_hold_seconds: 3 }),
      hook: 'I want to take a moment here to walk you through the entire history of how our onboarding process came to be what it is today',
    });
    expect(r.issues.some((i) => /hook takes about/i.test(i.message))).toBe(true);
  });

  it('blocks a paid asset with no call to action', () => {
    const r = evaluate({ ...base, intent: 'paid', cta: '' });
    expect(r.pass).toBe(false);
  });
});

describe('ad policy', () => {
  it('flags guaranteed-results wording on paid', () => {
    const r = evaluate({ ...base, intent: 'paid', body: 'Guaranteed results in 30 days.' });
    expect(r.issues.some((i) => i.check === 'policy')).toBe(true);
  });

  it('never blocks on policy — a reviewer reads context, a regex cannot', () => {
    const r = evaluate({ ...base, intent: 'paid', body: 'Guaranteed results. A miracle cure. Before and after.' });
    expect(r.issues.filter((i) => i.check === 'policy').length).toBeGreaterThan(0);
    expect(r.issues.some((i) => i.check === 'policy' && i.severity === 'block')).toBe(false);
  });

  it('stays silent on organic — flagging it there trains people to ignore it', () => {
    const r = evaluate({ ...base, body: 'Guaranteed results in 30 days.' });
    expect(r.issues.some((i) => i.check === 'policy')).toBe(false);
  });
});

describe('linearity', () => {
  it('blocks when the brand gate failed, carrying its reason through', () => {
    const r = evaluate({
      ...base,
      linearity: { score: 2, pass: false, thesisSimilarity: 0.1, bannedUsed: ['synergy'], lexiconUsed: [], reasons: ['Uses a banned term: synergy.'] },
    });
    expect(r.pass).toBe(false);
    expect(r.issues.some((i) => i.check === 'linearity' && /synergy/.test(i.message))).toBe(true);
  });

  it('treats an unscored piece as neutral rather than failing it', () => {
    expect(evaluate({ ...base, linearity: null }).pass).toBe(true);
  });
});
