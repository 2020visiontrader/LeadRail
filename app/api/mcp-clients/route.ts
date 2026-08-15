import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { listMcpClients, createMcpClient, type McpTransport } from '@/lib/mcp/clients';

export const dynamic = 'force-dynamic';

const VALID_TRANSPORTS: McpTransport[] = ['http', 'sse'];

// GET /api/mcp-clients — list this account's registered external MCP servers.
// auth_header is always masked (has_auth_header only; the encrypted value
// never leaves the DB).
async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return NextResponse.json({ clients: [] });
  try {
    const clients = await listMcpClients(session.accountId);
    return NextResponse.json({ clients });
  } catch (e) {
    return errorResponse(e);
  }
}

// POST /api/mcp-clients — register an external MCP server. account_id always
// comes from the session, never the client body.
async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const body = await request.json();
    const name = String(body?.name || '').trim();
    const transport = String(body?.transport || '') as McpTransport;
    const url = String(body?.url || '').trim();
    if (!name) return badRequest('name is required');
    if (!VALID_TRANSPORTS.includes(transport)) return badRequest(`transport must be one of: ${VALID_TRANSPORTS.join(', ')}`);
    if (!url || !/^https?:\/\//i.test(url)) return badRequest('url must be a valid http(s) URL');
    const client = await createMcpClient(session.accountId, {
      name,
      transport,
      url,
      auth_header: body?.auth_header ? String(body.auth_header) : null,
      enabled: body?.enabled !== false,
    });
    return NextResponse.json(client, { status: 201 });
  } catch (e: any) {
    if (e?.code === 'vault_not_configured') return NextResponse.json({ error: e.message }, { status: 503 });
    if (e?.code === '23505') return badRequest('a server with that name already exists');
    return errorResponse(e);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/mcp-clients", method: "GET" });
export const POST = withApi(POST__impl as any, { route: "/api/mcp-clients", method: "POST" });
