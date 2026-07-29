import { NextRequest, NextResponse } from 'next/server';
import { getInbox, dbReady } from '@/lib/db';
import { requireSession, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return NextResponse.json([]);
  try {
    return NextResponse.json(await getInbox(session.accountId));
  } catch (error) {
    return errorResponse(error);
  }
}
