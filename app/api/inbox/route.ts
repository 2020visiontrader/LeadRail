import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { getInbox, dbReady } from '@/lib/db';
import { requireSession, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return NextResponse.json([]);
  try {
    return NextResponse.json(await getInbox(session.accountId));
  } catch (error) {
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/inbox", method: "GET" });
