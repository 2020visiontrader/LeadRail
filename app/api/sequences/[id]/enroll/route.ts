import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { enrollContacts } from '@/lib/sequences';
import { dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

// POST /api/sequences/:id/enroll  body: { contactIds: string[] }
async function POST__impl(request: NextRequest, ctx: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const body = await request.json();
    const ids: string[] = Array.isArray(body?.contactIds) ? body.contactIds : [];
    if (!ids.length) return badRequest('contactIds array is required');
    const enrolled = await enrollContacts(ctx.params.id, session.accountId, ids);
    return NextResponse.json({ enrolled: enrolled.length, enrollments: enrolled }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const POST = withApi(POST__impl as any, { route: "/api/sequences/[id]/enroll", method: "POST" });
