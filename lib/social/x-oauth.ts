// X (Twitter) OAuth 2.0 + PKCE, confidential client. Mirrors threads-oauth.ts
// for the CSRF/state shape; PKCE needs the code_verifier carried across the
// redirect the same way as TikTok — a short-lived httpOnly cookie, not a
// reimplementation of signState/verifyState.
//
// GOTCHA (see COPILOT_REMEDIATION_PLAN.md Packet 7.1): POST /2/tweets requires
// a paid X API tier (Free tier is read-only for posting purposes as of this
// writing). Confirm the connected app's plan before relying on
// publishXPost — an unpaid tier will fail at publish time with a 403 that
// does not say "upgrade your plan."

import { publicBase, verifyState as verifyMetaState, signState as signMetaState } from './meta-oauth';

const X_AUTH = 'https://twitter.com/i/oauth2/authorize';
const X_TOKEN = 'https://api.twitter.com/2/oauth2/token';
const X_API = 'https://api.twitter.com/2';

const X_SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'offline.access'].join(' ');

export const PKCE_COOKIE = 'x_pkce_verifier';

export { signMetaState as signState, verifyMetaState as verifyState };

export function xConfigured(): boolean {
  return Boolean(process.env.X_CLIENT_ID && process.env.X_CLIENT_SECRET);
}

export function xRedirectUri(): string {
  return `${publicBase()}/api/social/x/callback`;
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}

export async function codeChallengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

// X's OAuth2 authorize endpoint does not document a `prompt=consent` /
// force-reauth parameter the way Meta and (hopefully) LinkedIn do. Adding a
// second X account may silently reuse the browser's existing X session
// instead of prompting for credentials. Untested against live X — noted per
// the packet's instruction, not assumed away.
export function buildXAuthorizeUrl(state: string, codeChallenge: string): string {
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.X_CLIENT_ID!,
    redirect_uri: xRedirectUri(),
    scope: X_SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${X_AUTH}?${p.toString()}`;
}

function basicAuthHeader(): string {
  const raw = `${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(raw).toString('base64')}`;
}

export async function exchangeXCode(
  code: string,
  codeVerifier: string,
): Promise<{ token: string; refreshToken: string; expiresIn: number }> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: xRedirectUri(),
    code_verifier: codeVerifier,
  });
  const res = await fetch(X_TOKEN, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuthHeader(),
    },
    body: form.toString(),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(`X code exchange failed: ${json?.error_description || json?.error || res.statusText}`);
  }
  return {
    token: String(json.access_token),
    refreshToken: String(json.refresh_token ?? ''),
    expiresIn: Number(json.expires_in ?? 0),
  };
}

export async function getXProfile(token: string): Promise<{ id: string; username: string }> {
  const res = await fetch(`${X_API}/users/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`X profile fetch failed: ${json?.detail || json?.title || res.statusText}`);
  return { id: String(json.data?.id ?? ''), username: json.data?.username ?? '' };
}

/** Publish a text post, or (with replyToTweetId) reply to an existing one.
 *  Same endpoint either way — X models a reply as an ordinary POST /2/tweets
 *  carrying `reply.in_reply_to_tweet_id`, not a separate reply call. Requires
 *  a paid X API tier — see header note. */
export async function publishXPost(token: string, text: string, replyToTweetId?: string) {
  const body: Record<string, any> = { text };
  if (replyToTweetId) body.reply = { in_reply_to_tweet_id: replyToTweetId };
  const res = await fetch(`${X_API}/tweets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`X publish failed: ${json?.detail || json?.title || res.statusText}`);
  return json;
}

/** List replies to a tweet (the "conversation") via recent search filtered to
 *  its conversation_id, newest first. Reading tweets — unlike posting them —
 *  is only available on X API tiers above the pay-per-use default (Basic and
 *  up as of this writing); a 403/429 here is surfaced with that context rather
 *  than a bare HTTP error, since X's own error body does not name the tier. */
export async function listXReplies(token: string, tweetId: string, limit = 25) {
  const p = new URLSearchParams({
    query: `conversation_id:${tweetId} is:reply`,
    max_results: String(Math.min(Math.max(limit, 10), 100)),
    'tweet.fields': 'author_id,created_at,in_reply_to_user_id,public_metrics,conversation_id',
  });
  const res = await fetch(`${X_API}/tweets/search/recent?${p.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json?.detail || json?.title || res.statusText;
    if (res.status === 403 || res.status === 429) {
      throw new Error(`X replies error (${res.status}): ${detail} — reading replies needs an X API tier above the free/pay-per-use default (Basic or higher).`);
    }
    throw new Error(`X replies error (${res.status}): ${detail}`);
  }
  return json.data || [];
}

/** Delete a tweet. X only lets an app delete tweets posted BY the authenticated
 *  user — there is no API to delete or moderate someone else's reply, so this
 *  is not a substitute for Meta-style comment moderation. Call sites must make
 *  that limitation explicit rather than presenting this as "delete a comment". */
export async function deleteXTweet(token: string, tweetId: string) {
  const res = await fetch(`${X_API}/tweets/${tweetId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`X delete failed (${res.status}): ${json?.detail || json?.title || res.statusText}`);
  return json;
}
