import { withApi } from '@/lib/http';
import { NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/lib/session';
export const dynamic = 'force-dynamic';
async function POST__impl() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 0 });
  return res;
}

// --- request logging (auto-wrapped) ---
export const POST = withApi(POST__impl as any, { route: "/api/auth/logout", method: "POST" });
