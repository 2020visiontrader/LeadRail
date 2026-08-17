// Instagram Login OAuth — "Instagram API with Instagram Login". Lets a user
// authorize ANY Instagram Business/Creator account directly (no Facebook Page
// required), so they can add several independent IG accounts. Uses the app's
// Instagram app credentials (INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET), which are
// separate from the Facebook app id. Reuses the HMAC state helpers from meta-oauth.
import { publicBase, signState, verifyState } from './meta-oauth';

const IG_AUTH = 'https://www.instagram.com/oauth/authorize';
const IG_TOKEN = 'https://api.instagram.com/oauth/access_token';
const IG_GRAPH = 'https://graph.instagram.com';

const IG_SCOPES = [
  'instagram_business_basic',
  'instagram_business_content_publish',
  'instagram_business_manage_comments',
  'instagram_business_manage_insights',
].join(',');

export { signState, verifyState };

export function instagramConfigured(): boolean {
  return Boolean(process.env.INSTAGRAM_APP_ID && process.env.INSTAGRAM_APP_SECRET);
}

export function igRedirectUri(): string {
  return `${publicBase()}/api/social/instagram/callback`;
}

/**
 * Build the Instagram Business Login URL.
 *
 * MULTI-ACCOUNT: connections are stored one row per IG account, keyed by
 * external_id (see the callback), so the store has never been the limit. The
 * limit was here — without `force_reauth`, Meta silently reuses the browser's
 * existing Instagram session and returns the SAME account every time, so a user
 * with six accounts could connect one and every subsequent attempt appeared to
 * do nothing. `force_reauth=true` makes Meta show the login / account chooser,
 * which is the only way the user can pick a different account to add.
 */
export function buildInstagramAuthorizeUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: process.env.INSTAGRAM_APP_ID!,
    redirect_uri: igRedirectUri(),
    scope: IG_SCOPES,
    response_type: 'code',
    // Always re-prompt. Costs one extra tap when re-connecting the same
    // account; without it, adding a second account is impossible.
    force_reauth: 'true',
    state,
  });
  return `${IG_AUTH}?${p.toString()}`;
}

export async function exchangeIgCode(code: string): Promise<{ token: string; userId: string }> {
  const form = new URLSearchParams({
    client_id: process.env.INSTAGRAM_APP_ID!,
    client_secret: process.env.INSTAGRAM_APP_SECRET!,
    grant_type: 'authorization_code',
    redirect_uri: igRedirectUri(),
    code,
  });
  const res = await fetch(IG_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(`IG code exchange failed: ${json?.error_message || json?.error?.message || res.statusText}`);
  }
  return { token: String(json.access_token), userId: String(json.user_id ?? '') };
}

export async function getLongLivedIgToken(shortToken: string): Promise<string> {
  const p = new URLSearchParams({
    grant_type: 'ig_exchange_token',
    client_secret: process.env.INSTAGRAM_APP_SECRET!,
    access_token: shortToken,
  });
  const res = await fetch(`${IG_GRAPH}/access_token?${p.toString()}`);
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(`IG long-lived exchange failed: ${json?.error?.message || res.statusText}`);
  }
  return String(json.access_token);
}

export async function getIgProfile(token: string): Promise<{ id: string; username: string }> {
  const res = await fetch(`${IG_GRAPH}/me?fields=user_id,username&access_token=${token}`);
  const json = await res.json();
  if (!res.ok) throw new Error(`IG profile fetch failed: ${json?.error?.message || res.statusText}`);
  return { id: String(json.user_id ?? json.id ?? ''), username: json.username ?? '' };
}
