import { NextRequest, NextResponse } from 'next/server';
import { verifySession, SESSION_COOKIE } from '@/lib/session';

// Public paths that never require a session.
const PUBLIC_PAGES = ['/login', '/privacy', '/terms', '/data-deletion'];
const PUBLIC_API = ['/api/auth/login', '/api/webhooks', '/api/hermes/tick', '/api/social/meta/callback'];

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
