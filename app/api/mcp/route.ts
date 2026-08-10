import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/db';
import { toolSpecs, runTool } from '@/lib/agent/tools';

export const dynamic = 'force-dynamic';

// LeadRail MCP server — JSON-RPC 2.0 over HTTP. Thin transport over the shared
// tool registry (lib/agent/tools.ts); the in-app agent loop drives the exact
// same tools. Auth: Bearer APP_API_SECRET. Account scope: MCP_ACCOUNT_ID env,
// else the single accounts row (single-tenant owner use).
// TODO: per-account API keys for multi-tenant fan-out.

async function resolveAccountId(): Promise<string> {
  if (process.env.MCP_ACCOUNT_ID) return process.env.MCP_ACCOUNT_ID;
  const { data } = await supabase.from('accounts').select('id').limit(2);
  if (data && data.length === 1) return data[0].id;
  throw new Error('MCP_ACCOUNT_ID not configured (multiple/zero accounts present)');
}

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
      return rpc(id, { tools: toolSpecs() });
    case 'tools/call': {
      const name = params?.name;
      let accountId: string;
      try { accountId = await resolveAccountId(); } catch (e: any) { return rpc(id, undefined, { code: -32000, message: e.message }); }
      const res = await runTool(name, accountId, params?.arguments);
      if (res.ok) {
        return rpc(id, { content: [{ type: 'text', text: JSON.stringify(res.result) }], isError: false });
      }
      return rpc(id, { content: [{ type: 'text', text: res.error }], isError: true });
    }
    default:
      return rpc(id, undefined, { code: -32601, message: `Method not found: ${method}` });
  }
}

export const POST = withApi(POST__impl as any, { route: '/api/mcp', method: 'POST' });
