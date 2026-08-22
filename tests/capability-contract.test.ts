// tests/capability-contract.test.ts — the contracts types.ts DECLARES, enforced.
//
// lib/capabilities/types.ts writes down real obligations in prose: a digest is
// "truthful only … never default a missing field to zero"; a standing_rule's
// summarize "MUST state the ongoing nature and the cap"; a digest must "never
// emit a secret". None of it was checked, and all 108 capabilities were free to
// drift from it.
//
// These two obligations are not stylistic. Both feed text directly into places
// where it is trusted as fact:
//
//   digest    -> placed first in the OBSERVATION line, ahead of the raw JSON,
//                and read by the compose pass as ground truth. A digest that
//                invents a number launders a fabrication into the model's
//                reasoning, and the user never sees the JSON that would have
//                contradicted it.
//   summarize -> rendered on the approval card. It is the ONE moment a human can
//                stop a spend or a send. Falling back to raw JSON there asks the
//                reviewer to audit a payload instead of read a decision — they
//                skim and click approve, which is worse than having no gate,
//                because it looks like oversight.
//
// Static assertions only: no DB, no network, no model. Every capability in the
// registry is covered, so a new one cannot be added outside these rules.

import { describe, it, expect } from 'vitest';
import { CAPABILITIES } from '@/lib/capabilities/registry';
import { isSensitive, type Capability } from '@/lib/capabilities/types';
import { OBSERVATION_BLOCK_CHARS } from '@/lib/agent/compose';
import { OBSERVATION_CHAR_LIMIT } from '@/lib/agent/loop';

const caps = CAPABILITIES as Capability[];
const sensitive = caps.filter(isSensitive);
const withDigest = caps.filter((c) => typeof c.digest === 'function');

describe('the registry is populated', () => {
  it('holds capabilities, and a meaningful number of them are gated', () => {
    expect(caps.length).toBeGreaterThan(90);
    expect(sensitive.length).toBeGreaterThan(10);
  });
});

describe('digest truthfulness — what reaches the model as fact', () => {
  it.each(withDigest.map((c) => [c.name, c] as const))(
    '%s: asserts no quantity when the result carries none',
    (_name, c) => {
      // An empty object contains no counts. Any digit in the output was invented
      // by the digest rather than read from the result — the exact failure that
      // had webSearch reporting "0 web results" whenever the provider returned
      // an unexpected shape, telling the user the web was empty on the subject
      // when in fact the search had broken.
      expect(c.digest!({}, {})).not.toMatch(/\d/);
    },
  );

  it.each(withDigest.map((c) => [c.name, c] as const))(
    '%s: says nothing at all about a null or undefined result',
    (_name, c) => {
      expect(c.digest!({}, null)).toBe('');
      expect(c.digest!({}, undefined)).toBe('');
    },
  );

  it.each(withDigest.map((c) => [c.name, c] as const))(
    '%s: returns a string and never throws, whatever shape arrives',
    (_name, c) => {
      // A digest runs on a REAL upstream result. Providers change shapes without
      // warning, and a throw here would fail a turn that had already succeeded.
      for (const shape of [null, undefined, {}, [], 0, '', 'text', { error: 'boom' }, [{}, {}]]) {
        expect(typeof c.digest!({}, shape)).toBe('string');
      }
    },
  );

  it.each(withDigest.map((c) => [c.name, c] as const))(
    '%s: never echoes a secret found on the result',
    (_name, c) => {
      // Digest lines reach the model verbatim and are persisted in the
      // transcript, so a credential echoed here outlives the request.
      const CANARY = 'sk-live-CANARY-must-not-appear';
      const poisoned: any = {
        token: CANARY, api_key: CANARY, password: CANARY, secret: CANARY, authorization: CANARY,
        results: [{ token: CANARY, name: 'row' }],
        rows: [{ api_key: CANARY }],
      };
      expect(c.digest!({ token: CANARY }, poisoned)).not.toContain(CANARY);
    },
  );
});

describe('approval cards — the one moment a human can say no', () => {
  it.each(sensitive.map((c) => [c.name, c] as const))(
    '%s: has a summarize, so the card is a decision and not a JSON payload',
    (_name, c) => {
      expect(typeof c.summarize).toBe('function');
    },
  );

  it.each(sensitive.map((c) => [c.name, c] as const))(
    '%s: summarize survives arguments it did not expect',
    (_name, c) => {
      // summarize renders the card BEFORE the tool runs. A throw here strands
      // the user on a proposal they can neither read nor approve.
      const out = c.summarize!({} as any);
      expect(typeof out).toBe('string');
      expect(out).not.toContain('[object Object]');
    },
  );

  it.each(sensitive.map((c) => [c.name, c] as const))(
    '%s: the card says something, not just a name',
    (_name, c) => {
      expect(c.summarize!({} as any).trim().length).toBeGreaterThan(20);
    },
  );

  it.each(
    caps.filter((c) => c.gate === 'standing_rule').map((c) => [c.name, c] as const),
  )(
    '%s: a standing rule discloses that it keeps acting on its own',
    (_name, c) => {
      // Approving one send authorises one action. Approving a standing rule
      // authorises an unbounded stream of them, and the card is the only place
      // that difference is ever communicated.
      expect(c.summarize!({} as any)).toMatch(
        /ongoing|repeat|continu|automatic|every|each time|until|on its own|standing|recurring/i,
      );
    },
  );
});

describe('observation budget — a deliverable must survive the transcript', () => {
  // THE BUG THIS PREVENTS: analyzeBrand produced a good strategy, PERSISTED it,
  // and the user never saw it. The observation carrying it was truncated at the
  // shared 2000-char cap, and truncation cuts from the END — so what vanished
  // was `unknowns`, the questions the capability exists to raise instead of
  // inventing facts. The strategy was in the database and the assistant
  // answered with a paraphrase of the brand description.
  //
  // The default cap is right for almost everything: the model needs enough of a
  // result to REASON over, not all of it. These few are different — their
  // result is not evidence, it is the answer.
  const DELIVERABLES = ['analyzeBrand', 'getBrandStrategy', 'judgeVoice'];

  it.each(DELIVERABLES)('%s declares a budget larger than the shared default', (name) => {
    const c = caps.find((x) => x.name === name);
    expect(c, `${name} is not in the registry`).toBeTruthy();
    expect(c!.observationLimit ?? 0).toBeGreaterThan(2000);
  });

  it('no capability asks for more than compose will actually carry', () => {
    // Asserted against the EXPORTED cap, never a restated literal. The bug this
    // guards is two limits in series disagreeing in silence — a test hardcoding
    // 6000 stops being true the moment compose changes, and stops protecting
    // anything at the moment it matters most.
    for (const c of caps) {
      if (c.observationLimit) expect(c.observationLimit).toBeLessThanOrEqual(OBSERVATION_BLOCK_CHARS);
    }
  });

  it('the caps in series are coherent — no link silently re-clips another', () => {
    // THE ACTUAL LESSON. analyzeBrand did not lose its strategy because any one
    // number was wrong; it lost it because two limits sat in series and only one
    // was considered. Raising a per-observation budget above the block the
    // compose pass receives does nothing except move where the loss happens.
    //
    // Asserted as a RELATIONSHIP, so raising either number alone fails here
    // rather than in production six weeks later.
    expect(OBSERVATION_CHAR_LIMIT).toBeLessThanOrEqual(OBSERVATION_BLOCK_CHARS);
    // And the block must hold more than a single maximal observation, or a
    // multi-tool turn drops its early findings before the answer is written.
    expect(OBSERVATION_BLOCK_CHARS).toBeGreaterThanOrEqual(OBSERVATION_CHAR_LIMIT * 2);
  });

  it('the default budget clears the smallest real deliverable', () => {
    // The old 2,000 failed at 2,352 — the SMALLEST realistic strategy. A default
    // that cannot carry the least demanding case is not a budget, it is a bug
    // that happens to be a constant.
    expect(OBSERVATION_CHAR_LIMIT).toBeGreaterThan(2500);
  });

  it('a realistic strategy fits its budget with the open questions intact', () => {
    const c = caps.find((x) => x.name === 'analyzeBrand')!;
    const strategy = {
      positioning: 'For independent producers who lose weeks to fragmented production admin, this is a platform that keeps schedule, budget and crew in one place, unlike general project tools.',
      audience: { primary: 'Independent and line producers', secondary: 'Production coordinators', buyingTrigger: 'Greenlight, when admin load spikes overnight.' },
      messagingAngles: Array.from({ length: 5 }, (_, i) => `Angle ${i + 1}: a claim specific enough that a competitor could not paste it onto their own site.`),
      channels: Array.from({ length: 4 }, (_, i) => ({ channel: `Channel ${i + 1}`, why: 'The buyers already gather here and ask each other for help.', firstMove: 'One concrete first action, small enough to run this week.' })),
      campaignIdeas: Array.from({ length: 3 }, (_, i) => ({ name: `Campaign ${i + 1}`, goal: 'A stated goal', format: 'A format', successLooksLike: 'A number or a decision, not a vibe.' })),
      risks: ['Buyers are seasonal and the window is short.', 'The underlying rate data must be accurate or trust collapses.'],
      unknowns: ['UNKNOWN-CANARY: what budget band are your current users in?', 'Which territory matters most over the next 12 months?', 'Any reference customers who would go on record?'],
    };
    const result = { brand: 'A Brand', strategy, saved: true };
    const body = `${c.digest!({}, result)}\n${JSON.stringify(result)}`;

    // It must not fit the OLD cap — otherwise this test proves nothing.
    expect(body.length).toBeGreaterThan(2000);
    expect(body.length).toBeLessThanOrEqual(c.observationLimit!);
    // And the part truncation ate first must be present in what survives.
    expect(body.slice(0, c.observationLimit!)).toContain('UNKNOWN-CANARY');
  });

  it('ordinary capabilities keep the shared default', () => {
    // The budget is an exception, not a habit. If most capabilities start
    // declaring one, the cap has stopped meaning anything.
    const raised = caps.filter((c) => c.observationLimit);
    expect(raised.length).toBeLessThan(caps.length * 0.1);
  });
});

describe('gate declarations', () => {
  it('every capability declares a known gate', () => {
    const KNOWN = ['read', 'internal_write', 'spend', 'external_send', 'destructive', 'standing_rule'];
    for (const c of caps) expect(KNOWN).toContain(c.gate);
  });

  it('anything that can spend money is gated for spend, by class or by argument', () => {
    // spendsMoney exists because "reaches a third party" and "costs money" are
    // different axes. Whichever way a capability commits spend, the budget check
    // in runTool must be reachable for it.
    for (const c of caps) {
      if (c.spendsMoney) expect(isSensitive(c)).toBe(true);
    }
  });
});
