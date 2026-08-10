import { NextRequest, NextResponse } from 'next/server';
import { verifySession, SESSION_COOKIE } from '@/lib/session';

// Public paths that never require a session.
// '/r/' is the ambassador capture link — clicked by logged-out strangers, so it
// must be public. The trailing slash keeps it from matching the authed
// '/referrals' portal (which stays gated).
const PUBLIC_PAGES = ['/login', '/privacy', '/terms', '/data-deletion', '/r/'];
// Only genuinely public endpoints: user login, provider webhooks (signature-verified),
// the cron tick (bearer-protected), and the Meta OAuth callback. Everything else —
// including all social read/write routes — now requires a session.
// '/api/social/meta/connect' is a browser-navigated OAuth kickoff (not fetch()),
// and already redirects to /login itself when the session is missing/expired —
// public here so that redirect fires instead of the middleware's raw JSON 401.
// '/api/mcp' carries its own Bearer (APP_API_SECRET) auth inside the route, so
// it is public to the cookie middleware — like the bearer-protected cron tick.
const PUBLIC_API = ['/api/auth/login', '/api/webhooks', '/api/hermes/tick', '/api/mcp', '/api/social/meta/callback', '/api/social/meta/connect', '/api/social/meta/deauthorize', '/api/social/meta/data-deletion', '/api/social/instagram/callback', '/api/track', '/api/unsubscribe'];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith('/api');
  const isPublic = isApi
    ? PUBLIC_API.some((p) => pathname.startsWith(p))
    : PUBLIC_PAGES.some((p) => pathname === p || pathname.startsWith(p));
  if (isPublic) return NextResponse.next();

  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (session) return NextResponse.next();

  if (isApi) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.searchParams.set('next', pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // Run on everything except Next internals and static assets.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
