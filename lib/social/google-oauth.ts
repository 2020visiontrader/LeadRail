// Google OAuth for per-user Google Drive connections. Same shape as the Meta/IG
// flows: the user clicks Connect, authorizes THEIR Google account, and we store
// their access + refresh token per LeadRail account. Drive access tokens expire
// hourly, so we always request offline access (a refresh token) and refresh on
// demand in lib/integrations/gdrive.ts. Reuses the HMAC state helpers from meta-oauth.
import { publicBase, signState, verifyState } from './meta-oauth';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://www.googleapis.com/oauth2/v2/userinfo';
// Full `drive` scope, not `drive.readonly`. Per Google's own scope catalog
// (https://developers.google.com/workspace/drive/api/guides/api-specific-auth
// — confirmed 2026-09-04): `drive` is "See, edit, create, and delete all of
// your Google Drive files" and `drive.readonly` is "View and download all
// your Drive files" — `drive` is a strict superset, so requesting both is
// redundant (and Google's own scope picker treats the narrower one as
// subsumed). `drive.readonly` is deliberately NOT listed alongside it.
const DRIVE_SCOPE = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

export { signState, verifyState };

export function googleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function googleRedirectUri(): string {
  return `${publicBase()}/api/social/google-drive/callback`;
}

export function buildGoogleAuthorizeUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: googleRedirectUri(),
    response_type: 'code',
    scope: DRIVE_SCOPE,
    access_type: 'offline',      // → refresh token
    prompt: 'consent',           // force refresh token even on re-auth
    include_granted_scopes: 'true',
    state,
  });
  return `${GOOGLE_AUTH}?${p.toString()}`;
}

// `scope` is the space-separated set of scopes Google ACTUALLY granted for
// this token (echoed back on both the code exchange and, usually, a refresh —
// see refreshGoogleToken below). It can differ from what was requested if the
// user only approved part of the consent screen, so callers persist THIS
// value (never DRIVE_SCOPE) as the source of truth for what a stored
// connection can do — see requireDriveWriteToken in lib/integrations/gdrive.ts.
export interface GoogleTokens { accessToken: string; refreshToken?: string; expiresIn: number; scope?: string }

export async function exchangeGoogleCode(code: string): Promise<GoogleTokens> {
  const form = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    client_secret: process.env.GOOGLE_CLIENT_SECRET!,
    redirect_uri: googleRedirectUri(),
    grant_type: 'authorization_code',
    code,
  });
  const res = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(`Google code exchange failed: ${json?.error_description || json?.error || res.statusText}`);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresIn: Number(json.expires_in) || 3600,
    scope: typeof json.scope === 'string' ? json.scope : undefined,
  };
}

export async function refreshGoogleToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number; scope?: string }> {
  const form = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    client_secret: process.env.GOOGLE_CLIENT_SECRET!,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const res = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(`Google token refresh failed: ${json?.error_description || json?.error || res.statusText}`);
  }
  // Google's refresh response usually omits `scope` when it is unchanged from
  // the grant (per RFC 6749 §5.1: OPTIONAL "if identical to the scope
  // requested by the client"). Callers must NOT treat a missing scope here as
  // "downgraded to no scope" — see resolveDriveToken's meta merge, which keeps
  // the previously-stored scope when the refresh response doesn't carry one.
  return {
    accessToken: json.access_token,
    expiresIn: Number(json.expires_in) || 3600,
    scope: typeof json.scope === 'string' ? json.scope : undefined,
  };
}

export async function getGoogleEmail(accessToken: string): Promise<string> {
  try {
    const res = await fetch(GOOGLE_USERINFO, { headers: { Authorization: `Bearer ${accessToken}` } });
    const json = await res.json();
    return json?.email || 'Google account';
  } catch {
    return 'Google account';
  }
}
