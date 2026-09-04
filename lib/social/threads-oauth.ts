import { publicBase, signState, verifyState } from './meta-oauth';

// Threads authorization goes through Threads' OWN authorize host, not Meta's
// facebook.com dialog — the two are different products with different
// consent screens and this one was wrong. Confirmed against multiple
// independent, mutually-corroborating sources (a Postman collection published
// by Meta, third-party developer guides, and an MCP server implementation) via
// web search — direct WebFetch to developers.facebook.com is blocked by this
// environment's egress proxy. See the PR description / audit report for the
// search evidence.
const TH_AUTH = 'https://threads.net/oauth/authorize';
const TH_TOKEN = 'https://graph.threads.net/oauth/access_token';
const TH_GRAPH = 'https://graph.threads.net/v1.0';

const TH_SCOPES = [
  'threads_basic',
  'threads_content_publish',
  'threads_manage_replies',
  'threads_manage_insights',
  'threads_read_replies',
  'threads_share_to_instagram',
].join(',');

export { signState, verifyState };

export function threadsConfigured(): boolean {
  return Boolean(process.env.THREADS_APP_ID && process.env.THREADS_APP_SECRET);
}

export function threadsRedirectUri(): string {
  return `${publicBase()}/api/social/threads/callback`;
}

export function buildThreadsAuthorizeUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: process.env.THREADS_APP_ID!,
    redirect_uri: threadsRedirectUri(),
    scope: TH_SCOPES,
    response_type: 'code',
    state,
  });
  return `${TH_AUTH}?${p.toString()}`;
}

export async function exchangeThreadsCode(code: string): Promise<{ token: string; userId: string }> {
  const form = new URLSearchParams({
    client_id: process.env.THREADS_APP_ID!,
    client_secret: process.env.THREADS_APP_SECRET!,
    grant_type: 'authorization_code',
    redirect_uri: threadsRedirectUri(),
    code,
  });
  const res = await fetch(TH_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(`Threads code exchange failed: ${json?.error_message || json?.error?.message || res.statusText}`);
  }
  return { token: String(json.access_token), userId: String(json.user_id ?? '') };
}

export async function getLongLivedThreadsToken(shortToken: string): Promise<string> {
  const p = new URLSearchParams({
    grant_type: 'th_exchange_token',
    client_secret: process.env.THREADS_APP_SECRET!,
    access_token: shortToken,
  });
  const res = await fetch(`${TH_GRAPH}/access_token?${p.toString()}`);
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(`Threads long-lived exchange failed: ${json?.error?.message || res.statusText}`);
  }
  return String(json.access_token);
}

export async function getThreadsProfile(token: string): Promise<{ id: string; username: string }> {
  const res = await fetch(`${TH_GRAPH}/me?fields=id,username,threads_profile_picture_url,threads_biography&access_token=${token}`);
  const json = await res.json();
  if (!res.ok) throw new Error(`Threads profile fetch failed: ${json?.error?.message || res.statusText}`);
  return { id: String(json.id ?? ''), username: json.username ?? '' };
}
