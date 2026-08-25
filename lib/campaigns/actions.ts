import { supabase, assertBrandOwned } from '@/lib/db';
import { getCampaignAssets } from '@/lib/crm';
import { getMetaCreds } from '@/lib/integrations/meta';
import { assertWithinBudget } from '@/lib/budgets/store';
import {
  createCampaign, createAdSet, uploadAdImage, uploadAdVideo,
  createAdCreative, createAd, updateStatus, getInsights,
} from '@/lib/social/meta-ads';

// Single source of truth for the money-spending campaign lifecycle. Both the
// HTTP routes and the MCP tools call these — never two implementations of the
// launch path. Every function is account-scoped and throws on guard failure.

const APP_BASE_URL = process.env.APP_BASE_URL || 'https://app.leadrail.xyz';

export class GuardError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

/** Verify a campaign row belongs to the caller (ad_campaigns is brand-scoped). */
async function ownedCampaign(id: string, accountId: string) {
  const { data } = await supabase.from('ad_campaigns').select('*').eq('id', id).single();
  if (!data || !(await assertBrandOwned(data.brand_id, accountId))) {
    throw new GuardError('Campaign not found', 404);
  }
  return data;
}

/** Create a local campaign row; when channel is 'meta' + an ad account is given, also create a PAUSED Meta campaign. Never throws on a Meta outage — the local tracker still works. */
export async function createCampaignRecord(
  accountId: string,
  input: { brandId: string; name: string; channel?: string; budget?: number; objective?: string; metaAdAccountId?: string; startDate?: string; endDate?: string; status?: string },
) {
  if (!(await assertBrandOwned(input.brandId, accountId))) throw new GuardError('unknown brand_id', 400);
  const { data, error } = await supabase.from('ad_campaigns').insert([{
    brand_id: input.brandId,
    name: input.name,
    channel: input.channel ?? null,
    budget: Number(input.budget) || 0,
    start_date: input.startDate ?? null,
    end_date: input.endDate ?? null,
    status: input.status || 'draft',
  }]).select();
  if (error) throw error;
  let row = data[0];

  if (input.channel === 'meta' && input.metaAdAccountId) {
    try {
      const objective = input.objective || 'OUTCOME_TRAFFIC';
      const meta = await createCampaign(accountId, input.metaAdAccountId, { name: input.name, objective, status: 'PAUSED' });
      const { data: upd } = await supabase.from('ad_campaigns').update({
        meta_campaign_id: meta.id,
        meta_ad_account_id: input.metaAdAccountId,
        objective,
        meta_status: 'PAUSED',
      }).eq('id', row.id).select();
      if (upd && upd[0]) row = upd[0];
    } catch (e: any) {
      return { ...row, meta_error: e?.message || 'Meta campaign creation failed' };
    }
  }
  return row;
}

/** Activate a campaign: build ad set + creative + ad from the first asset, then set everything ACTIVE. The only money-spending action. */
export async function launchCampaign(
  accountId: string,
  campaignId: string,
  opts: { message?: string; link?: string; dailyBudget?: number } = {},
) {
  const c = await ownedCampaign(campaignId, accountId);

  // SPEND GATE (Packet 1.4). runTool() gates every capability, but this
  // function has a second entrance the capability layer does not cover:
  // POST /api/campaigns/[id]/launch, which the campaigns UI calls directly.
  // The check therefore lives here as well — before getMetaCreds/createAdSet,
  // i.e. before the first external call. Re-raised as a GuardError so the HTTP
  // route returns the reason to the user instead of a generic 500.
  try {
    await assertWithinBudget(accountId, 'this campaign launch');
  } catch (e: any) {
    throw new GuardError(e?.message || 'Monthly spend limit reached', 402);
  }

  if (!c.meta_campaign_id) throw new GuardError('Campaign has no linked Meta campaign — create it with channel "meta" and an ad account first');
  const budget = Number(opts.dailyBudget ?? c.budget) || 0;
  if (budget <= 0) throw new GuardError('Set a budget above 0 before launching');
  const adAccountId = c.meta_ad_account_id;
  if (!adAccountId) throw new GuardError('Campaign has no Meta ad account');

  const assets = (await getCampaignAssets(campaignId, accountId)) || [];
  const asset = assets[0];
  if (!asset) throw new GuardError('Attach at least one creative asset before launching');

  const { pageId } = await getMetaCreds(accountId, { provider: 'facebook' });
  if (!pageId) throw new GuardError('No Facebook Page connected — a Page is required for ad creatives');

  const adSet = await createAdSet(accountId, adAccountId, {
    campaignId: c.meta_campaign_id,
    name: `${c.name} — Ad Set`,
    dailyBudgetCents: Math.round(budget * 100),
    status: 'PAUSED',
  });

  const message = opts.message || c.name;
  const link = opts.link || APP_BASE_URL;
  let imageHash: string | undefined;
  let videoId: string | undefined;
  if (asset.kind === 'video') {
    ({ videoId } = await uploadAdVideo(accountId, adAccountId, asset.url));
  } else {
    const bytes = new Uint8Array(await (await fetch(asset.url)).arrayBuffer());
    ({ hash: imageHash } = await uploadAdImage(accountId, adAccountId, bytes));
  }

  const creative = await createAdCreative(accountId, adAccountId, { name: `${c.name} — Creative`, pageId, message, link, imageHash, videoId });
  const ad = await createAd(accountId, adAccountId, { name: `${c.name} — Ad`, adsetId: adSet.id, creativeId: creative.id, status: 'PAUSED' });

  // Flip everything ACTIVE — the money moment.
  await updateStatus(accountId, adSet.id, 'ACTIVE');
  await updateStatus(accountId, ad.id, 'ACTIVE');
  await updateStatus(accountId, c.meta_campaign_id, 'ACTIVE');

  await supabase.from('ad_sets').insert([{
    campaign_id: c.id, meta_adset_id: adSet.id, name: `${c.name} — Ad Set`,
    daily_budget: budget, meta_status: 'ACTIVE',
  }]);
  const { data: adSetRow } = await supabase.from('ad_sets').select('id').eq('meta_adset_id', adSet.id).single();
  await supabase.from('ads').insert([{
    ad_set_id: adSetRow?.id ?? null, campaign_id: c.id, meta_ad_id: ad.id,
    meta_creative_id: creative.id, asset_id: asset.id, name: `${c.name} — Ad`, meta_status: 'ACTIVE',
  }]);
  await supabase.from('ad_campaigns').update({ meta_status: 'ACTIVE', status: 'active' }).eq('id', c.id);

  return { campaign: c.meta_campaign_id, adSet: adSet.id, ad: ad.id, creative: creative.id };
}

/** Pause a live campaign on Meta. */
export async function pauseCampaign(accountId: string, campaignId: string) {
  const c = await ownedCampaign(campaignId, accountId);
  if (!c.meta_campaign_id) throw new GuardError('Campaign has no linked Meta campaign');
  await updateStatus(accountId, c.meta_campaign_id, 'PAUSED');
  const { data } = await supabase.from('ad_campaigns').update({ meta_status: 'PAUSED', status: 'paused' }).eq('id', c.id).select();
  return data?.[0] ?? c;
}

/** Pull live insights and update local spend/status. Read-only re Meta activation. */
export async function syncCampaign(accountId: string, campaignId: string) {
  const c = await ownedCampaign(campaignId, accountId);
  if (!c.meta_campaign_id) throw new GuardError('Campaign has no linked Meta campaign');
  const insights = await getInsights(accountId, c.meta_campaign_id);
  await supabase.from('ad_campaigns').update({
    spend: insights.spend,
    last_synced_at: new Date().toISOString(),
  }).eq('id', c.id);
  return insights;
}
