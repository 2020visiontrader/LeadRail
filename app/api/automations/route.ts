import { NextRequest, NextResponse } from 'next/server';
import { listAutomations, createAutomation } from '@/lib/automations';
import { dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return NextResponse.json([]);
  try {
    return NextResponse.json(await listAutomations(session.accountId));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const body = await request.json();
    if (!body?.name || !body?.trigger || !body?.action) return badRequest('name, trigger, action required');
    return NextResponse.json(await createAutomation(session.accountId, body), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
