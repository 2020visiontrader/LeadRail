// Google Drive connector. Two auth paths, resolved in order:
//   1. A per-account OAuth access token stored on the connection row (user-connected).
//   2. GOOGLE_SERVICE_ACCOUNT_JSON — a service account we sign a JWT with and
//      exchange for an access token (owner/server-side; works out of the box).
// The verifier proves connectivity by listing one file. Same auth powers the
// agent's driveSearch tool.

import { createSign } from 'node:crypto';
import { getConnection } from '@/lib/db';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

// Cache the service-account token for its lifetime (minus a safety margin).
let saTokenCache: { token: string; exp: number } | null = null;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function serviceAccountToken(): Promise<string | null> {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  const now = Math.floor(Date.now() / 1000);
  if (saTokenCache && saTokenCache.exp - 60 > now) return saTokenCache.token;

  let sa: any;
  try { sa = JSON.parse(raw); } catch { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON'); }
  if (!sa.client_email || !sa.private_key) throw new Error('Service account JSON missing client_email/private_key');

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const signature = b64url(signer.sign(sa.private_key));
  const assertion = `${header}.${claim}.${signature}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error_description || json?.error || `Google token exchange failed (${res.status})`);
  saTokenCache = { token: json.access_token, exp: now + (Number(json.expires_in) || 3600) };
  return saTokenCache.token;
}

export async function resolveDriveToken(accountId?: string): Promise<string | null> {
  if (accountId) {
    try {
      const conn = await getConnection(accountId, 'google_drive');
      const t = conn?.meta?.access_token;
      if (t) return String(t);
    } catch { /* fall through */ }
  }
  return serviceAccountToken();
}

async function drive(path: string, token: string) {
  const res = await fetch(`${DRIVE_API}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || `Google Drive error (${res.status})`);
  return json;
}

export interface DriveVerifyResult {
  connected: boolean;
  via?: 'oauth' | 'service_account';
  sampleCount?: number;
  error?: string;
}

/** Prove connectivity by listing one file. Never throws — returns a status. */
export async function verifyGoogleDrive(accountId?: string): Promise<DriveVerifyResult> {
  let token: string | null = null;
  let via: 'oauth' | 'service_account' = 'service_account';
  try {
    if (accountId) {
      const conn = await getConnection(accountId, 'google_drive').catch(() => null);
      if (conn?.meta?.access_token) via = 'oauth';
    }
    token = await resolveDriveToken(accountId);
  } catch (e: any) {
    return { connected: false, error: e?.message || 'Google Drive auth failed' };
  }
  if (!token) return { connected: false, error: 'No Google Drive credentials — connect an account or set a service account.' };
  try {
    const json = await drive('files?pageSize=1&fields=files(id,name)', token);
    return { connected: true, via, sampleCount: (json.files || []).length };
  } catch (e: any) {
    return { connected: false, via, error: e?.message || 'Google Drive verification failed' };
  }
}

export interface DriveFile { id: string; name: string; mimeType: string; modifiedTime?: string; webViewLink?: string }

/** Search Drive files by name/full-text. */
export async function driveSearch(accountId: string, query: string, limit = 10): Promise<DriveFile[]> {
  const token = await resolveDriveToken(accountId);
  if (!token) throw new Error('Google Drive is not connected — connect it in Settings.');
  const q = `name contains '${query.replace(/'/g, "\\'")}' and trashed = false`;
  const json = await drive(
    `files?q=${encodeURIComponent(q)}&pageSize=${Math.min(limit, 50)}&fields=files(id,name,mimeType,modifiedTime,webViewLink)`,
    token,
  );
  return (json.files || []) as DriveFile[];
}

/** Export a Google Doc / read a plain file as text (best-effort, capped). */
export async function driveReadFileText(accountId: string, fileId: string, maxChars = 8000): Promise<string> {
  const token = await resolveDriveToken(accountId);
  if (!token) throw new Error('Google Drive is not connected.');
  const meta = await drive(`files/${fileId}?fields=mimeType,name`, token);
  const isGoogleDoc = String(meta.mimeType || '').startsWith('application/vnd.google-apps');
  const url = isGoogleDoc
    ? `${DRIVE_API}/files/${fileId}/export?mimeType=text/plain`
    : `${DRIVE_API}/files/${fileId}?alt=media`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Google Drive read failed (${res.status})`);
  const text = await res.text();
  return text.slice(0, maxChars);
}
