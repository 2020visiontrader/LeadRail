import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { decryptMcpAuthHeader, recordMcpTestResult } from '@/lib/mcp/clients';
import { connect } from '@/lib/mcp/client';

export const dynamic = 'force-dynamic';

// POST /api/mcp-clients/:id/test — connect to the registered external MCP
// server (initialize + tools/list, 8s hard timeout — see lib/mcp/client.ts),
// persist last_status/discovered_tools/last_checked_at, and return the
// discovered tool names. Never returns the decrypted auth header.
async function POST__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const resolved = await decryptMcpAuthHeader(session.accountId, params.id);
    if (!resolved) return badRequest('unknown mcp client');

    const result = await connect(resolved.url, resolved.authHeader);
    await recordMcpTestResult(session.accountId, params.id, result);

    return NextResponse.json({
      ok: result.ok,
      error: result.error,
      tools: (result.tools || []).map((t) => t.name),
    });
  } catch (e) {
    return errorResponse(e);
  }
}

// --- request logging (auto-wrapped) ---
export const POST = withApi(POST__impl as any, { route: "/api/mcp-clients/[id]/test", method: "POST" });
