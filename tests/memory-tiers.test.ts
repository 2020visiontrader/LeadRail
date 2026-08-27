// The calibration rules ARE the memory system's judgement. If they are wrong,
// everything downstream is confidently wrong at scale — which is the specific
// risk of a marketing OS that acts autonomously: a bad fact about one contact
// costs one relationship, a bad inferred rule about "what works" steers every
// future campaign.
//
// These assert the two asymmetries the design depends on:
//   - a STATED thing is durable on first mention (CRM bar, not personal-assistant bar)
//   - an INFERRED thing is never durable, at any number of repetitions

import { describe, it, expect } from 'vitest';
import { tierFor, exclusionFor, TIER2_PROMOTION_THRESHOLD } from '@/lib/memory/tiers';
import type { CandidateFact } from '@/lib/memory/types';

const c = (fact: string, predicate = 'stated', object = ''): CandidateFact => ({
  subject: { type: 'contact', id: 'x' },
  predicate, object, fact,
});

describe('Tier 1 — durable on a single mention', () => {
  it.each([
    ['has_role', 'Jane is VP Marketing at Acme.'],
    ['has_budget', 'Budget for the renewal is $65k.'],
    ['has_requirement', 'They need a Salesforce integration before they can proceed.'],
    ['raised_objection', 'Said the price is too expensive for their current stage.'],
    ['committed_to', 'Agreed to a pilot starting in October.'],
    ['brand_voice_rule', 'Never use exclamation points in outbound copy.'],
    ['achieved_metric', 'The Q3 campaign hit a 34% open rate.'],
  ])('predicate %s is tier 1', (predicate, fact) => {
    expect(tierFor(c(fact, predicate)).tier).toBe(1);
  });

  it('recognises a stated fact even when the predicate is loose', () => {
    // An extractor that returns a sloppy predicate must not silently demote a
    // commitment to an observation.
    expect(tierFor(c('They signed the order form this morning.', 'stated')).tier).toBe(1);
    expect(tierFor(c('Budget is $40k for this quarter.', 'stated')).tier).toBe(1);
  });

  it('promotes a soft preference when framed as always/never', () => {
    // "Prefers email" is an observation; "always email me, never call" is a
    // stated standing instruction.
    expect(tierFor(c('Prefers email.', 'prefers_channel')).tier).toBe(2);
    expect(tierFor(c('Always email me — never call.', 'prefers_channel')).tier).toBe(1);
  });
});

describe('Tier 2 — needs recurrence before it means anything', () => {
  it.each([
    ['prefers_channel', 'Seems to reply faster to email than to calls.'],
    ['sentiment', 'Tone has been warmer in the last few exchanges.'],
    ['observed_pattern', 'Subject lines under 40 characters did better this time.'],
  ])('predicate %s is tier 2', (predicate, fact) => {
    expect(tierFor(c(fact, predicate)).tier).toBe(2);
  });

  it('defaults an UNRECOGNISED fact to tier 2, not tier 1', () => {
    // The asymmetry that matters: an unknown fact is an observation until
    // something says otherwise. A wrongly-tier-1 fact gets acted on; a
    // wrongly-tier-2 one only gets mentioned.
    const v = tierFor(c('Something the extractor could not classify.', 'mystery'));
    expect(v.tier).toBe(2);
    expect(v.rule).toBe('tier2-default-unrecognised');
  });

  it('names the rule that decided, so a threshold can be tuned against real data', () => {
    expect(tierFor(c('x', 'has_budget')).rule).toBe('tier1-predicate:has_budget');
  });

  it('has a promotion threshold above 1 — one observation is not a pattern', () => {
    expect(TIER2_PROMOTION_THRESHOLD).toBeGreaterThan(1);
  });
});

describe('Never written — inference exclusions', () => {
  it("refuses the rep's read on a contact's psychology", () => {
    expect(exclusionFor(c('Jane seems hesitant about committing.'))).toBe('psychological-inference');
    expect(exclusionFor(c('Probably just tire-kicking at this point.'))).toBe('buyer-judgement');
  });

  it('refuses a conclusion drawn from a fact that was not itself stated', () => {
    // "mentioned tight budget" is fine; "so they're not worth pursuing" is not.
    expect(exclusionFor(c('Mentioned a tight budget, so not worth pursuing this quarter.')))
      .toBe('derived-conclusion');
  });

  it('refuses a causal narrative the system invented about a campaign', () => {
    // THE compounding failure mode: an inferred cause becomes a premise for
    // every future decision.
    expect(exclusionFor(c('The campaign underperformed because the audience is fatigued.')))
      .toBe('invented-causation');
  });

  it('still allows the measured outcome the narrative was attached to', () => {
    expect(exclusionFor(c('The Q3 campaign returned a 12% reply rate.'))).toBeNull();
  });
});

describe('Never written — compliance exclusions', () => {
  it.each([
    ['financial-account', 'Their account number is 4021 8899 1234.'],
    ['government-id', 'Passport details were shared on the call.'],
    ['health', 'Mentioned they are on medication for it.'],
    ['protected-attribute', 'Noted their religious observance affects scheduling.'],
    ['credential', 'The api_key for their portal is in the thread.'],
  ])('refuses %s', (rule, fact) => {
    expect(exclusionFor(c(fact))).toBe(rule);
  });

  it('checks the object slot too, not just the prose', () => {
    // A compliant-looking sentence can still carry an excluded value.
    expect(exclusionFor(c('Recorded their reference.', 'has_reference', 'SSN 123-45-6789'))).toBeTruthy();
  });

  it('does not refuse an ordinary business fact', () => {
    expect(exclusionFor(c('Renewal is due in Q4 and the budget is approved.'))).toBeNull();
  });
});
