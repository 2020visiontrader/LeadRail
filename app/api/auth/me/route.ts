import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { verifySession, SESSION_COOKIE } from '@/lib/session';
export const dynamic = 'force-dynamic';
async function GET__impl(request: NextRequest) {
  const s = await verifySession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!s) return NextResponse.json({ authenticated: false }, { status: 401 });
  return NextResponse.json({ authenticated: true, email: s.email, role: s.role, accountId: s.accountId });
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/auth/me", method: "GET" });
