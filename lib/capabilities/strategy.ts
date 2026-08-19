import { z } from 'zod';
import { getVenture, getVentures } from '@/lib/db';
import { generateChat } from '@/lib/ai/router';
import { loadVentureContext } from '@/lib/ai/venture-context';
import { marketingGuidance } from '@/lib/ai/marketing';
import { obj, S, type Capability } from './types';

// Brand strategy — the "plug in a brand and get a marketing plan" capability.
//
// Everything it needs already existed and was never joined up: loadVentureContext
// carries name, deck summary, pitch, lead goal, sectors and the ICP profile;
// marketingGuidance carries the copy frameworks and hook patterns; the router
// carries the model ladder. What was missing was a capability that reads the
// brand and produces a PLAN rather than an asset. Every other creative capability
// makes one artefact (a post, an email); this one decides what artefacts are
// worth making.

/** Fields the model must fill. Named here rather than buried in the prompt so
 *  the shape is reviewable and the parser below can be strict about it. */
const STRATEGY_SHAPE = `{
  "positioning": "one sentence: for [audience] who [need], [brand] is a [category] that [benefit], unlike [alternative]",
  "audience": { "primary": "...", "secondary": "...", "buyingTrigger": "what makes them act now" },
  "messagingAngles": ["3-5 distinct angles, each a claim you could defend"],
  "channels": [{ "channel": "...", "why": "...", "firstMove": "the single first thing to do there" }],
  "campaignIdeas": [{ "name": "...", "goal": "...", "format": "...", "successLooksLike": "a number or a decision, not a vibe" }],
  "risks": ["what could make this fail"],
  "unknowns": ["what you would need to ASK the operator to sharpen this"]
}`;

function buildPrompt(ctx: any, brandName: string, goal?: string): string {
  const known: string[] = [];
  if (ctx?.description) known.push(`What it does: ${ctx.description}`);
  if (ctx?.pitch) known.push(`Pitch: ${ctx.pitch}`);
  if (ctx?.leadGoal) known.push(`Lead goal: ${ctx.leadGoal}`);
  if (ctx?.sectors?.length) known.push(`Sectors: ${ctx.sectors.join(', ')}`);
  if (ctx?.icp) {
    const icp = ctx.icp;
    const bits = [
      icp.industry && `industry ${icp.industry}`,
      icp.titles?.length && `titles ${icp.titles.join('/')}`,
      icp.seniority?.length && `seniority ${icp.seniority.join('/')}`,
      icp.company_size && `size ${icp.company_size}`,
    ].filter(Boolean);
    if (bits.length) known.push(`ICP: ${bits.join('; ')}`);
  }

  return [
    `BRAND: ${brandName}`,
    known.length ? known.join('\n') : 'No stored profile yet — the brand record is close to empty.',
    goal ? `\nOPERATOR'S STATED GOAL: ${goal}` : '',
    '',
    // The honesty constraint is the load-bearing part. A strategy that invents
    // an audience is worse than one that admits it does not know — the operator
    // cannot tell the difference until it has already cost them a campaign.
    'Write a marketing strategy for this brand. Ground every claim in the facts above.',
    'Where a fact is missing, do NOT invent it: put the question in "unknowns" instead.',
    'If the profile is too thin to position the brand at all, say so in "positioning" and make "unknowns" the substance of your answer.',
    '',
    `Respond with ONLY this JSON shape:\n${STRATEGY_SHAPE}`,
  ].filter(Boolean).join('\n');
}

export const STRATEGY_CAPABILITIES: Capability[] = [
  {
    name: 'analyzeBrand',
    domain: 'strategy',
    title: 'Build a marketing strategy',
    description:
      'Analyse a brand and produce a marketing strategy: positioning, audience, messaging angles, channels with a first move each, campaign ideas with success criteria, risks, and the questions worth asking to sharpen it. Reads the stored brand profile (deck summary, pitch, lead goal, sectors, ICP). Use when the user asks how to market or position a brand, or what campaigns to run.',
    gate: 'read',
    inputSchema: obj({ brandId: S.string, goal: S.string }, []),
    zod: z.object({ brandId: z.string().optional(), goal: z.string().optional() }),
    run: async (accountId, a) => {
      // Default to the account's first brand so "build me a strategy" works
      // without the user having to resolve an id first.
      const v: any = a.brandId ? await getVenture(a.brandId) : (await getVentures(accountId))[0];
      if (!v) return { error: 'No brand found. Create one first, then ask again.' };
      if (v.account_id && v.account_id !== accountId) return { error: 'Brand not found' };

      const ctx = await loadVentureContext(v.id, accountId);
      const raw = await generateChat({
        system: [
          'You are a marketing strategist. You produce plans a competent operator could execute on Monday.',
          'Concrete over clever. No filler, no hype adjectives, no invented statistics.',
          marketingGuidance(),
        ].join('\n\n'),
        messages: [{ role: 'user', content: buildPrompt(ctx, v.name || 'this brand', a.goal) }],
        temperature: 0.4,
        maxOutputTokens: 1400,
      });

      // Tolerate a fenced or prose-wrapped envelope: the ladder spans several
      // providers and they do not agree on whether to wrap JSON.
      const cleaned = String(raw).replace(/```json|```/g, '').trim();
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start === -1 || end <= start) return { strategy: cleaned };
      try {
        return { brand: v.name, strategy: JSON.parse(cleaned.slice(start, end + 1)) };
      } catch {
        // Unparseable JSON is still a readable strategy — hand back the prose
        // rather than failing the turn over formatting.
        return { brand: v.name, strategy: cleaned };
      }
    },
    digest: (_a, result: any) => {
      const s = result?.strategy;
      if (!s || typeof s === 'string') return 'Drafted a marketing strategy.';
      const angles = Array.isArray(s.messagingAngles) ? s.messagingAngles.length : 0;
      const channels = Array.isArray(s.channels) ? s.channels.map((c: any) => c?.channel).filter(Boolean) : [];
      const unknowns = Array.isArray(s.unknowns) ? s.unknowns.length : 0;
      return [
        `Strategy for ${result?.brand || 'the brand'}.`,
        channels.length ? `Channels: ${channels.slice(0, 4).join(', ')}.` : null,
        angles ? `${angles} messaging angles.` : null,
        unknowns ? `${unknowns} open questions to sharpen it.` : null,
      ].filter(Boolean).join(' ');
    },
  },
];
