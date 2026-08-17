import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { dbReady, deleteConnection } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

async function DELETE__impl(request: NextRequest, ctx: { params: { provider: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    // externalId targets ONE connected account when several exist on the same
    // provider (e.g. two Google Drive accounts). Omitted = remove all rows for
    // that provider, the pre-existing behaviour.
    const externalId = request.nextUrl.searchParams.get('externalId') || undefined;
    const result = await deleteConnection(session.accountId, ctx.params.provider, externalId);
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const DELETE = withApi(DELETE__impl as any, { route: "/api/integrations/[provider]", method: "DELETE" });
