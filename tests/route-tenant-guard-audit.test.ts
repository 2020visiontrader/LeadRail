// tests/route-tenant-guard-audit.test.ts — every API route must defend itself.
//
// The defect this guards against: GET /api/brands read every tenant's active
// brands with no session read and no account_id filter, and GET
// /api/content/export exported whatever brandId arrived in the query string
// with no ownership check — both behind nothing but the login cookie, so ANY
// authenticated user could read another tenant's data. Neither had an
// in-app caller. middleware.ts's PUBLIC_API list stops a stranger with no
// cookie at all, but it says nothing about a route leaking data ACROSS
// tenants once any cookie is present — that gap is what let both routes
// ship. This test closes it structurally: every route.ts under app/api must
// itself call a recognized auth guard, or be named on a small, justified
// allowlist. A route that is public (or unscoped) by accident can no longer
// ship silently — it has to either add a guard or edit this file to say why
// it doesn't need one.
//
// This intentionally does NOT verify that a route scopes its DB queries by
// account_id (a static grep can't tell a correct filter from a decorative
// one) — that is the job of route-specific tests such as
// tests/brands-route.test.ts and tests/content-export-route.test.ts. This
// test verifies the cheaper, structural precondition: every route has SOME
// caller-identity check in it, so it has the accountId available to scope
// with in the first place.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fg from 'fast-glob';

const ROOT = process.cwd();

// Any one of these appearing in a route file counts as "this route checks who
// is calling it before it does anything tenant-sensitive". Names come from
// what the codebase actually uses today (grep-verified), not an assumed list:
//  - requireSession / requireAuth: lib/http.ts's own guards.
//  - verifySession: called directly by routes that need the session object
//    before withApi's wrapper would (auth/me, and every social/email OAuth
//    "connect" endpoint that must sign the outbound state with accountId).
//  - verifyState: the paired OAuth "callback" endpoints. No cookie is
//    trusted on a third-party redirect (SameSite) — identity comes from a
//    signed, single-use state value instead. Same trust model, different
//    shape.
//  - verifyTrack: /api/track/* and /api/unsubscribe/*'s signed per-recipient
//    token — the equivalent of verifyState for email links.
//  - parseSignedRequest: Meta's signed_request payload (deauthorize /
//    data-deletion callbacks) — HMAC'd by META_APP_SECRET.
//  - resolveMcpKey: /api/mcp's own bearer-token lookup (per-key or the
//    legacy shared secret), independent of the cookie session entirely.
const GUARD_PATTERN =
  /\b(requireSession|requireAuth|verifySession|verifyState|verifyTrack|parseSignedRequest|resolveMcpKey)\b/;

// Genuinely public routes: reachable with NO cookie and no equivalent guard
// function, because they ARE the thing that establishes identity, or they
// verify a third-party signature/shared-secret inline instead of via one of
// the named guards above. Each line is a route file plus why. Kept in sync
// with middleware.ts's PUBLIC_API list, which enforces the same boundary at
// the cookie layer — this list is the route-level mirror of it.
const PUBLIC_ALLOWLIST: Record<string, string> = {
  'app/api/auth/login/route.ts': 'establishes the session — cannot require one',
  'app/api/auth/signup/route.ts': 'establishes the session — cannot require one; self-rate-limited',
  'app/api/contact/route.ts': 'marketing-site contact form for logged-out visitors; IP rate-limited',
  'app/api/webhooks/brevo/route.ts': 'provider webhook; verified via shared ?token= secret',
  'app/api/webhooks/resend/route.ts': 'provider webhook; verified via Svix HMAC signature',
  'app/api/webhooks/postiz/route.ts': 'provider webhook; verified via x-postiz-secret shared header',
  'app/api/webhooks/meta/route.ts': 'provider webhook; verified via Meta signature / verify token',
  'app/api/webhooks/inbound-email/route.ts': 'inbound-mail webhook; verified via shared secret header',
  'app/api/hermes/tick/route.ts': 'cron tick; bearer-protected via requireAuth (matched by GUARD_PATTERN, listed for completeness)',
  'app/api/mcp/route.ts': 'MCP JSON-RPC transport; own bearer/per-key auth via resolveMcpKey (matched by GUARD_PATTERN, listed for completeness)',
  'app/api/public/forms/[id]/submit/route.ts':
    'intentional public embed target; submitForm() derives account_id from the form row, never from the request',
  'app/api/social/meta/callback/route.ts': 'OAuth redirect target; identity from signed state (verifyState, matched already)',
  'app/api/social/meta/connect/route.ts': 'browser-navigated OAuth kickoff; self-redirects to /login when unauthenticated (verifySession, matched already)',
  'app/api/social/meta/deauthorize/route.ts': "Meta's deauthorize callback; identity from signed_request (parseSignedRequest, matched already)",
  'app/api/social/meta/data-deletion/route.ts': "Meta's data-deletion callback; identity from signed_request (parseSignedRequest, matched already)",
  'app/api/social/instagram/callback/route.ts': 'OAuth redirect target; identity from signed state (verifyState, matched already)',
  'app/api/mcp-clients/oauth/callback/route.ts':
    'third-party authorization redirect; identity from single-use consumeAuthState, not a cookie (SameSite) — no session, no verifyState-named call',
};

const routeFiles = fg.sync('app/api/**/route.ts', { cwd: ROOT }).sort();

describe('every API route either checks who is calling it, or is on the public allowlist', () => {
  it('found route files to audit (sanity check the glob itself)', () => {
    expect(routeFiles.length).toBeGreaterThan(150);
  });

  it.each(routeFiles)('%s', (rel) => {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    const guarded = GUARD_PATTERN.test(src);
    const allowed = Object.prototype.hasOwnProperty.call(PUBLIC_ALLOWLIST, rel);
    expect(
      guarded || allowed,
      `${rel} calls no recognized auth guard (${GUARD_PATTERN.source}) and is not on PUBLIC_ALLOWLIST. ` +
        `If it is genuinely public, add it to PUBLIC_ALLOWLIST with a one-line reason. ` +
        `Otherwise it needs requireSession (or an equivalent guard) before it touches any account-scoped data.`,
    ).toBe(true);
  });

  it('every allowlist entry names a route file that actually exists', () => {
    for (const rel of Object.keys(PUBLIC_ALLOWLIST)) {
      expect(routeFiles, `${rel} is on PUBLIC_ALLOWLIST but no such route file exists`).toContain(rel);
    }
  });

  it('the allowlist has not silently grown beyond what is justified today', () => {
    // A tripwire on the list itself, mirroring tests/public-routes.test.ts's
    // "public API entries are all genuinely pre-auth or self-protecting"
    // check. Adding an entry here should mean editing this test, which is
    // the point: it makes widening the guard-free surface deliberate, not
    // incidental to "the audit test happened to pass".
    expect(Object.keys(PUBLIC_ALLOWLIST).length).toBeLessThanOrEqual(20);
  });
});
