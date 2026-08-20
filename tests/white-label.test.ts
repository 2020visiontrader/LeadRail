// tests/white-label.test.ts — the rule that keeps the stack invisible.
//
// The product promise is that an operator's client never learns what LeadRail
// runs on. Reading "we use Apollo and Claude to research every prospect" tells
// them exactly what they are paying a markup for, and it is the one leak the
// operator cannot take back.
//
// The check had this exactly backwards. Its list held only cross-posting
// competitors — not one vendor from the actual stack — and matched with
// `includes()`, so every real leak passed while ordinary English failed:
// "circle back later" and "a buffer against seasonal dips" both tripped it, and
// the stripper then deleted the word mid-sentence, leaving "a against seasonal
// dips" in copy that had already been generated. "laterally" was flagged by the
// checker but not removable by the stripper, because the two functions did not
// agree on what a match was.
//
// The cases below are split into LEAKS and CLEAN because the two failure modes
// have opposite costs. A missed leak breaks the product promise once and
// permanently. A false flag on ordinary English is what teaches an operator to
// stop trusting the gate — after which every leak gets through.

import { describe, it, expect } from 'vitest';
import { violatesWhiteLabel, whiteLabelGuard } from '@/lib/ai/marketing';
// Top level, not inside the test: pulling the registry in mid-test spends the
// whole per-test timeout on module resolution.
import { CAPABILITY_BY_NAME } from '@/lib/capabilities/registry';

const LEAKS: [string, string][] = [
  ['the lead vendor',        'Our team uses Apollo to research every prospect.'],
  ['the model vendor',       'Drafted with Claude in about a minute.'],
  ['the model vendor by co', 'We enrich leads through Anthropic before sending.'],
  ['a routing vendor',       'Requests are routed via OpenRouter.'],
  ['the database',           'Everything is stored in Supabase.'],
  ['a search vendor',        'Company research is powered by Tavily.'],
  ['a scheduling rival',     'We schedule everything through Buffer.'],
  ['another scheduler',      'Posts go out via Hootsuite each morning.'],
  ['internal mechanics',     'Cross-post to the other accounts afterwards.'],
];

// Ordinary marketing English that happens to contain a product name as a word.
const CLEAN: [string, string][] = [
  ['"later" as an adverb',      "Let's circle back later this week."],
  ['"buffer" as a noun',        'This gives you a buffer against seasonal dips.'],
  ['"later" inside a word',     'It is a laterally integrated approach.'],
  ['"Later" starting a clause', 'Later, we will follow up with the shortlist.'],
  ['"sprout" as a noun',        'The sprout of an idea became the campaign.'],
  ['a good cold email',         'Sarah — saw Northwind shipped the Berlin campaign in nine days.'],
];

describe('a leak is caught', () => {
  it.each(LEAKS)('%s: %s', (_label, text) => {
    expect(violatesWhiteLabel(text).length).toBeGreaterThan(0);
  });
});

describe('ordinary English is left alone', () => {
  it.each(CLEAN)('%s: %s', (_label, text) => {
    expect(violatesWhiteLabel(text)).toEqual([]);
  });

  it.each(CLEAN)('%s: and is returned verbatim by the stripper', (_label, text) => {
    expect(whiteLabelGuard(text)).toBe(text);
  });
});

describe('the checker and the stripper agree', () => {
  it.each([...LEAKS, ...CLEAN])('%s: nothing flagged survives stripping', (_label, text) => {
    // The bug this prevents: the checker flagged "laterally" that the stripper
    // could not remove, so the copy FAILED the gate with no way to pass it.
    // Anything reported must be removable, or the verdict is a dead end.
    expect(violatesWhiteLabel(whiteLabelGuard(text))).toEqual([]);
  });
});

describe('stripping leaves readable copy, not wreckage', () => {
  it('substitutes a vendor name rather than deleting it', () => {
    expect(whiteLabelGuard('Our team uses Apollo to research every prospect.'))
      .toBe('Our team uses our platform to research every prospect.');
  });

  it('handles several vendors in one sentence', () => {
    expect(whiteLabelGuard('We enrich leads through Anthropic and OpenRouter before sending.'))
      .toBe('We enrich leads through our platform and our platform before sending.');
  });

  it('never leaves a doubled space or a space before punctuation', () => {
    for (const [, text] of LEAKS) {
      const out = whiteLabelGuard(text);
      expect(out).not.toMatch(/\s{2,}/);
      expect(out).not.toMatch(/\s[.,!?;:]/);
    }
  });
});

describe('the quality gate fails copy that names the stack', () => {
  it('reviewContent returns FAIL naming the white-label rule', async () => {
    const rc: any = (CAPABILITY_BY_NAME as any)['reviewContent'];
    const res = await rc.run('acct', {
      text: 'Our team uses Apollo and Claude to research every prospect.',
      kind: 'social',
    });
    // The stripper is the belt; this is the braces. A draft naming the stack
    // must be rejected and rewritten, not silently patched and shipped.
    expect(res.verdict).toBe('FAIL');
    expect(res.failedRules).toContain('white-label');
  });
});
