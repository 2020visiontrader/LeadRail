import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { verifyState, exchangeCodeForToken, getLongLivedToken, getUserPages, getMeId, publicBase } from '@/lib/social/meta-oauth';
import { upsertConnection, dbReady } from '@/lib/db';
import { encryptTokenBundle } from '@/lib/social/connection-token';
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
    const fbUserId = await getMeId(userToken);
    const pages = await getUserPages(userToken);

    if (!pages.length) {
      return settings('error=meta_no_pages');
    }

    // Store EVERY Page the user admins as its own `facebook` row, and each linked
    // Instagram Business account as its own `instagram` row. Multi-account: a user
    // can manage several Pages/IGs — no overwrite (keyed by external_id).
    let igCount = 0;
    if (dbReady()) {
      for (const p of pages) {
        // Per-page association is external_id = p.id (this row IS that one
        // Page) — see the multi-page note in lib/social/connection-token.ts.
        // The row's two secrets (the Page token that publishes, and the
        // long-lived user token it was minted from) are encrypted together
        // into one secret_encrypted blob; `meta` keeps only non-secret,
        // display/lookup fields.
        await upsertConnection({
          account_id: verified.accountId,
          provider: 'facebook',
          external_id: p.id,
          display_name: p.name,
          status: 'connected',
          secret_ref: 'user-oauth:facebook',
          secret_encrypted: encryptTokenBundle({ access_token: p.access_token, user_token: userToken }),
          meta: {
            fb_user_id: fbUserId ?? null,
            page_id: p.id,
            page_name: p.name,
            ig_user_id: p.ig_user_id ?? null,
            ig_username: p.ig_username ?? null,
            connected_at: new Date().toISOString(),
          },
        });
        if (p.ig_user_id) {
          igCount++;
          await upsertConnection({
            account_id: verified.accountId,
            provider: 'instagram',
            external_id: p.ig_user_id,
            display_name: p.ig_username || 'Instagram',
            username: p.ig_username ?? null,
            status: 'connected',
            secret_ref: 'user-oauth:instagram',
            // The Page token also publishes to the linked IG account, so this
            // row carries the SAME page token as its `facebook` sibling
            // (they're two rows for two provider surfaces of one Page, not
            // two Pages) plus the same user token.
            secret_encrypted: encryptTokenBundle({ access_token: p.access_token, user_token: userToken }),
            meta: {
              fb_user_id: fbUserId ?? null,
              ig_user_id: p.ig_user_id,
              ig_username: p.ig_username ?? null,
              via_page_id: p.id,
              via_page_name: p.name,
              source: 'facebook_login',
              connected_at: new Date().toISOString(),
            },
          });
        }
      }
    }

    const first = pages[0];
    const ig = igCount ? `&ig=${igCount}` : '';
    return settings(`connected=facebook&page=${encodeURIComponent(first.name)}&pages=${pages.length}${ig}`);
  } catch (e: any) {
    return settings(`error=meta_exchange&detail=${encodeURIComponent(e?.message || 'unknown')}`);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/social/meta/callback", method: "GET" });
