import { NextRequest, NextResponse } from 'next/server';

/**
 * Bearer-token guard for mutating/admin API routes.
 * If APP_API_SECRET is set, callers must send `Authorization: Bearer <secret>`.
 * If it is unset (local dev), the guard is a no-op so the app still runs.
 */
export function requireAuth(request: NextRequest): NextResponse | null {
  const secret = process.env.APP_API_SECRET;
  if (!secret) return null; // dev mode: no secret configured
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
