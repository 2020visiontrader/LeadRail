import { NextRequest, NextResponse } from 'next/server';
import { verifySession, SESSION_COOKIE } from '@/lib/session';

// Public paths that never require a session.
// '/r/' is the ambassador capture link — clicked by logged-out strangers, so it
// must be public. The trailing slash keeps it from matching the authed
// '/referrals' portal (which stays gated).
const PUBLIC_PAGES = ['/welcome', '/login', '/privacy', '/terms', '/data-deletion', '/r/'];
// Only genuinely public endpoints: user login, provider webhooks (signature-verified),
// the cron tick (bearer-protected), and the Meta OAuth callback. Everything else —
// including all social read/write routes — now requires a session.
// '/api/social/meta/connect' is a browser-navigated OAuth kickoff (not fetch()),
// and already redirects to /login itself when the session is missing/expired —
// public here so that redirect fires instead of the middleware's raw JSON 401.
// '/api/mcp' carries its own Bearer (APP_API_SECRET) auth inside the route, so
// it is public to the cookie middleware — like the bearer-protected cron tick.
// '/api/public/*' is the intentional public surface (e.g. embeddable web-form
// submissions from any external site) — these routes derive tenant from the
// resource row, never from a session, and are safe to expose unauthenticated.
const PUBLIC_API = ['/api/auth/login', '/api/webhooks', '/api/hermes/tick', '/api/mcp', '/api/public', '/api/social/meta/callback', '/api/social/meta/connect', '/api/social/meta/deauthorize', '/api/social/meta/data-deletion', '/api/social/instagram/callback', '/api/track', '/api/unsubscribe'];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith('/api');
  // Boundary-aware prefix match: '/api/mcp' must NOT whitelist '/api/mcp-clients'.
  // A bare startsWith let the '/api/mcp' public prefix swallow the mcp-clients
  // management API (encrypted auth headers) — an auth bypass. Match the exact
  // path or a real path segment boundary only.
  const matchPrefix = (p: string) => {
    const base = p.endsWith('/') ? p.slice(0, -1) : p;
    return pathname === base || pathname.startsWith(base + '/');
  };
  const isPublic = isApi ? PUBLIC_API.some(matchPrefix) : PUBLIC_PAGES.some(matchPrefix);
  if (isPublic) return NextResponse.next();

  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (session) return NextResponse.next();

  if (isApi) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const url = req.nextUrl.clone();
  // A stranger hitting the root gets the public marketing landing, not the bare
  // login form. Every other unauthenticated page still routes to /login (with a
  // next param so the operator returns to where they were headed).
  if (pathname === '/') {
    url.pathname = '/welcome';
    url.search = '';
    return NextResponse.redirect(url);
  }
  url.pathname = '/login';
  url.searchParams.set('next', pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // Run on everything except Next internals and static assets.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
