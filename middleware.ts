import { NextRequest, NextResponse } from 'next/server';
import { verifySession, SESSION_COOKIE } from '@/lib/session';

// Public paths that never require a session.
// '/r/' is the ambassador capture link — clicked by logged-out strangers, so it
// must be public. The trailing slash keeps it from matching the authed
// '/referrals' portal (which stays gated).
// '/welcome' is the public landing page (Packet 11.2) — the first thing a
// logged-out stranger sees. '/robots.txt', '/sitemap.xml' and '/llms.txt' are
// its crawler-facing artifacts; the matcher below does not exclude them, so
// without this they would redirect a crawler to /login and the page would be
// unindexable. All four are public *by definition* — they contain no account
// data and read nothing from a session.
// '/signup' is public for the same reason '/login' is: it is where a visitor
// goes BEFORE they have a session. Omitting it made the middleware redirect it
// to /login, so the page shipped and was unreachable — a build and a green test
// suite both pass in that state, because neither exercises middleware.
const PUBLIC_PAGES = ['/login', '/signup', '/privacy', '/terms', '/data-deletion', '/r/', '/welcome', '/robots.txt', '/sitemap.xml', '/llms.txt'];
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
// '/api/auth/signup' and '/api/contact' are unauthenticated BY DESIGN — they are
// how someone with no account reaches us. Both enforce their own protection
// (IP rate limiting, and signup additionally behind SIGNUPS_OPEN), so "public to
// the cookie middleware" is not "unprotected".
const PUBLIC_API = ['/api/auth/login', '/api/auth/signup', '/api/contact', '/api/webhooks', '/api/hermes/tick', '/api/mcp', '/api/public', '/api/social/meta/callback', '/api/social/meta/connect', '/api/social/meta/deauthorize', '/api/social/meta/data-deletion', '/api/social/instagram/callback', '/api/track', '/api/unsubscribe',
  // Identity comes from the single-use `state` row, not a cookie — a
  // third-party redirect cannot be relied on to carry ours (SameSite).
  '/api/mcp-clients/oauth/callback'];

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
  // Packet 11.2: the ROOT path only. A logged-out stranger typing the domain
  // gets the landing page instead of a bare login form. No `next` param — there
  // is nothing to bounce back to, and '/' is where /login already lands.
  // Every OTHER private route keeps the existing behaviour below, unchanged.
  // Packet 11.2: the ROOT path only. A logged-out visitor gets the landing page
  // instead of a bare login form; /login stays one click away from it.
  //
  // Deliberately host-BLIND. leadrail.xyz redirects to app.leadrail.xyz at the
  // DNS layer, so there is one origin serving both jobs — a host-aware split
  // here would send app.leadrail.xyz/ to /login and make the landing page
  // unreachable. (An earlier version did exactly that; do not re-add it unless
  // the two hostnames are genuinely served as separate origins.)
  //
  // Every OTHER private route keeps the /login behaviour below, with its `next`.
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
