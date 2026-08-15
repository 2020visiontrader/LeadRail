// A/B analysis for Meta campaigns. Reads LIVE per-ad insights (no persistence)
// and produces a ranked comparison + a plain-language "what to iterate next"
// recommendation from the AI ladder. This is the read-only intelligence layer
// the operator uses to decide which creative to scale and which to cut.

import { supabase, assertBrandOwned } from '@/lib/db';
import { getInsightsByLevel, getInsights, type AdLevelInsights } from '@/lib/social/meta-ads';
import { generateText, textConfigured } from '@/lib/ai/router';

export class AbGuardError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

export interface AbReport {
  campaignId: string;
  campaignName: string;
  level: 'ad' | 'adset';
  variants: AdLevelInsights[];
  winner: AdLevelInsights | null;
  totals: { spend: number; impressions: number; clicks: number; conversions: number; ctr: number };
  recommendation: string;
  hasData: boolean;
}

async function ownedCampaign(id: string, accountId: string) {
  const { data } = await supabase.from('ad_campaigns').select('*').eq('id', id).single();
  if (!data || !(await assertBrandOwned(data.brand_id, accountId))) {
    throw new AbGuardError('Campaign not found', 404);
  }
  return data;
}

// Winner heuristic: with real conversions, best cost-per-conversion wins.
// Otherwise fall back to highest CTR among ads that actually got impressions.
function pickWinner(variants: AdLevelInsights[]): AdLevelInsights | null {
  const withImpr = variants.filter((v) => v.impressions > 0);
  if (withImpr.length === 0) return null;
  const withConv = withImpr.filter((v) => v.conversions > 0);
  if (withConv.length > 0) {
    return withConv.reduce((best, v) =>
      (v.spend / v.conversions) < (best.spend / best.conversions) ? v : best);
  }
  return withImpr.reduce((best, v) => (v.ctr > best.ctr ? v : best));
}

async function aiRecommendation(campaignName: string, variants: AdLevelInsights[], winner: AdLevelInsights | null): Promise<string> {
  if (!textConfigured()) {
    if (!winner) return 'No delivery yet — once these ads spend, the highest-performing creative will surface here so you can scale it and cut the rest.';
    return `"${winner.name}" is leading on ${winner.conversions > 0 ? 'cost per result' : 'click-through rate'}. Shift more budget to it and refresh or pause the weaker variants.`;
  }
  const table = variants.map((v) =>
    `- ${v.name}: spend $${v.spend.toFixed(2)}, ${v.impressions} impressions, CTR ${v.ctr.toFixed(2)}%, CPC $${v.cpc.toFixed(2)}, ${v.conversions} results`
  ).join('\n');
  const prompt = [
    `Campaign: "${campaignName}". Here is live A/B performance across its creatives:`,
    table,
    winner ? `Current leader: "${winner.name}".` : 'No clear leader yet.',
    '',
    'In 2-3 short sentences, plain language for a marketer, say which creative to scale, which to pause or refresh, and one concrete next test to run. No jargon, no vendor names, no markdown.',
  ].join('\n');
  try {
    const out = await generateText({ prompt, temperature: 0.3, maxOutputTokens: 220 });
    return out.trim() || 'Scale the leading creative and refresh the weaker ones with a new hook.';
  } catch {
    return 'Scale the leading creative, pause the weakest, and test a new hook or opening image on the next round.';
  }
}

/** Build the live A/B report for a campaign the caller owns. */
export async function getCampaignAbReport(accountId: string, campaignId: string): Promise<AbReport> {
  const c = await ownedCampaign(campaignId, accountId);
  if (!c.meta_campaign_id) {
    throw new AbGuardError('This campaign is not linked to a live ad account yet — create it on the Meta channel with an ad account, then launch to compare creatives.', 400);
  }

  let variants: AdLevelInsights[] = [];
  try {
    variants = await getInsightsByLevel(accountId, c.meta_campaign_id, 'ad');
  } catch {
    variants = [];
  }

  // Fallback: no per-ad rows yet → show the campaign-level line as a single row
  // so the view is never empty once a campaign exists.
  if (variants.length === 0) {
    try {
      const camp = await getInsights(accountId, c.meta_campaign_id);
      if (camp.impressions > 0 || camp.spend > 0) {
        variants = [{ objectId: c.meta_campaign_id, name: `${c.name} (campaign total)`, ...camp, reach: 0, conversions: 0 }];
      }
    } catch { /* leave empty */ }
  }

  const winner = pickWinner(variants);
  const totals = variants.reduce(
    (t, v) => ({
      spend: t.spend + v.spend, impressions: t.impressions + v.impressions,
      clicks: t.clicks + v.clicks, conversions: t.conversions + v.conversions, ctr: 0,
    }),
    { spend: 0, impressions: 0, clicks: 0, conversions: 0, ctr: 0 },
  );
  totals.ctr = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0;

  const recommendation = await aiRecommendation(c.name, variants, winner);

  return {
    campaignId,
    campaignName: c.name,
    level: 'ad',
    variants: variants.sort((a, b) => b.ctr - a.ctr),
    winner,
    totals,
    recommendation,
    hasData: variants.length > 0,
  };
}
