// LinkedIn OAuth (OpenID Connect + Community Management API posting scope).
// Mirrors threads-oauth.ts. Tokens are 60-day and NOT silently refreshable —
// callers must store expires_at and surface expiry rather than let posts fail
// mysteriously later (see COPILOT_REMEDIATION_PLAN.md Packet 7.1).

import { publicBase, signState, verifyState } from './meta-oauth';

const LI_AUTH = 'https://www.linkedin.com/oauth/v2/authorization';
const LI_TOKEN = 'https://www.linkedin.com/oauth/v2/accessToken';
const LI_API = 'https://api.linkedin.com/v2';

// w_member_social: post as the authenticated member. openid/profile/email: identify
// the member and get a stable URN. Company-page posting needs an Organization ACL
// grant on top of this and a separate `author` URN — not built here (see header).
const LI_SCOPES = ['openid', 'profile', 'email', 'w_member_social'].join(' ');

export { signState, verifyState };

export function linkedinConfigured(): boolean {
  return Boolean(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET);
}

export function linkedinRedirectUri(): string {
  return `${publicBase()}/api/social/linkedin/callback`;
}

// prompt=consent forces LinkedIn to re-show the consent screen instead of
// silently reusing the last-granted session, mirroring Instagram's
// force_reauth=true — without it a second LinkedIn account cannot be added
// because LinkedIn silently returns the same member.
export function buildLinkedinAuthorizeUrl(state: string): string {
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.LINKEDIN_CLIENT_ID!,
    redirect_uri: linkedinRedirectUri(),
    scope: LI_SCOPES,
    state,
    prompt: 'consent',
  });
  return `${LI_AUTH}?${p.toString()}`;
}

export async function exchangeLinkedinCode(code: string): Promise<{ token: string; expiresIn: number }> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: linkedinRedirectUri(),
    client_id: process.env.LINKEDIN_CLIENT_ID!,
    client_secret: process.env.LINKEDIN_CLIENT_SECRET!,
  });
  const res = await fetch(LI_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(`LinkedIn code exchange failed: ${json?.error_description || json?.error || res.statusText}`);
  }
  return { token: String(json.access_token), expiresIn: Number(json.expires_in ?? 0) };
}

// LinkedIn tokens are already the "long-lived" (60-day) token from the initial
// exchange — there is no separate long-lived exchange step like Meta/Threads.
export async function getLinkedinProfile(token: string): Promise<{ id: string; name: string }> {
  const res = await fetch(`${LI_API}/userinfo`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`LinkedIn profile fetch failed: ${json?.message || res.statusText}`);
  // /userinfo (OIDC) returns `sub` as the member id; LinkedIn's post `author`
  // field wants it as `urn:li:person:<sub>`, which callers build themselves.
  return { id: String(json.sub ?? ''), name: json.name ?? '' };
}

export interface LinkedinPost {
  text: string;
  link?: string;
}

/** Publish a text (optionally link-share) post as the authenticated member. */
export async function publishLinkedinPost(token: string, memberId: string, post: LinkedinPost) {
  const author = `urn:li:person:${memberId}`;
  const body: Record<string, any> = {
    author,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text: post.text },
        shareMediaCategory: post.link ? 'ARTICLE' : 'NONE',
        ...(post.link
          ? { media: [{ status: 'READY', originalUrl: post.link }] }
          : {}),
      },
    },
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
  };
  const res = await fetch(`${LI_API}/ugcPosts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`LinkedIn publish failed: ${json?.message || res.statusText}`);
  return json;
}
