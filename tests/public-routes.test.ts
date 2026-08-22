// tests/public-routes.test.ts — pre-auth surfaces must actually be reachable.
//
// /signup shipped, built cleanly, and passed the whole suite while being
// UNREACHABLE: it was not in middleware's PUBLIC_PAGES, so every request to it
// redirected to /login. Neither a production build nor a route unit test
// exercises middleware, so nothing caught it — only loading the deployed URL
// did, and it returned 307.
//
// The failure mode is what makes it worth a standing test: a pre-auth page that
// redirects to login looks like a working auth guard, not like a broken page.
// Nothing errors. It just quietly cannot be used.
//
// These assert the ROUTING RULE, not a hardcoded list, so adding another
// pre-auth page keeps them honest.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'middleware.ts'), 'utf8');

function listFrom(name: string): string[] {
  const m = src.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
  if (!m) throw new Error(`${name} not found in middleware.ts`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}
const PUBLIC_PAGES = listFrom('PUBLIC_PAGES');
const PUBLIC_API = listFrom('PUBLIC_API');

/** The boundary-aware match middleware uses. Reimplemented rather than imported
 *  because middleware.ts pulls in the Next runtime; the RULE is what matters and
 *  it is three lines. */
function isPublic(pathname: string): boolean {
  const list = pathname.startsWith('/api') ? PUBLIC_API : PUBLIC_PAGES;
  return list.some((p) => {
    const base = p.endsWith('/') ? p.slice(0, -1) : p;
    return pathname === base || pathname.startsWith(base + '/');
  });
}

describe('every pre-auth surface is reachable without a session', () => {
  it.each([
    ['/login', 'the sign-in page'],
    ['/signup', 'account creation — was redirecting to /login'],
    ['/welcome', 'the landing page'],
    ['/privacy', 'legally required, must be crawlable'],
    ['/terms', 'legally required, must be crawlable'],
    ['/data-deletion', 'required by Meta app review'],
  ])('%s is public (%s)', (path) => {
    expect(isPublic(path)).toBe(true);
  });

  it.each([
    ['/api/auth/login', 'sign in'],
    ['/api/auth/signup', 'create an account with no session'],
    ['/api/contact', 'the marketing site contact form'],
  ])('%s is public (%s)', (path) => {
    expect(isPublic(path)).toBe(true);
  });
});

describe('the pre-auth surface has not widened by accident', () => {
  it.each([
    '/', '/leads', '/campaigns', '/settings', '/admin', '/assistant',
  ])('%s still requires a session', (path) => {
    expect(isPublic(path)).toBe(false);
  });

  it.each([
    ['/api/leads', 'tenant data'],
    ['/api/agent', 'runs capabilities'],
    ['/api/admin/ai-probe', 'owner-only diagnostics'],
    ['/api/skills/sync', 'rewrites the shared catalog'],
    ['/api/auth/me', 'session identity'],
  ])('%s still requires a session (%s)', (path) => {
    expect(isPublic(path)).toBe(false);
  });

  it('a public prefix never swallows a sibling route', () => {
    // The regression this encodes: a bare startsWith let '/api/mcp' whitelist
    // '/api/mcp-clients', which stores encrypted auth headers. That was an auth
    // bypass, and the boundary check is the only thing preventing it.
    expect(isPublic('/api/mcp')).toBe(true);
    expect(isPublic('/api/mcp-clients')).toBe(false);
    expect(isPublic('/api/auth/login')).toBe(true);
    expect(isPublic('/api/auth/login-as-admin')).toBe(false);
  });

  it('public API entries are all genuinely pre-auth or self-protecting', () => {
    // A tripwire on the list itself: every entry must be one we can name a
    // reason for. Adding a route here should require editing this test, which
    // is the point — it makes widening the public surface deliberate.
    const KNOWN = new Set([
      '/api/auth/login', '/api/auth/signup', '/api/contact', '/api/webhooks',
      '/api/hermes/tick', '/api/mcp', '/api/public', '/api/social/meta/callback',
      '/api/social/meta/connect', '/api/social/meta/deauthorize',
      '/api/social/meta/data-deletion', '/api/social/instagram/callback',
      '/api/track', '/api/unsubscribe',
    ]);
    expect(PUBLIC_API.filter((p) => !KNOWN.has(p))).toEqual([]);
  });
});
