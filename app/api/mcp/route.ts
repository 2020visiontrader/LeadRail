import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/db';
import { TOOLS, toolSpecs, runTool } from '@/lib/agent/tools';
import { hashBearer, resolveMcpKey } from '@/lib/mcp/keys';
import { createApproval, decideApproval, consumeApprovalForExecution } from '@/lib/approvals/store';

export const dynamic = 'force-dynamic';

// LeadRail MCP server — JSON-RPC 2.0 over HTTP. Thin transport over the shared
// tool registry (lib/agent/tools.ts); the in-app agent loop drives the exact
// same tools.
//
// Auth (Packet 0.3): a per-account key from `mcp_api_keys` (migration
// 039_mcp_keys.sql) is tried FIRST — it carries its own account scope and an
// explicit `allow_sensitive` opt-in. The legacy shared `APP_API_SECRET` +
// `MCP_ACCOUNT_ID` path is kept ONLY as a fallback when no key row matches, and
// when it is used sensitive tools are FORCED OFF: one static shared secret is
// not an authorisation decision, and previously it could launch campaigns, send
// email and burn credits with no approval and no audit trail.
//
// Sensitive tools therefore require a key with allow_sensitive=true, and every
// permitted sensitive call writes an `approvals` row that ends in state
// 'executed' — machine callers leave the same audit trail as human-approved
// ones.

async function resolveLegacyAccountId(): Promise<string> {
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

function bearerFrom(request: NextRequest): string | null {
  const auth = request.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  return token || null;
}

/** The authenticated caller. `principal` identifies the key for rate limiting
 * and for the audit row's actor field; it is a hash or the literal 'legacy',
 * never the raw token. */
interface McpCaller {
  accountId: string;
  allowSensitive: boolean;
  principal: string;
}

// Simple in-process rate limit: max 60 tools/call per key per minute. This is a
// backstop against a runaway or stolen key on a single instance, NOT a
// distributed limiter — it resets on deploy and is per-process by design.
const CALLS_PER_MINUTE = 60;
const RATE_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function rateLimited(principal: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(principal);
  if (!bucket || now >= bucket.resetAt) {
    rateBuckets.set(principal, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  return bucket.count > CALLS_PER_MINUTE;
}

async function POST__impl(request: NextRequest) {
  const unauthorized = () =>
    NextResponse.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }, { status: 401 });

  const bearer = bearerFrom(request);
  if (!bearer) return unauthorized();

  // Key lookup FIRST. resolveMcpKey is a gate: it throws rather than returning a
  // permissive default, so a DB failure denies the request.
  let caller: McpCaller;
  try {
    const key = await resolveMcpKey(bearer);
    if (key) {
      caller = { accountId: key.accountId, allowSensitive: key.allowSensitive, principal: `key:${hashBearer(bearer)}` };
    } else {
      // Legacy fallback, second: the shared APP_API_SECRET. Preserves today's
      // single-tenant owner setup WITHOUT today's blast radius —
      // allowSensitive is hard-coded false and cannot be configured up.
      const secret = process.env.APP_API_SECRET;
      if (!secret || bearer !== secret) return unauthorized();
      caller = { accountId: await resolveLegacyAccountId(), allowSensitive: false, principal: 'legacy' };
    }
  } catch {
    // Fail CLOSED: any failure resolving the caller denies the request.
    return unauthorized();
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
      if (rateLimited(caller.principal)) {
        return rpc(id, undefined, { code: -32029, message: 'Rate limit exceeded: max 60 tool calls per minute for this key.' });
      }

      const name = String(params?.name || '');
      const args = (params?.arguments && typeof params.arguments === 'object') ? params.arguments : {};
      const def = TOOLS[name];
      const accountId = caller.accountId;

      // Sensitivity gate — read the same flag the agent loop reads
      // (lib/agent/loop.ts: `TOOLS[tool]?.sensitive`). This MUST refuse before
      // runTool is reached; a sensitive tool without an opt-in key never runs.
      if (def?.sensitive && !caller.allowSensitive) {
        return rpc(id, { content: [{ type: 'text', text: 'This tool requires an approval-enabled key.' }], isError: true });
      }

      // Audit BEFORE execution: a permitted sensitive call leaves the same
      // approvals trail as a human-approved one (pending -> approved ->
      // executed, all via the existing store functions). This is a gate, not
      // best-effort: if the audit row cannot be written we refuse rather than
      // execute untracked.
      if (def?.sensitive) {
        try {
          const row = await createApproval(accountId, {
            tool: name,
            title: def.title,
            summary: `MCP key call: ${def.title}`,
            args,
            requestedBy: caller.principal,
          });
          await decideApproval(accountId, row.id, 'approved', { decidedBy: `mcp:${caller.principal}`, comment: 'Auto-approved: MCP key with allow_sensitive.' });
          await consumeApprovalForExecution(accountId, row.id, name, args);
        } catch {
          return rpc(id, { content: [{ type: 'text', text: "I couldn't record that action for audit, so it was not run." }], isError: true });
        }
      }

      const res = await runTool(name, accountId, args);
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
