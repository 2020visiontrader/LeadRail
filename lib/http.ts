import { NextRequest, NextResponse } from 'next/server';
import { verifySession, SESSION_COOKIE, type Session } from '@/lib/session';

/**
 * Session guard for user-facing API routes.
 * Reads the signed session cookie and returns the caller's session, or a 401.
 * Routes MUST derive account_id/brand ownership from `session`, never from the
 * client-supplied body or query, to prevent cross-tenant access.
 */
export async function requireSession(
  request: NextRequest,
): Promise<{ session: Session; error?: undefined } | { session?: undefined; error: NextResponse }> {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySession(token);
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  return { session };
}

/**
 * Bearer-token guard for machine-to-machine routes (cron, internal callers).
 * If APP_API_SECRET is set, callers must send `Authorization: Bearer <secret>`.
 * Fails closed in production when the secret is unset; no-op only in local dev.
 */
export function requireAuth(request: NextRequest): NextResponse | null {
  const secret = process.env.APP_API_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json({ error: 'Server auth not configured' }, { status: 503 });
    }
    return null; // dev mode: no secret configured
  }
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token || token !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

/** Sanitized error response: log the real error, return a generic message + code. */
export function errorResponse(error: unknown, status = 500, publicMessage = 'Internal error') {
  console.error('[api-error]', error instanceof Error ? error.message : error);
  return NextResponse.json({ error: publicMessage }, { status });
}

export function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}
