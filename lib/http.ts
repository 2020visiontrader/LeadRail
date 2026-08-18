import { NextRequest, NextResponse } from 'next/server';
import { verifySession, SESSION_COOKIE, type Session } from '@/lib/session';
import { log, requestStore, enrichContext, currentContext, type RequestContext } from '@/lib/logger';

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
  // Attribute all subsequent logs on this request to the authenticated caller.
  enrichContext({ actorEmail: session.email, accountId: session.accountId });
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

/**
 * Sanitized error response: persist the real error (with stack + request
 * context) to app_logs, return a generic message + a request_id the caller can
 * quote so a user-reported failure maps to an exact log row.
 */
export function errorResponse(error: unknown, status = 500, publicMessage = 'Internal error') {
  const ctx = currentContext();
  log.error(publicMessage, error, { httpStatus: status });
  return NextResponse.json(
    { error: publicMessage, ...(ctx?.requestId ? { request_id: ctx.requestId } : {}) },
    { status },
  );
}

export function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * Wrap a Next.js route handler so EVERY invocation is logged: a request_id +
 * route/method/actor context is established for the whole handler, the
 * completion line (status + latency) is recorded, and any uncaught throw is
 * captured and converted to a sanitized 500. Applied to all route exports.
 */
type RouteHandler = (request: NextRequest, ctx?: any) => Promise<Response> | Response;

export function withApi(handler: RouteHandler, meta: { route: string; method: string }): RouteHandler {
  return async (request: NextRequest, routeCtx?: any) => {
    const store: RequestContext = {
      requestId:
        (globalThis.crypto?.randomUUID?.() as string) ||
        `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      route: meta.route,
      method: meta.method,
    };
    const start = Date.now();
    return requestStore.run(store, async () => {
      try {
        const res = await handler(request, routeCtx);
        store.status = res.status;
        store.durationMs = Date.now() - start;
        // 5xx is ours and is an error; 4xx is a rejected request and is a
        // warning worth surfacing (401 on a webhook = dropped inbound events).
        // Anything else is routine info.
        const level = res.status >= 500 ? 'error' : res.status >= 400 ? 'warn' : 'info';
        log.request({ message: `${meta.method} ${meta.route} → ${res.status}` }, level);
        return res;
      } catch (err) {
        // A handler without its own try/catch would otherwise 500 silently.
        store.durationMs = Date.now() - start;
        return errorResponse(err);
      }
    });
  };
}
