import { NextRequest, NextResponse } from 'next/server';
import { enrollContacts } from '@/lib/sequences';
import { dbReady } from '@/lib/db';
import { requireAuth, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

// POST /api/sequences/:id/enroll  body: { contactIds: string[] }
export async function POST(request: NextRequest, ctx: { params: { id: string } }) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const body = await request.json();
    const ids: string[] = Array.isArray(body?.contactIds) ? body.contactIds : [];
    if (!ids.length) return badRequest('contactIds array is required');
    const enrolled = await enrollContacts(ctx.params.id, ids);
    return NextResponse.json({ enrolled: enrolled.length, enrollments: enrolled }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
