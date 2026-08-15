// Google OAuth for per-user Google Drive connections. Same shape as the Meta/IG
// flows: the user clicks Connect, authorizes THEIR Google account, and we store
// their access + refresh token per LeadRail account. Drive access tokens expire
// hourly, so we always request offline access (a refresh token) and refresh on
// demand in lib/integrations/gdrive.ts. Reuses the HMAC state helpers from meta-oauth.
import { publicBase, signState, verifyState } from './meta-oauth';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://www.googleapis.com/oauth2/v2/userinfo';
const DRIVE_SCOPE = [
  'https://www.googleapis.com/auth/drive.readonly',
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

export interface GoogleTokens { accessToken: string; refreshToken?: string; expiresIn: number }

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
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresIn: Number(json.expires_in) || 3600 };
}

export async function refreshGoogleToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
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
  return { accessToken: json.access_token, expiresIn: Number(json.expires_in) || 3600 };
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
