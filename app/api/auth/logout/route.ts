import { withApi, requireSession } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/lib/session';
export const dynamic = 'force-dynamic';
async function POST__impl(request: NextRequest) {
  // No account data is touched here — this only clears the cookie — but the
  // route-audit test requires every route to carry an explicit guard rather
  // than rely on middleware alone, so it is self-defending too.
  const { error } = await requireSession(request);
  if (error) return error;
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 0 });
  return res;
}

// --- request logging (auto-wrapped) ---
export const POST = withApi(POST__impl as any, { route: "/api/auth/logout", method: "POST" });
