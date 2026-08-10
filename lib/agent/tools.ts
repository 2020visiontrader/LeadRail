// Shared LeadRail tool registry — the single source of truth for every
// callable action. Two front doors consume this exact map:
//   1. The external MCP server (app/api/mcp/route.ts) — JSON-RPC over HTTP.
//   2. The internal agent loop (lib/agent/loop.ts) — the in-app "LeadRail AI"
//      chatbot that drives these tools from plain language.
// One registry means in-app and machine callers can never drift apart.
//
// Every tool is a THIN wrapper over an existing service — no business logic is
// reimplemented here. Account scope is always passed by the caller from the
// authenticated session; tools never trust client-supplied account ids.
//
// `sensitive: true` marks a tool that mutates external state or spends money.
// The agent loop NEVER auto-executes a sensitive tool — it surfaces a proposal
// and waits for explicit human approval (the same gate content publishing will
// reuse). MCP callers are already machine-authenticated, so they may call them
// directly.

import { z } from 'zod';
import { supabase, getContacts, getVentures, insertCampaignAsset } from '@/lib/db';
import { getCampaignAssets } from '@/lib/crm';
import { listConversations } from '@/lib/conversations';
import { listAdAccounts, getInsights } from '@/lib/social/meta-ads';
import {
  createCampaignRecord, launchCampaign, pauseCampaign, syncCampaign,
} from '@/lib/campaigns/actions';
import { getCampaignAbReport } from '@/lib/campaigns/analytics';
import { notionSearch } from '@/lib/integrations/notion';
import { driveSearch } from '@/lib/integrations/gdrive';

export interface AgentTool {
  /** Short human title shown in approval proposals. */
  title: string;
  description: string;
  /** JSON Schema for MCP tools/list. */
  inputSchema: Record<string, any>;
  /** Runtime validation for both callers. */
  zod: z.ZodTypeAny;
  /** Mutates external state / spends money → agent must get approval first. */
  sensitive?: boolean;
  run: (accountId: string, args: any) => Promise<any>;
}

const obj = (props: Record<string, any>, required: string[] = []) =>
  ({ type: 'object', properties: props, required, additionalProperties: false });
const S = { string: { type: 'string' }, number: { type: 'number' } } as const;

/** Resolve the brand ids in scope, optionally narrowed to one. */
async function brandScope(accountId: string, brandId?: string): Promise<string[]> {
  if (brandId) return [brandId];
  return (await getVentures(accountId)).map((b: any) => b.id);
}

export const TOOLS: Record<string, AgentTool> = {
  // ---- read: context the agent reasons over ------------------------------
  listVentures: {
    title: 'List ventures',
    description: 'List the ventures/brands in the account (id, name). Use to resolve a venture name the user typed into its id.',
    inputSchema: obj({}),
    zod: z.object({}),
    // Compact projection: full rows carry large JSON columns that overflow the
    // agent's observation cap and cause miscounts. id + name is all it needs.
    run: async (accountId) => (await getVentures(accountId)).map((v: any) => ({ id: v.id, name: v.name })),
  },
  listAdAccounts: {
    title: 'List Meta ad accounts',
    description: 'List the connected Meta ad accounts (id is act_<id>). Use to resolve which ad account to build a campaign in.',
    inputSchema: obj({}),
    zod: z.object({}),
    run: (accountId) => listAdAccounts(accountId),
  },
  listCampaigns: {
    title: 'List campaigns',
    description: 'List ad campaigns, optionally filtered to one venture.',
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
  },
  getCampaign: {
    title: 'Get campaign',
    description: 'Get a single campaign by id (must belong to the account).',
    inputSchema: obj({ id: S.string }, ['id']),
    zod: z.object({ id: z.string() }),
    run: async (accountId, { id }) => {
      const brandIds = await brandScope(accountId);
      const { data } = await supabase.from('ad_campaigns').select('*').eq('id', id).single();
      if (!data || !brandIds.includes(data.brand_id)) throw new Error('Campaign not found');
      return data;
    },
  },
  listAdSets: {
    title: 'List ad sets',
    description: 'List ad sets under a campaign (local records mirroring Meta).',
    inputSchema: obj({ campaignId: S.string }, ['campaignId']),
    zod: z.object({ campaignId: z.string() }),
    run: async (accountId, { campaignId }) => {
      // getCampaign enforces ownership before we expose children.
      await TOOLS.getCampaign.run(accountId, { id: campaignId });
      const { data, error } = await supabase.from('ad_sets').select('*')
        .eq('campaign_id', campaignId).order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
  },
  listAds: {
    title: 'List ads',
    description: 'List ads under a campaign (local records mirroring Meta).',
    inputSchema: obj({ campaignId: S.string }, ['campaignId']),
    zod: z.object({ campaignId: z.string() }),
    run: async (accountId, { campaignId }) => {
      await TOOLS.getCampaign.run(accountId, { id: campaignId });
      const { data, error } = await supabase.from('ads').select('*')
        .eq('campaign_id', campaignId).order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
  },
  listAssets: {
    title: 'List campaign assets',
    description: 'List creative assets attached to a campaign.',
    inputSchema: obj({ campaignId: S.string }, ['campaignId']),
    zod: z.object({ campaignId: z.string() }),
    run: (accountId, { campaignId }) => getCampaignAssets(campaignId, accountId),
  },
  getInsights: {
    title: 'Get Meta insights',
    description: 'Pull live Meta insights (spend/impressions/clicks/CPC/CPM/CTR) for a Meta object id (campaign, ad set, or ad).',
    inputSchema: obj({ metaObjectId: S.string }, ['metaObjectId']),
    zod: z.object({ metaObjectId: z.string() }),
    run: (accountId, { metaObjectId }) => getInsights(accountId, metaObjectId),
  },
  listLeads: {
    title: 'List leads',
    description: 'List leads/contacts across the account.',
    inputSchema: obj({ limit: S.number, offset: S.number }),
    zod: z.object({ limit: z.number().optional(), offset: z.number().optional() }),
    run: (accountId, { limit = 50, offset = 0 }) => getContacts(accountId, 'all', limit, offset),
  },
  getLead: {
    title: 'Get lead',
    description: 'Get a single lead/contact by id.',
    inputSchema: obj({ id: S.string }, ['id']),
    zod: z.object({ id: z.string() }),
    run: async (accountId, { id }) => {
      const { data } = await supabase.from('contacts').select('*').eq('id', id).eq('account_id', accountId).single();
      if (!data) throw new Error('Lead not found');
      return data;
    },
  },
  listConversations: {
    title: 'List conversations',
    description: 'List inbox conversations for the account.',
    inputSchema: obj({ limit: S.number }),
    zod: z.object({ limit: z.number().optional() }),
    run: (accountId, { limit = 50 }) => listConversations(accountId, limit),
  },

  // ---- write: gated behind human approval in the agent loop --------------
  createCampaign: {
    title: 'Create campaign',
    description: 'Create a campaign. channel:"meta" + metaAdAccountId also creates a PAUSED Meta campaign (no spend). objective e.g. OUTCOME_TRAFFIC / OUTCOME_LEADS.',
    inputSchema: obj({ brandId: S.string, name: S.string, channel: S.string, budget: S.number, objective: S.string, metaAdAccountId: S.string }, ['brandId', 'name']),
    zod: z.object({ brandId: z.string(), name: z.string(), channel: z.string().optional(), budget: z.number().optional(), objective: z.string().optional(), metaAdAccountId: z.string().optional() }),
    sensitive: true,
    run: (accountId, a) => createCampaignRecord(accountId, a),
  },
  importAsset: {
    title: 'Attach creative asset',
    description: 'Attach a creative asset (image/video URL) to a campaign so it can be launched.',
    inputSchema: obj({ campaignId: S.string, url: S.string, kind: S.string }, ['campaignId', 'url']),
    zod: z.object({ campaignId: z.string(), url: z.string().url(), kind: z.enum(['image', 'video']).optional() }),
    sensitive: true,
    run: (accountId, { campaignId, url, kind }) => insertCampaignAsset({ campaign_id: campaignId, account_id: accountId, url, kind: kind || 'image' }),
  },
  launchCampaign: {
    title: 'Launch campaign (SPENDS MONEY)',
    description: '⚠ Activates a LIVE PAID Meta ad and spends budget. Builds ad set + creative + ad from the first asset, then sets everything ACTIVE. Requires a linked Meta campaign, budget>0, ≥1 asset, and a connected Facebook Page.',
    inputSchema: obj({ id: S.string, message: S.string, link: S.string, dailyBudget: S.number }, ['id']),
    zod: z.object({ id: z.string(), message: z.string().optional(), link: z.string().optional(), dailyBudget: z.number().optional() }),
    sensitive: true,
    run: (accountId, { id, ...opts }) => launchCampaign(accountId, id, opts),
  },
  pauseCampaign: {
    title: 'Pause campaign',
    description: 'Pause a live Meta campaign (stops spend).',
    inputSchema: obj({ id: S.string }, ['id']),
    zod: z.object({ id: z.string() }),
    sensitive: true,
    run: (accountId, { id }) => pauseCampaign(accountId, id),
  },
  syncCampaign: {
    title: 'Sync campaign insights',
    description: 'Pull live Meta insights and update local spend for a campaign.',
    inputSchema: obj({ id: S.string }, ['id']),
    zod: z.object({ id: z.string() }),
    sensitive: true,
    run: (accountId, { id }) => syncCampaign(accountId, id),
  },
  analyzeCampaign: {
    title: 'Analyze campaign (A/B)',
    description: 'Compare a campaign\'s creatives on click-through, cost, and results; returns the winner and a plain-language recommendation on what to scale, pause, and test next. Read-only.',
    inputSchema: obj({ id: S.string }, ['id']),
    zod: z.object({ id: z.string() }),
    run: (accountId, { id }) => getCampaignAbReport(accountId, id),
  },
  // ---- read: external knowledge sources ----------------------------------
  searchNotion: {
    title: 'Search Notion',
    description: 'Search connected Notion for pages/databases matching a query. Use when the user references notes, docs, or knowledge kept in Notion.',
    inputSchema: obj({ query: S.string, limit: S.number }, ['query']),
    zod: z.object({ query: z.string(), limit: z.number().optional() }),
    run: (accountId, { query, limit }) => notionSearch(accountId, query, limit),
  },
  searchDrive: {
    title: 'Search Google Drive',
    description: 'Search connected Google Drive files by name. Use when the user references a document, sheet, or asset stored in Drive.',
    inputSchema: obj({ query: S.string, limit: S.number }, ['query']),
    zod: z.object({ query: z.string(), limit: z.number().optional() }),
    run: (accountId, { query, limit }) => driveSearch(accountId, query, limit),
  },
};

/** Compact catalog for the agent system prompt — name, purpose, args, gate. */
export function toolCatalogForPrompt(): string {
  return Object.entries(TOOLS).map(([name, t]) => {
    const args = Object.keys(t.inputSchema.properties || {});
    const req = new Set<string>(t.inputSchema.required || []);
    const sig = args.map((a) => (req.has(a) ? a : `${a}?`)).join(', ') || '—';
    return `${name}(${sig})${t.sensitive ? ' [needs approval]' : ''} — ${t.description}`;
  }).join('\n');
}

/** Tool specs for MCP tools/list. */
export function toolSpecs() {
  return Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema }));
}

export interface ToolRunResult { ok: boolean; result?: any; error?: string }

/** Validate + execute a tool by name. Never throws — errors are returned so
 *  both the loop and the MCP layer can feed them back to the model. */
export async function runTool(name: string, accountId: string, rawArgs: unknown): Promise<ToolRunResult> {
  const tool = TOOLS[name];
  if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
  const parsed = tool.zod.safeParse(rawArgs ?? {});
  if (!parsed.success) return { ok: false, error: `Invalid arguments: ${parsed.error.message}` };
  try {
    return { ok: true, result: await tool.run(accountId, parsed.data) };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'tool error' };
  }
}
