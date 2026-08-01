import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { verifySession, SESSION_COOKIE } from '@/lib/session';
import { metaConfigured, signState, buildAuthorizeUrl, publicBase } from '@/lib/social/meta-oauth';
export const dynamic = "force-dynamic";

// Starts the Meta OAuth flow. Session-gated by middleware; we read the account
// from the verified session so the client can't spoof which account gets connected.
async function GET__impl(req: NextRequest) {
  const origin = publicBase();
  if (!metaConfigured()) {
    return NextResponse.redirect(`${origin}/settings?error=meta_not_configured`);
  }
  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.redirect(`${origin}/login?next=/settings`);
  }
  const state = await signState(session.accountId);
  return NextResponse.redirect(buildAuthorizeUrl(state));
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/social/meta/connect", method: "GET" });
