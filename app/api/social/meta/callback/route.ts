import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { verifyState, exchangeCodeForToken, getLongLivedToken, getUserPages, publicBase } from '@/lib/social/meta-oauth';
import { upsertConnection, dbReady } from '@/lib/db';
export const dynamic = "force-dynamic";

// Meta redirects the user's browser here after they approve. This route is listed
// in PUBLIC_API (middleware) because identity comes from the signed `state`, not
// the session cookie — standard OAuth callback pattern.
async function GET__impl(req: NextRequest) {
  const origin = publicBase();
  const settings = (q: string) => NextResponse.redirect(`${origin}/settings?${q}`);

  const err = req.nextUrl.searchParams.get('error');
  if (err) {
    const reason = req.nextUrl.searchParams.get('error_description') || err;
    return settings(`error=meta_denied&detail=${encodeURIComponent(reason)}`);
  }

  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  const verified = await verifyState(state);
  if (!code || !verified) return settings('error=meta_bad_state');

  try {
    const shortToken = await exchangeCodeForToken(code);
    const userToken = await getLongLivedToken(shortToken);
    const pages = await getUserPages(userToken);

    if (!pages.length) {
      return settings('error=meta_no_pages');
    }
    // Active page = first returned. Full list kept so we can add a page picker later.
    const active = pages[0];

    if (dbReady()) {
      await upsertConnection({
        account_id: verified.accountId,
        provider: 'meta',
        status: 'connected',
        meta: {
          access_token: active.access_token, // Page token — used for FB + IG publish
          user_token: userToken,
          page_id: active.id,
          page_name: active.name,
          ig_user_id: active.ig_user_id ?? null,
          ig_username: active.ig_username ?? null,
          pages: pages.map((p) => ({ id: p.id, name: p.name, ig_user_id: p.ig_user_id ?? null })),
          connected_at: new Date().toISOString(),
        },
      });
    }

    const ig = active.ig_user_id ? `&ig=${encodeURIComponent(active.ig_username || 'linked')}` : '';
    return settings(`connected=meta&page=${encodeURIComponent(active.name)}${ig}`);
  } catch (e: any) {
    return settings(`error=meta_exchange&detail=${encodeURIComponent(e?.message || 'unknown')}`);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/social/meta/callback", method: "GET" });
