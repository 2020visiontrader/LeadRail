import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { getMcpClient, updateMcpClient, deleteMcpClient, type McpTransport } from '@/lib/mcp/clients';

export const dynamic = 'force-dynamic';

const VALID_TRANSPORTS: McpTransport[] = ['http', 'sse'];

// GET /api/mcp-clients/:id — fetch one registered server (account-scoped).
async function GET__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const client = await getMcpClient(session.accountId, params.id);
    if (!client) return badRequest('unknown mcp client');
    return NextResponse.json(client);
  } catch (e) {
    return errorResponse(e);
  }
}

// PATCH /api/mcp-clients/:id — update name/transport/url/auth_header/enabled.
// Account ownership is enforced inside updateMcpClient (WHERE account_id = session).
async function PATCH__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body = await request.json();
    const transport = body?.transport !== undefined ? String(body.transport) as McpTransport : undefined;
    if (transport && !VALID_TRANSPORTS.includes(transport)) return badRequest(`transport must be one of: ${VALID_TRANSPORTS.join(', ')}`);
    if (body?.url !== undefined && !/^https?:\/\//i.test(String(body.url))) return badRequest('url must be a valid http(s) URL');
    const client = await updateMcpClient(session.accountId, params.id, {
      name: body?.name !== undefined ? String(body.name) : undefined,
      transport,
      url: body?.url !== undefined ? String(body.url) : undefined,
      auth_header: body?.auth_header ? String(body.auth_header) : undefined,
      enabled: body?.enabled !== undefined ? Boolean(body.enabled) : undefined,
      allow_auto: body?.allow_auto !== undefined ? Boolean(body.allow_auto) : undefined,
    });
    return NextResponse.json(client);
  } catch (e: any) {
    if (e?.code === 'vault_not_configured') return NextResponse.json({ error: e.message }, { status: 503 });
    if (e?.message === 'mcp client not found') return badRequest('unknown mcp client');
    return errorResponse(e);
  }
}

// DELETE /api/mcp-clients/:id
async function DELETE__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    return NextResponse.json(await deleteMcpClient(session.accountId, params.id));
  } catch (e: any) {
    if (e?.message === 'mcp client not found') return badRequest('unknown mcp client');
    return errorResponse(e);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/mcp-clients/[id]", method: "GET" });
export const PATCH = withApi(PATCH__impl as any, { route: "/api/mcp-clients/[id]", method: "PATCH" });
export const DELETE = withApi(DELETE__impl as any, { route: "/api/mcp-clients/[id]", method: "DELETE" });
