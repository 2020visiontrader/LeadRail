// tests/model-output-parsing.test.ts
//
// analyzeBrand and judgeVoice both ask a model for JSON and then parse it. That
// parse is the part that breaks, and it had no coverage: the capabilities were
// written, shipped, and never once exercised against a model's reply.
//
// The ladder spans five providers that do NOT agree on how to return JSON —
// some fence it, some prepend a sentence, some do both. A capability that only
// handles the clean case works until the tier fails over, and then silently
// degrades on the tier that was supposed to save it.
//
// These feed the shapes real providers actually emit. No network, no model —
// the model's job is to produce text, and this tests what we do with the text.

import { describe, it, expect, vi } from 'vitest';

const reply = { text: '' };
vi.mock('@/lib/ai/router', () => ({ generateChat: async () => reply.text }));
vi.mock('@/lib/ai/venture-context', () => ({ loadVentureContext: async () => ({ name: 'Northwind', description: 'Production ops for indie film' }) }));
vi.mock('@/lib/ai/marketing', () => ({ marketingGuidance: () => 'guidance', violatesWhiteLabel: () => [] }));
vi.mock('@/lib/db', () => {
  const BRAND = { id: 'brand_1', name: 'Northwind', account_id: 'acct_1', tone: 'plain' };
  return {
    supabase: { from: () => ({ insert: async () => ({ error: null }), select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) }) }) }) },
    getVenture: async () => BRAND,
    getVentures: async () => [BRAND],
  };
});

const { STRATEGY_CAPABILITIES } = await import('@/lib/capabilities/strategy');
const { QUALITY_CAPABILITIES } = await import('@/lib/capabilities/quality');
const analyzeBrand = STRATEGY_CAPABILITIES.find((c) => c.name === 'analyzeBrand')!;
const judgeVoice = QUALITY_CAPABILITIES.find((c) => c.name === 'judgeVoice')!;

const STRATEGY = {
  positioning: 'For indie producers who lose weeks to admin, Northwind keeps schedule and budget in one place.',
  audience: { primary: 'Line producers', secondary: 'Coordinators', buyingTrigger: 'Greenlight' },
  messagingAngles: ['A', 'B', 'C'],
  channels: [{ channel: 'Newsletters', why: 'They read them', firstMove: 'Sponsor one issue' }],
  campaignIdeas: [{ name: 'Teardown', goal: 'Show expertise', format: 'Video', successLooksLike: '20 demos' }],
  risks: ['Seasonal buyers'],
  unknowns: ['UNKNOWN-CANARY: which territory matters most?'],
};
const REVIEW = {
  verdict: 'weak',
  issues: [{ severity: 'high', quote: 'we are thrilled to announce', problem: 'AI tell', fix: 'Cut it' }],
  weakestSentence: 'we are thrilled to announce',
  rewrite: 'Northwind ships call sheets in a day.',
};

/** The four shapes the ladder's providers actually return. */
const SHAPES: [string, (o: unknown) => string][] = [
  ['bare JSON', (o) => JSON.stringify(o)],
  ['fenced with a language tag', (o) => '```json\n' + JSON.stringify(o) + '\n```'],
  ['fenced with no tag', (o) => '```\n' + JSON.stringify(o) + '\n```'],
  ['prose before and after', (o) => `Sure — here is the analysis you asked for:\n\n${JSON.stringify(o)}\n\nLet me know if you want it adjusted.`],
];

describe('analyzeBrand survives every envelope the ladder can hand it', () => {
  it.each(SHAPES)('%s', async (_label, wrap) => {
    reply.text = wrap(STRATEGY);
    const r: any = await analyzeBrand.run('acct_1', {});
    expect(typeof r.strategy).toBe('object');
    expect(r.strategy.positioning).toContain('indie producers');
    // The open questions are what truncation ate before; they must survive the
    // parse as well as the budget.
    expect(JSON.stringify(r.strategy.unknowns)).toContain('UNKNOWN-CANARY');
  });

  it('hands back readable prose rather than failing the turn on unparseable output', async () => {
    reply.text = 'I could not produce structured output, but here is the gist: lead with the scheduling pain.';
    const r: any = await analyzeBrand.run('acct_1', {});
    expect(r.strategy).toContain('scheduling pain');
  });

  it('an empty reply does not become a fabricated strategy', async () => {
    reply.text = '';
    const r: any = await analyzeBrand.run('acct_1', {});
    expect(r.strategy).toBe('');
    expect(analyzeBrand.digest!({}, r)).toBe('Drafted a marketing strategy.');
  });
});

describe('judgeVoice survives the same envelopes', () => {
  it.each(SHAPES)('%s', async (_label, wrap) => {
    reply.text = wrap(REVIEW);
    const r: any = await judgeVoice.run('acct_1', { text: 'We are thrilled to announce our platform.' });
    expect(r.verdict).toBe('weak');
    expect(r.issues[0].quote).toContain('thrilled');
    expect(judgeVoice.digest!({}, r)).toContain('1 issue');
  });

  it('falls back to prose instead of throwing', async () => {
    reply.text = 'The copy is fine. Nothing to flag.';
    const r: any = await judgeVoice.run('acct_1', { text: 'Some copy.' });
    expect(r.review).toContain('Nothing to flag');
    expect(judgeVoice.digest!({}, r)).toBe('Reviewed the copy.');
  });
});

describe('the observation budget holds for a realistically large strategy', () => {
  it('a rich strategy still fits, with the open questions intact', () => {
    // The bug was truncation at 2000 eating the tail — and `unknowns` is the
    // tail. This is the upper end of what a model actually returns: 5 angles,
    // 5 channels, 4 campaigns, prose-length fields.
    const big = {
      positioning: 'For independent producers who lose entire weeks to fragmented production admin, Northwind is a production operations platform that keeps schedule, budget and crew in one place, unlike general project tools that know nothing about call sheets or union rates.',
      audience: {
        primary: 'Independent and line producers running £250k–£3m features across the UK and Ireland',
        secondary: 'Production coordinators at boutique studios who inherit the spreadsheet',
        buyingTrigger: 'Greenlight — the moment a project moves from development into prep and the admin load spikes overnight.',
      },
      messagingAngles: Array.from({ length: 5 }, (_, i) => `Angle ${i + 1}: a specific, defensible claim about where the week actually goes, written so a competitor could not paste it onto their own site.`),
      channels: Array.from({ length: 5 }, (_, i) => ({
        channel: `Channel ${i + 1}`,
        why: 'The buyers already gather here and ask each other for help with exactly this problem.',
        firstMove: 'One concrete first action, small enough to run inside a week without a budget approval.',
      })),
      campaignIdeas: Array.from({ length: 4 }, (_, i) => ({
        name: `Campaign ${i + 1}`, goal: 'A stated commercial goal', format: 'A named format',
        successLooksLike: 'A number or a decision by a date, never a vibe.',
      })),
      risks: ['Buyers are seasonal and the prep window is short.', 'Rate data must be accurate or trust collapses immediately.'],
      unknowns: ['UNKNOWN-CANARY: what budget band are current users in?', 'Which territory matters most next year?', 'Any reference customers who would go on record?'],
    };
    const result = { brand: 'Northwind', strategy: big, saved: true };
    const body = `${analyzeBrand.digest!({}, result)}\n${JSON.stringify(result)}`;

    expect(body.length).toBeGreaterThan(2000);            // would have been cut before
    expect(body.length).toBeLessThanOrEqual(analyzeBrand.observationLimit!);
    expect(body.slice(0, analyzeBrand.observationLimit!)).toContain('UNKNOWN-CANARY');
  });
});
