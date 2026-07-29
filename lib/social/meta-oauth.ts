// Meta (Facebook + Instagram) OAuth — "own the app" flow.
// The LeadRail-owned Meta developer app authorizes each account's Facebook Page
// (and any linked Instagram Business account). Tokens land in integration_connections
// via upsertConnection(provider='meta'), which meta.ts already reads.

const GRAPH = 'https://graph.facebook.com/v18.0';
const DIALOG = 'https://www.facebook.com/v18.0/dialog/oauth';

// FB Page posting + Instagram publishing. Dev-mode apps grant these to the app
// admin/testers without review. Trim the instagram_* pair if the consent screen
// errors before the Instagram product is configured.
const SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'instagram_basic',
  'instagram_content_publish',
].join(',');

export function metaConfigured(): boolean {
  return Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET);
}

export function publicBase(): string {
  return (process.env.APP_BASE_URL || 'https://leadrail-crm-aifranckie.zocomputer.io').replace(/\/$/, '');
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
