import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { deleteTemplate, updateTemplate, dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

async function PATCH__impl(request: NextRequest, ctx: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const body = await request.json();
    const tpl = await updateTemplate(ctx.params.id, session.accountId, {
      name: body.name,
      category: body.category,
      subject: body.subject,
      body: body.body,
    });
    return NextResponse.json(tpl);
  } catch (error) {
    return errorResponse(error);
  }
}

async function DELETE__impl(request: NextRequest, ctx: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    return NextResponse.json(await deleteTemplate(ctx.params.id, session.accountId));
  } catch (error) {
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const PATCH = withApi(PATCH__impl as any, { route: "/api/templates/[id]", method: "PATCH" });
export const DELETE = withApi(DELETE__impl as any, { route: "/api/templates/[id]", method: "DELETE" });
