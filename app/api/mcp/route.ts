import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { supabase, getContacts, getVentures, insertCampaignAsset } from '@/lib/db';
import { getCampaignAssets } from '@/lib/crm';
import { listConversations } from '@/lib/conversations';
import { listAdAccounts } from '@/lib/social/meta-ads';
import {
  createCampaignRecord, launchCampaign, pauseCampaign, syncCampaign, GuardError,
} from '@/lib/campaigns/actions';

export const dynamic = 'force-dynamic';

// LeadRail MCP server — JSON-RPC 2.0 over HTTP. Thin wrappers over existing
// services (no reimplemented logic). Auth: Bearer APP_API_SECRET. Account scope:
// MCP_ACCOUNT_ID env, else the single accounts row (single-tenant owner use).
// TODO: per-account API keys for multi-tenant fan-out.

async function resolveAccountId(): Promise<string> {
  if (process.env.MCP_ACCOUNT_ID) return process.env.MCP_ACCOUNT_ID;
  const { data } = await supabase.from('accounts').select('id').limit(2);
  if (data && data.length === 1) return data[0].id;
  throw new Error('MCP_ACCOUNT_ID not configured (multiple/zero accounts present)');
}

// --- tool registry: each tool is a thin wrapper over an existing service ---
interface Tool {
  description: string;
  inputSchema: Record<string, any>; // JSON Schema for tools/list
  zod: z.ZodTypeAny;                 // validation for tools/call
  run: (accountId: string, args: any) => Promise<any>;
}

const obj = (props: Record<string, any>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const S = { string: { type: 'string' }, number: { type: 'number' } } as const;

const TOOLS: Record<string, Tool> = {
  listCampaigns: {
    description: 'List ad campaigns for the account, optionally filtered to one brand/venture.',
    inputSchema: obj({ brandId: S.string, limit: S.number }),
    zod: z.object({ brandId: z.string().optional(), limit: z.number().optional() }),
    run: async (accountId, { brandId, limit = 100 }) => {
      let brandIds: string[];
      if (brandId) brandIds = [brandId];
      else brandIds = (await getVentures(accountId)).map((b: any) => b.id);
      if (!brandIds.length) return [];
      const { data, error } = await supabase.from('ad_campaigns').select('*').in('brand_id', brandIds).order('created_at', { ascending: false }).limit(limit);
      if (error) throw error;
      return data;
    },
  },
  getCampaign: {
    description: 'Get a single campaign by id (must belong to the account).',
    inputSchema: obj({ id: S.string }, ['id']),
    zod: z.object({ id: z.string() }),
    run: async (accountId, { id }) => {
      const brandIds = (await getVentures(accountId)).map((b: any) => b.id);
      const { data } = await supabase.from('ad_campaigns').select('*').eq('id', id).single();
      if (!data || !brandIds.includes(data.brand_id)) throw new Error('Campaign not found');
      return data;
    },
  },
  createCampaign: {
    description: 'Create a campaign. channel:"meta" + metaAdAccountId also creates a PAUSED Meta campaign.',
    inputSchema: obj({ brandId: S.string, name: S.string, channel: S.string, budget: S.number, objective: S.string, metaAdAccountId: S.string }, ['brandId', 'name']),
    zod: z.object({ brandId: z.string(), name: z.string(), channel: z.string().optional(), budget: z.number().optional(), objective: z.string().optional(), metaAdAccountId: z.string().optional() }),
    run: (accountId, a) => createCampaignRecord(accountId, a),
  },
  launchCampaign: {
    description: '⚠ Activates a LIVE PAID Meta ad and spends budget. Requires linked Meta campaign, budget>0, and ≥1 asset.',
    inputSchema: obj({ id: S.string, message: S.string, link: S.string, dailyBudget: S.number }, ['id']),
    zod: z.object({ id: z.string(), message: z.string().optional(), link: z.string().optional(), dailyBudget: z.number().optional() }),
    run: (accountId, { id, ...opts }) => launchCampaign(accountId, id, opts),
  },
  pauseCampaign: {
    description: 'Pause a live Meta campaign.',
    inputSchema: obj({ id: S.string }, ['id']),
    zod: z.object({ id: z.string() }),
    run: (accountId, { id }) => pauseCampaign(accountId, id),
  },
  syncCampaign: {
    description: 'Pull live Meta insights (spend/impressions/clicks) and update local spend.',
    inputSchema: obj({ id: S.string }, ['id']),
    zod: z.object({ id: z.string() }),
    run: (accountId, { id }) => syncCampaign(accountId, id),
  },
  listAssets: {
    description: 'List creative assets attached to a campaign.',
    inputSchema: obj({ campaignId: S.string }, ['campaignId']),
    zod: z.object({ campaignId: z.string() }),
    run: (accountId, { campaignId }) => getCampaignAssets(campaignId, accountId),
  },
  importAsset: {
    description: 'Attach a creative asset (image/video URL) to a campaign.',
    inputSchema: obj({ campaignId: S.string, url: S.string, kind: S.string }, ['campaignId', 'url']),
    zod: z.object({ campaignId: z.string(), url: z.string(), kind: z.string().optional() }),
    run: (accountId, { campaignId, url, kind }) => insertCampaignAsset({ campaign_id: campaignId, account_id: accountId, url, kind: kind || 'image' }),
  },
  listLeads: {
    description: 'List leads/contacts for the account across all ventures.',
    inputSchema: obj({ limit: S.number, offset: S.number }),
    zod: z.object({ limit: z.number().optional(), offset: z.number().optional() }),
    run: (accountId, { limit = 50, offset = 0 }) => getContacts(accountId, 'all', limit, offset),
  },
  getLead: {
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
    description: 'List inbox conversations for the account.',
    inputSchema: obj({ limit: S.number }),
    zod: z.object({ limit: z.number().optional() }),
    run: (accountId, { limit = 50 }) => listConversations(accountId, limit),
  },
  listAdAccounts: {
    description: 'List the connected Meta ad accounts.',
    inputSchema: obj({}),
    zod: z.object({}),
    run: (accountId) => listAdAccounts(accountId),
  },
};

function rpc(id: any, result?: any, error?: { code: number; message: string }) {
  const body: any = { jsonrpc: '2.0', id: id ?? null };
  if (error) body.error = error; else body.result = result;
  return NextResponse.json(body);
}

function authorized(request: NextRequest): boolean {
  const secret = process.env.APP_API_SECRET;
  if (!secret) return false;
  const auth = request.headers.get('authorization') || '';
  return auth.startsWith('Bearer ') && auth.slice(7) === secret;
}

async function POST__impl(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }, { status: 401 });
  }
  let req: any;
  try { req = await request.json(); } catch { return rpc(null, undefined, { code: -32700, message: 'Parse error' }); }

  const { id, method, params } = req || {};
  switch (method) {
    case 'initialize':
      return rpc(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'leadrail', version: '0.1.0' } });
    case 'notifications/initialized':
      return new NextResponse(null, { status: 204 });
    case 'ping':
      return rpc(id, {});
    case 'tools/list':
      return rpc(id, { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) });
    case 'tools/call': {
      const name = params?.name;
      const tool = TOOLS[name];
      if (!tool) return rpc(id, undefined, { code: -32602, message: `Unknown tool: ${name}` });
      let accountId: string;
      try { accountId = await resolveAccountId(); } catch (e: any) { return rpc(id, undefined, { code: -32000, message: e.message }); }
      const parsed = tool.zod.safeParse(params?.arguments ?? {});
      if (!parsed.success) return rpc(id, { content: [{ type: 'text', text: `Invalid arguments: ${parsed.error.message}` }], isError: true });
      try {
        const result = await tool.run(accountId, parsed.data);
        return rpc(id, { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false });
      } catch (e: any) {
        const msg = e instanceof GuardError ? e.message : (e?.message || 'tool error');
        return rpc(id, { content: [{ type: 'text', text: msg }], isError: true });
      }
    }
    default:
      return rpc(id, undefined, { code: -32601, message: `Method not found: ${method}` });
  }
}

export const POST = withApi(POST__impl as any, { route: '/api/mcp', method: 'POST' });
