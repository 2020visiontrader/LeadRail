import { z } from 'zod';
import { supabase, getVentures, insertCampaignAsset } from '@/lib/db';
import { listAdAccounts, getInsights } from '@/lib/social/meta-ads';
import {
  createCampaignRecord, launchCampaign, pauseCampaign, syncCampaign,
} from '@/lib/campaigns/actions';
import { getCampaignAbReport } from '@/lib/campaigns/analytics';
import { getCampaignAssets } from '@/lib/crm';
import {
  obj, S, type Capability,
  present, rowsOf, firstField, plural, tally, samples, clip, digestLine,
} from './types';

// Module-local ownership helpers — replace TOOLS.getCampaign pattern
async function getCampaignOwned(accountId: string, id: string) {
  const brandIds = await brandScope(accountId);
  const { data } = await supabase.from('ad_campaigns').select('*').eq('id', id).single();
  if (!data || !brandIds.includes(data.brand_id)) throw new Error('Campaign not found');
  return data;
}

// Resolve the brand ids in scope, optionally narrowed to one.
// PORT NOTE: must use getVentures() from @/lib/db — the underlying table is
// `brands`, NOT `ventures`. Querying `ventures` directly returns [] for every
// account, which silently makes listCampaigns empty and every ownership check
// fail. Kept identical to the original brandScope in lib/agent/tools.ts.
async function brandScope(accountId: string, brandId?: string): Promise<string[]> {
  if (brandId) return [brandId];
  return (await getVentures(accountId)).map((b: any) => b.id);
}

export const CAMPAIGN_CAPABILITIES: Capability[] = [
  {
    name: 'listAdAccounts',
    domain: 'campaigns',
    title: 'List Meta ad accounts',
    description: 'List the connected Meta ad accounts (id is act_<id>). Use to resolve which ad account to build a campaign in.',
    gate: 'read',
    inputSchema: obj({}),
    zod: z.object({}),
    run: (accountId) => listAdAccounts(accountId),
  },
  {
    name: 'listCampaigns',
    domain: 'campaigns',
    title: 'List campaigns',
    description: 'List ad campaigns, optionally filtered to one venture.',
    gate: 'read',
    inputSchema: obj({ brandId: S.string, limit: S.number }),
    zod: z.object({ brandId: z.string().optional(), limit: z.number().optional() }),
    run: async (accountId, { brandId, limit = 100 }) => {
      const brandIds = await brandScope(accountId, brandId);
      if (!brandIds.length) return [];
      const { data, error } = await supabase.from('ad_campaigns').select('*')
        .in('brand_id', brandIds).order('created_at', { ascending: false }).limit(limit);
      if (error) throw error;
      return data;
    },
    // Counts the rows returned and breaks them down by the status field where
    // present. Spend/budget are NOT summed here: a row may legitimately lack
    // either, and a partial sum stated as a total would be a fabrication.
    digest: (_args, result) => {
      const rows = rowsOf(result);
      if (!rows) return '';
      const by = tally(rows, 'status');
      const live = tally(rows, 'meta_status');
      const names = samples(rows, ['name']);
      return digestLine(
        `${plural(rows.length, 'campaign')} returned.`,
        by ? `By status: ${by}.` : null,
        live ? `Meta status: ${live}.` : null,
        names.length ? `Includes: ${names.join(', ')}.` : null,
      );
    },
  },
  {
    name: 'getCampaign',
    domain: 'campaigns',
    title: 'Get campaign',
    description: 'Get a single campaign by id (must belong to the account).',
    gate: 'read',
    inputSchema: obj({ id: S.string }, ['id']),
    zod: z.object({ id: z.string() }),
    run: async (accountId, { id }) => getCampaignOwned(accountId, id),
    digest: (_args, result) => {
      if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
      const name = firstField(result, ['name']);
      const bits = [
        present(result, 'status') ? `status ${result.status}` : null,
        present(result, 'meta_status') ? `Meta status ${result.meta_status}` : null,
        present(result, 'channel') ? `channel ${result.channel}` : null,
        present(result, 'objective') ? `objective ${result.objective}` : null,
        present(result, 'budget') ? `budget ${result.budget}` : null,
        present(result, 'spend') ? `spend ${result.spend}` : null,
        present(result, 'meta_campaign_id') ? 'linked to a Meta campaign' : null,
      ].filter(Boolean);
      if (!name && !bits.length) return '';
      return digestLine(`Campaign${name ? ` "${clip(name, 60)}"` : ''}${bits.length ? `: ${bits.join(', ')}` : ''}.`);
    },
  },
  {
    name: 'listAdSets',
    domain: 'campaigns',
    title: 'List ad sets',
    description: 'List ad sets under a campaign (local records mirroring Meta).',
    gate: 'read',
    inputSchema: obj({ campaignId: S.string }, ['campaignId']),
    zod: z.object({ campaignId: z.string() }),
    run: async (accountId, { campaignId }) => {
      await getCampaignOwned(accountId, campaignId);
      const { data, error } = await supabase.from('ad_sets').select('*')
        .eq('campaign_id', campaignId).order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
    digest: (_args, result) => {
      const rows = rowsOf(result);
      if (!rows) return '';
      const by = tally(rows, 'meta_status');
      const names = samples(rows, ['name']);
      return digestLine(
        `${plural(rows.length, 'ad set')} on this campaign.`,
        by ? `Meta status: ${by}.` : null,
        names.length ? `Includes: ${names.join(', ')}.` : null,
      );
    },
  },
  {
    name: 'listAds',
    domain: 'campaigns',
    title: 'List ads',
    description: 'List ads under a campaign (local records mirroring Meta).',
    gate: 'read',
    inputSchema: obj({ campaignId: S.string }, ['campaignId']),
    zod: z.object({ campaignId: z.string() }),
    run: async (accountId, { campaignId }) => {
      await getCampaignOwned(accountId, campaignId);
      const { data, error } = await supabase.from('ads').select('*')
        .eq('campaign_id', campaignId).order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
    digest: (_args, result) => {
      const rows = rowsOf(result);
      if (!rows) return '';
      const by = tally(rows, 'meta_status');
      const names = samples(rows, ['name']);
      return digestLine(
        `${plural(rows.length, 'ad')} on this campaign.`,
        by ? `Meta status: ${by}.` : null,
        names.length ? `Includes: ${names.join(', ')}.` : null,
      );
    },
  },
  {
    name: 'listAssets',
    domain: 'campaigns',
    title: 'List campaign assets',
    description: 'List creative assets attached to a campaign.',
    gate: 'read',
    inputSchema: obj({ campaignId: S.string }, ['campaignId']),
    zod: z.object({ campaignId: z.string() }),
    run: (accountId, { campaignId }) => getCampaignAssets(campaignId, accountId),
  },
  {
    name: 'getInsights',
    domain: 'campaigns',
    title: 'Get Meta insights',
    description: 'Pull live Meta insights (spend/impressions/clicks/CPC/CPM/CTR) for a Meta object id (campaign, ad set, or ad).',
    gate: 'read',
    inputSchema: obj({ metaObjectId: S.string }, ['metaObjectId']),
    zod: z.object({ metaObjectId: z.string() }),
    run: (accountId, { metaObjectId }) => getInsights(accountId, metaObjectId),
    // Restates the metric fields that are present on the result object, with the
    // values it holds. No derived rates, no filled-in blanks — a metric the
    // result omits is simply not mentioned.
    digest: (args, result) => {
      if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
      const bits = (['spend', 'impressions', 'clicks', 'ctr', 'cpc', 'cpm'] as const)
        .filter((k) => present(result, k))
        .map((k) => `${k} ${(result as any)[k]}`);
      if (!bits.length) return '';
      const id = args?.metaObjectId ? ` for ${clip(String(args.metaObjectId), 40)}` : '';
      return digestLine(`Meta insights${id}: ${bits.join(', ')}.`);
    },
  },
  {
    name: 'createCampaign',
    domain: 'campaigns',
    title: 'Create campaign',
    description: 'Create a campaign. channel:"meta" + metaAdAccountId also creates a PAUSED Meta campaign (no spend). objective e.g. OUTCOME_TRAFFIC / OUTCOME_LEADS.',
    gate: 'internal_write',
    inputSchema: obj({ brandId: S.string, name: S.string, channel: S.string, budget: S.number, objective: S.string, metaAdAccountId: S.string }, ['brandId', 'name']),
    zod: z.object({ brandId: z.string(), name: z.string(), channel: z.string().optional(), budget: z.number().optional(), objective: z.string().optional(), metaAdAccountId: z.string().optional() }),
    run: (accountId, a) => createCampaignRecord(accountId, a),
  },
  {
    name: 'importAsset',
    domain: 'campaigns',
    title: 'Attach creative asset',
    description: 'Attach a creative asset (image/video URL) to a campaign so it can be launched.',
    gate: 'internal_write',
    inputSchema: obj({ campaignId: S.string, url: S.string, kind: S.string }, ['campaignId', 'url']),
    zod: z.object({ campaignId: z.string(), url: z.string().url(), kind: z.enum(['image', 'video']).optional() }),
    run: (accountId, { campaignId, url, kind }) =>
      insertCampaignAsset({ campaign_id: campaignId, account_id: accountId, url, kind: kind || 'image' }),
  },
  {
    name: 'launchCampaign',
    domain: 'campaigns',
    title: 'Launch campaign (SPENDS MONEY)',
    description: '⚠ Activates a LIVE PAID Meta ad and spends budget. Builds ad set + creative + ad from the first asset, then sets everything ACTIVE. Requires a linked Meta campaign, budget>0, ≥1 asset, and a connected Facebook Page.',
    gate: 'spend',
    inputSchema: obj({ id: S.string, message: S.string, link: S.string, dailyBudget: S.number }, ['id']),
    zod: z.object({ id: z.string(), message: z.string().optional(), link: z.string().optional(), dailyBudget: z.number().optional() }),
    run: (accountId, { id, ...opts }) => launchCampaign(accountId, id, opts),
    // Leads with the money, because that is the decision being made. The daily
    // budget is the number the reviewer needs and the one the raw payload buried.
    summarize: (a) => [
      a.dailyBudget
        ? `Start spending ${a.dailyBudget} per day on campaign ${a.id}.`
        : `Start spending this campaign's daily budget on campaign ${a.id}.`,
      'The ad goes live to a real audience immediately and keeps spending until it is paused.',
      a.link ? `It links to ${a.link}.` : null,
    ].filter(Boolean).join(' '),
    // launchCampaign resolves ONLY after every Meta call succeeded, to
    // `{ campaign, adSet, ad, creative }` — four real Meta object ids. Every
    // failure path before that throws a GuardError (no budget, no linked Meta
    // campaign, no asset, no Page, over the monthly spend limit), so a result
    // that does not carry those ids is not a launch and gets no digest.
    //
    // The ids are the evidence, so they are what the line states. The daily
    // budget deliberately is NOT restated from `args`: the request is not the
    // outcome, and `launchCampaign` falls back to the campaign's own stored
    // budget when the argument is absent — narrating the argument would report
    // a number that may never have been the one spent.
    digest: (_args, result) => {
      if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
      const r: any = result;
      if (!present(r, 'adSet') || !present(r, 'ad')) return '';
      return digestLine(
        `Campaign is LIVE on Meta and spending: ad ${clip(String(r.ad), 40)} in ad set ${clip(String(r.adSet), 40)}${present(r, 'creative') ? ` on creative ${clip(String(r.creative), 40)}` : ''}, all set ACTIVE.`,
        'It keeps spending until it is paused.',
      );
    },
  },
  {
    name: 'pauseCampaign',
    domain: 'campaigns',
    title: 'Pause campaign',
    description: 'Pause a live Meta campaign (stops spend).',
    gate: 'internal_write',
    inputSchema: obj({ id: S.string }, ['id']),
    zod: z.object({ id: z.string() }),
    run: (accountId, { id }) => pauseCampaign(accountId, id),
  },
  {
    name: 'syncCampaign',
    domain: 'campaigns',
    title: 'Sync campaign insights',
    description: 'Pull live Meta insights and update local spend for a campaign.',
    gate: 'internal_write',
    inputSchema: obj({ id: S.string }, ['id']),
    zod: z.object({ id: z.string() }),
    run: (accountId, { id }) => syncCampaign(accountId, id),
  },
  {
    name: 'analyzeCampaign',
    domain: 'campaigns',
    title: 'Analyze campaign (A/B)',
    description: "Compare a campaign's creatives on click-through, cost, and results; returns the winner and a plain-language recommendation on what to scale, pause, and test next. Read-only.",
    gate: 'read',
    inputSchema: obj({ id: S.string }, ['id']),
    zod: z.object({ id: z.string() }),
    run: (accountId, { id }) => getCampaignAbReport(accountId, id),
  },
];
