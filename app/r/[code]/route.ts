import { NextRequest, NextResponse } from 'next/server';
import { recordClick, REF_COOKIE, REF_WINDOW_DAYS, normalizeCode } from '@/lib/referrals';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /r/<code> — the ambassador link. Logs the click, drops a first-party
// attribution cookie (60d), and forwards to the app. The cookie carries only
// the code; it identifies no person.
export async function GET(request: NextRequest, { params }: { params: { code: string } }) {
  const code = normalizeCode(params.code);
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
  const ua = request.headers.get('user-agent');
  const referer = request.headers.get('referer');

  if (code.length >= 3) {
    await recordClick(code, ip, ua, referer).catch(() => {});
  }

  // Forward to the app home (or signup, when one exists), preserving ?ref so the
  // signup form can pre-fill it.
  const dest = new URL('/', request.url);
  if (code.length >= 3) dest.searchParams.set('ref', code);
  const res = NextResponse.redirect(dest);
  if (code.length >= 3) {
    res.cookies.set(REF_COOKIE, code, {
      httpOnly: false, // readable by the signup form to pre-fill the code
      secure: true, sameSite: 'lax', path: '/',
      maxAge: REF_WINDOW_DAYS * 86400,
    });
  }
  return res;
}
