// TikTok OAuth (Login Kit v2, PKCE) + Content Posting API.
// Mirrors threads-oauth.ts for the CSRF/state shape; PKCE needs one extra piece
// (the code_verifier) that TikTok does not echo back, so it travels in a short-
// lived httpOnly cookie set by /connect and read by /callback — signState/
// verifyState from meta-oauth.ts still own the accountId + CSRF check.
//
// GOTCHA (see COPILOT_REMEDIATION_PLAN.md Packet 7.1): TikTok's Content Posting
// API requires app audit before DIRECT_POST is allowed. An unaudited app can
// only push videos to the creator's TikTok inbox as a draft, which the person
// must open the TikTok app to review and post themselves. publishTiktokDraft
// below builds that draft path; do not wire a "publish live" call until the
// app has passed audit for DIRECT_POST.

import { publicBase, verifyState as verifyMetaState, signState as signMetaState } from './meta-oauth';

const TT_AUTH = 'https://www.tiktok.com/v2/auth/authorize/';
const TT_TOKEN = 'https://open.tiktokapis.com/v2/oauth/token/';
const TT_USERINFO = 'https://open.tiktokapis.com/v2/user/info/';
const TT_INBOX_INIT = 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/';

// video.upload + video.publish grant the inbox/draft posting path used here.
// user.info.basic identifies the creator for the connection row.
const TT_SCOPES = ['user.info.basic', 'video.upload', 'video.publish'].join(',');

export const PKCE_COOKIE = 'tiktok_pkce_verifier';

export { signMetaState as signState, verifyMetaState as verifyState };

export function tiktokConfigured(): boolean {
  return Boolean(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET);
}

export function tiktokRedirectUri(): string {
  return `${publicBase()}/api/social/tiktok/callback`;
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

// TikTok has no `prompt=consent` equivalent documented; passing a fresh `state`
// each time and relying on TikTok's own re-auth prompt is the closest available
// behaviour. If a second account silently reuses the first (Instagram's
// force_reauth failure mode), TikTok's login screen must be tested live —
// noted, not verified, per the packet's instruction to say so rather than guess.
export function buildTiktokAuthorizeUrl(state: string, codeChallenge: string): string {
  const p = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY!,
    response_type: 'code',
    scope: TT_SCOPES,
    redirect_uri: tiktokRedirectUri(),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${TT_AUTH}?${p.toString()}`;
}

export async function exchangeTiktokCode(
  code: string,
  codeVerifier: string,
): Promise<{ token: string; refreshToken: string; openId: string; expiresIn: number }> {
  const form = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY!,
    client_secret: process.env.TIKTOK_CLIENT_SECRET!,
    code,
    grant_type: 'authorization_code',
    redirect_uri: tiktokRedirectUri(),
    code_verifier: codeVerifier,
  });
  const res = await fetch(TT_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: form.toString(),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(`TikTok code exchange failed: ${json?.error_description || json?.error || res.statusText}`);
  }
  return {
    token: String(json.access_token),
    refreshToken: String(json.refresh_token ?? ''),
    openId: String(json.open_id ?? ''),
    expiresIn: Number(json.expires_in ?? 0),
  };
}

export async function getTiktokProfile(token: string): Promise<{ id: string; username: string }> {
  const res = await fetch(`${TT_USERINFO}?fields=open_id,display_name`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  if (!res.ok || json?.error?.code !== 'ok') {
    throw new Error(`TikTok profile fetch failed: ${json?.error?.message || res.statusText}`);
  }
  const user = json.data?.user ?? {};
  return { id: String(user.open_id ?? ''), username: user.display_name ?? '' };
}

export interface TiktokDraft {
  videoUrl: string;
  title?: string;
}

/**
 * Push a video into the creator's TikTok inbox as a draft (PULL_FROM_URL).
 * This is NOT a live publish — the creator must open TikTok and post it
 * themselves. That is deliberate: DIRECT_POST requires app audit this app has
 * not passed. `videoUrl` must be on a domain TikTok has verified for this app.
 */
export async function publishTiktokDraft(token: string, draft: TiktokDraft) {
  const res = await fetch(TT_INBOX_INIT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify({
      source_info: {
        source: 'PULL_FROM_URL',
        video_url: draft.videoUrl,
      },
      post_info: draft.title ? { title: draft.title } : undefined,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.error?.code !== 'ok') {
    throw new Error(`TikTok draft push failed: ${json?.error?.message || res.statusText}`);
  }
  return json;
}
