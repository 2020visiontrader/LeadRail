// Meta (Facebook + Instagram) OAuth — "own the app" flow.
// The LeadRail-owned Meta developer app authorizes each account's Facebook Page
// (and any linked Instagram Business account). Tokens land in integration_connections
// via upsertConnection(provider='meta'), which meta.ts already reads.

const GRAPH = 'https://graph.facebook.com/v18.0';
const DIALOG = 'https://www.facebook.com/v18.0/dialog/oauth';

// FB Page posting + Instagram publishing. Dev-mode apps grant these to the app
// admin/testers without review. Trim the instagram_* pair if the consent screen
// errors before the Instagram product is configured.
// Each scope below is here because a shipped capability calls an edge that
// REQUIRES it. Adding a scope you do not call is a review liability; calling an
// edge whose scope you did not request is a runtime failure the user sees as
// "the integration is broken". Keep this list and lib/capabilities/social.ts in
// step.
const SCOPES = [
  // Pages: list, read engagement, publish, manage settings.
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'pages_manage_metadata',
  // Content OTHER PEOPLE post on the Page — their comments and their posts.
  // pages_read_engagement covers the Page's own content and aggregate
  // engagement; reading and moderating what visitors wrote needs this one.
  // Without it listSocialComments returns the Page's own replies and little
  // else, and hideSocialComment / deleteSocialComment — the entire moderation
  // job — fail on exactly the comments a moderator cares about.
  'pages_read_user_content',
  // Facebook Page DMs. `me/conversations` on a Page returns 400 without this —
  // listSocialMessages(platform:'facebook') cannot work otherwise.
  'pages_messaging',
  // Instagram: profile/media reads, publishing, DMs.
  'instagram_basic',
  'instagram_content_publish',
  'instagram_manage_messages',
  // Instagram comments. instagram_basic does NOT cover reading or writing
  // comments — listSocialComments / replyToSocialComment / hideSocialComment /
  // deleteSocialComment all fail on Instagram media without this.
  'instagram_manage_comments',
  // Ads. lib/social/meta-ads.ts calls me/adaccounts, /campaigns, /adsets, /ads
  // and /insights (ads_read), and setAdStatus + launchCampaign + pauseCampaign
  // write campaign status (ads_management). Neither was requested, so every ad
  // capability in the registry was unreachable regardless of connection state.
  'ads_read',
  'ads_management',
].join(',');

export function metaConfigured(): boolean {
  return Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET);
}

/** The address this deployment is reached at, used to build every OAuth
 *  redirect. APP_BASE_URL is authoritative; the fallback exists only so a
 *  deployment that forgot to set it lands somewhere recognisable rather than
 *  on a stale sandbox host.
 *
 *  A wrong value here fails LATE — after the user has signed in and approved —
 *  because the provider redirects to an address that is not this site. That is
 *  why the Connectors panel compares this against the browser's own origin and
 *  says so before anyone presses Connect, instead of leaving it to be
 *  discovered at the end of a handshake. */
export function publicBase(): string {
  return (process.env.APP_BASE_URL || 'https://app.leadrail.xyz').replace(/\/$/, '');
}

export function redirectUri(): string {
  return `${publicBase()}/api/social/meta/callback`;
}

// ---- signed state (CSRF + carries accountId across the redirect) ----
const enc = new TextEncoder();
function b64url(bytes: Uint8Array): string {
  let s = ''; for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s: string): Uint8Array {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  const bin = atob(s); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function hmacKey(): Promise<CryptoKey> {
  const secret = process.env.APP_SESSION_SECRET || 'dev-insecure-secret-change-me';
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signState(accountId: string): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ accountId, exp: Date.now() + 10 * 60 * 1000 })));
  const sig = b64url(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(), enc.encode(payload))));
  return `${payload}.${sig}`;
}

export async function verifyState(state?: string | null): Promise<{ accountId: string } | null> {
  if (!state || !state.includes('.')) return null;
  const [payload, sig] = state.split('.');
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(), fromB64url(sig) as unknown as BufferSource, enc.encode(payload));
    if (!ok) return null;
    const s = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as { accountId: string; exp: number };
    if (!s.exp || s.exp < Date.now()) return null;
    return { accountId: s.accountId };
  } catch { return null; }
}

// ---- OAuth steps ----
export function buildAuthorizeUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: process.env.META_APP_ID!,
    redirect_uri: redirectUri(),
    state,
    scope: SCOPES,
    response_type: 'code',
    // WHY THIS IS HERE: without it the dialog silently reuses whichever Facebook
    // session the browser already has, approves instantly, and returns the SAME
    // set of Pages — which is indistinguishable, from the user's side, from
    // "adding a second account does not work". Storage was never the problem
    // (rows are keyed by account+provider+external_id and several already
    // coexist); the consent screen simply never offered a choice. Forcing
    // re-authentication makes Meta ask WHICH account is connecting, which is the
    // only way to attach Pages the currently-logged-in user does not admin.
    //
    // Note for Instagram accounts with no linked Facebook Page: they cannot come
    // through this flow at all, whatever we pass here — they connect through
    // Instagram Business Login (/api/social/instagram/connect), which sets
    // force_reauth for the same reason.
    auth_type: 'reauthenticate',
  });
  return `${DIALOG}?${p.toString()}`;
}

export async function exchangeCodeForToken(code: string): Promise<string> {
  const p = new URLSearchParams({
    client_id: process.env.META_APP_ID!,
    client_secret: process.env.META_APP_SECRET!,
    redirect_uri: redirectUri(),
    code,
  });
  const res = await fetch(`${GRAPH}/oauth/access_token?${p.toString()}`);
  const json = await res.json();
  if (!res.ok || !json.access_token) throw new Error(`Meta code exchange failed: ${json?.error?.message || res.statusText}`);
  return json.access_token as string;
}

export async function getLongLivedToken(shortToken: string): Promise<string> {
  const p = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: process.env.META_APP_ID!,
    client_secret: process.env.META_APP_SECRET!,
    fb_exchange_token: shortToken,
  });
  const res = await fetch(`${GRAPH}/oauth/access_token?${p.toString()}`);
  const json = await res.json();
  if (!res.ok || !json.access_token) throw new Error(`Meta long-lived exchange failed: ${json?.error?.message || res.statusText}`);
  return json.access_token as string;
}

export interface MetaPage {
  id: string;
  name: string;
  access_token: string;
  ig_user_id?: string;
  ig_username?: string;
}

export async function getUserPages(userToken: string): Promise<MetaPage[]> {
  const url = `${GRAPH}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&access_token=${userToken}`;
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok) throw new Error(`Meta pages fetch failed: ${json?.error?.message || res.statusText}`);
  return (json.data || []).map((p: any) => ({
    id: p.id,
    name: p.name,
    access_token: p.access_token,
    ig_user_id: p.instagram_business_account?.id,
    ig_username: p.instagram_business_account?.username,
  }));
}

// App-scoped Facebook user id for the authorizing user. Stored on the connection
// so a later deauthorize/data-deletion signed_request (which carries only this id)
// can be mapped back to the right LeadRail account.
export async function getMeId(userToken: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${GRAPH}/me?fields=id&access_token=${userToken}`);
    const json = await res.json();
    return res.ok ? (json.id as string) : undefined;
  } catch {
    return undefined;
  }
}

// Meta signs deauthorize + data-deletion callbacks with `signed_request`:
//   `<base64url(sig)>.<base64url(payload)>`, sig = HMAC-SHA256(payload, APP_SECRET).
// Returns the decoded payload only if the signature verifies with our app secret.
export async function parseSignedRequest(
  signed: string,
): Promise<{ user_id?: string; issued_at?: number } | null> {
  if (!signed || !signed.includes('.')) return null;
  const secret = process.env.META_APP_SECRET;
  if (!secret) return null;
  const [sig, payload] = signed.split('.', 2);
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const ok = await crypto.subtle.verify(
      'HMAC',
      key,
      fromB64url(sig) as unknown as BufferSource,
      enc.encode(payload),
    );
    if (!ok) return null;
    const data = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    return { user_id: data.user_id, issued_at: data.issued_at };
  } catch {
    return null;
  }
}
