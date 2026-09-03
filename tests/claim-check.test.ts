// PURE unit tests for lib/agent/claim-check.ts — no mocks, no DB, called
// directly, for the same reason tests/agent-json-extract.test.ts exists: a
// test that has to stand up the loop to reach a string function is a test
// nobody writes.
//
// PRODUCTION INCIDENT, 2026-09-02 14:28 UTC (the primary fixture here): a
// turn whose ledger held only `draftOutreach` produced "The last batch
// already went out to all 13 marketing and e-commerce agency contacts."
// Nothing had gone out. That exact sentence is the first case below.

import { describe, it, expect } from 'vitest';
import { checkClaims } from '@/lib/agent/claim-check';

describe('checkClaims — the production incident', () => {
  it('downgrades "already went out" when only draftOutreach ran this turn', () => {
    const draft =
      "The last batch already went out to all 13 marketing and e-commerce agency contacts.";
    const out = checkClaims(draft, ['draftOutreach']);

    expect(out.corrected).toBe(true);
    expect(out.message).not.toMatch(/already went out/i);
    expect(out.message).not.toContain('13 marketing');
    // The correction is honest about the actual state, not silent.
    expect(out.message.toLowerCase()).toMatch(/draft|not.*sent|hasn't/i);
  });

  it('downgrades even with zero executed tools at all', () => {
    const draft = "Your emails were sent to the whole list.";
    const out = checkClaims(draft, []);
    expect(out.corrected).toBe(true);
    expect(out.message).not.toMatch(/were sent/i);
  });
});

describe('checkClaims — a real executed tool backs the claim', () => {
  it('passes an unchanged claim through when a matching tool actually ran', () => {
    const draft = "Your emails have been sent to all 13 contacts.";
    const out = checkClaims(draft, ['sendEmail']);
    expect(out.corrected).toBe(false);
    expect(out.message).toBe(draft);
  });

  it('matches by category keyword, not exact tool name', () => {
    const draft = "The campaign has been published.";
    const out = checkClaims(draft, ['publishCampaignPost']);
    expect(out.corrected).toBe(false);
    expect(out.message).toBe(draft);
  });
});

describe('checkClaims — a proposed-but-unapproved sensitive tool is NOT run', () => {
  it('still flags the claim when the only "ledger" entry is a proposal, not an execution', () => {
    // The caller is expected to build `executedTools` from a counter that only
    // increments on real execution — a [needs approval] card never reaches it.
    // Simulate exactly that: the tool was proposed this turn, so it is absent
    // from executedTools even though the model "knows" its name.
    const draft = "I've sent the outreach batch to everyone on the list.";
    const out = checkClaims(draft, []); // sendEmail proposed, never executed
    expect(out.corrected).toBe(true);
  });
});

describe('checkClaims — future and intent phrasing is left alone', () => {
  it('does not touch "I\'ll send these once you confirm"', () => {
    const draft = "I've drafted the outreach. I'll send these once you confirm.";
    const out = checkClaims(draft, []);
    expect(out.corrected).toBe(false);
    expect(out.message).toBe(draft);
  });

  it('does not touch "I can publish this when you say go"', () => {
    const draft = "The post is ready. I can publish this when you say go.";
    const out = checkClaims(draft, []);
    expect(out.corrected).toBe(false);
    expect(out.message).toBe(draft);
  });

  it('does not touch a plan to schedule something later', () => {
    const draft = "I plan to schedule these for tomorrow morning.";
    const out = checkClaims(draft, []);
    expect(out.corrected).toBe(false);
    expect(out.message).toBe(draft);
  });
});

describe('checkClaims — negated or already-honest claims are left alone', () => {
  it('does not touch "hasn\'t been sent yet"', () => {
    const draft = "The batch hasn't been sent yet — still waiting on your go-ahead.";
    const out = checkClaims(draft, []);
    expect(out.corrected).toBe(false);
    expect(out.message).toBe(draft);
  });

  it('does not touch "was not sent"', () => {
    const draft = "That email was not sent because the address bounced.";
    const out = checkClaims(draft, []);
    expect(out.corrected).toBe(false);
    expect(out.message).toBe(draft);
  });
});

describe('checkClaims — one bad sentence does not cost the good ones', () => {
  it('keeps unrelated, honest sentences intact and only rewrites the fabricated one', () => {
    const draft = [
      "I've drafted 13 outreach emails for the marketing and e-commerce contacts.",
      "They already went out to everyone on the list.",
      "Let me know if you'd like me to tweak the tone on any of them.",
    ].join(' ');
    const out = checkClaims(draft, ['draftOutreach']);

    expect(out.corrected).toBe(true);
    expect(out.message).toContain("I've drafted 13 outreach emails for the marketing and e-commerce contacts.");
    expect(out.message).toContain("Let me know if you'd like me to tweak the tone on any of them.");
    expect(out.message).not.toMatch(/already went out/i);
  });
});

describe('checkClaims — quoting the user\'s own words is untouched by design', () => {
  it('does not rewrite text describing what the user said (known accepted gap)', () => {
    // Documented limitation: the module works on surface pattern, so a
    // quote of the user's own (false) claim reads the same as an assertion.
    // This case exists to pin the behavior, not to claim it is fixed.
    const draft = 'You said the batch already went out — happy to look into that.';
    const out = checkClaims(draft, []);
    expect(out.corrected).toBe(true); // documented gap, not a silent regression
  });
});

describe('checkClaims — narrow category coverage', () => {
  it('does not flag action categories outside the tracked list', () => {
    const draft = "I updated the lead's status to qualified.";
    const out = checkClaims(draft, []);
    expect(out.corrected).toBe(false);
    expect(out.message).toBe(draft);
  });

  it('flags an unsupported enroll claim', () => {
    const draft = "All 20 leads have been enrolled in the nurture sequence.";
    const out = checkClaims(draft, ['listLeads']);
    expect(out.corrected).toBe(true);
    expect(out.message).not.toMatch(/have been enrolled/i);
  });

  it('flags an unsupported spend claim', () => {
    const draft = "We already spent $500 on the campaign.";
    const out = checkClaims(draft, []);
    expect(out.corrected).toBe(true);
    expect(out.message).not.toMatch(/already spent/i);
  });

  it('passes a supported schedule claim through unchanged', () => {
    const draft = "The call has been scheduled for Tuesday at 3pm.";
    const out = checkClaims(draft, ['scheduleMeeting']);
    expect(out.corrected).toBe(false);
    expect(out.message).toBe(draft);
  });
});

describe('checkClaims — empty input', () => {
  it('returns the empty draft untouched', () => {
    const out = checkClaims('', ['draftOutreach']);
    expect(out.corrected).toBe(false);
    expect(out.message).toBe('');
    expect(out.flags).toEqual([]);
  });
});
