// Google Drive connector. Two auth paths, resolved in order:
//   1. A per-account OAuth access token stored on the connection row (user-connected).
//   2. GOOGLE_SERVICE_ACCOUNT_JSON — a service account we sign a JWT with and
//      exchange for an access token (owner/server-side; works out of the box).
// The verifier proves connectivity by listing one file. Same auth powers the
// agent's driveSearch tool.

import { createSign } from 'node:crypto';
import { getConnection, upsertConnection } from '@/lib/db';
import { refreshGoogleToken } from '@/lib/social/google-oauth';
import { resolveTokensForRow, encryptTokenBundle, stripTokenKeys } from '@/lib/social/connection-token';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Full scope, matching DRIVE_SCOPE in lib/social/google-oauth.ts (see that
// file's comment: `drive` supersedes `drive.readonly`, confirmed against
// Google's own scope catalog). The service account is server-owned — there is
// no separate "reconnect to widen" step for it, so it goes straight to full
// access.
const SCOPE = 'https://www.googleapis.com/auth/drive';

// Cache the service-account token for its lifetime (minus a safety margin).
let saTokenCache: { token: string; exp: number } | null = null;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function readServiceAccountJson(): string | null {
  // Prefer the base64 form: some hosts (e.g. process-supervisor env vars)
  // reject values containing raw newlines, which a PEM private_key needs.
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64;
  if (b64) return Buffer.from(b64, 'base64').toString('utf8');
  return process.env.GOOGLE_SERVICE_ACCOUNT_JSON || null;
}

async function serviceAccountToken(): Promise<string | null> {
  const raw = readServiceAccountJson();
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

// Per-user OAuth connection wins; refresh the access token when it's expired
// (or within 60s of it) using the stored refresh token, and persist the new one.
export async function resolveDriveToken(accountId?: string): Promise<string | null> {
  if (accountId) {
    try {
      const conn = await getConnection(accountId, 'google_drive');
      if (conn) {
        const { accessToken, refreshToken } = await resolveTokensForRow(conn);
        if (accessToken) {
          const expiry = Number(conn.meta?.expiry_ms) || 0;
          if (refreshToken && expiry && expiry - 60_000 < Date.now()) {
            try {
              const t = await refreshGoogleToken(refreshToken);
              await upsertConnection({
                account_id: conn.account_id,
                provider: 'google_drive',
                external_id: conn.external_id,
                display_name: conn.display_name,
                username: conn.username,
                status: 'connected',
                secret_ref: conn.secret_ref || 'user-oauth:google_drive',
                secret_encrypted: encryptTokenBundle({ access_token: t.accessToken, refresh_token: refreshToken }),
                // t.scope is OPTIONAL on a refresh response (RFC 6749 §5.1 —
                // Google omits it when unchanged from the original grant).
                // Never overwrite a previously-recorded scope with undefined:
                // that would silently downgrade a write-capable connection to
                // looking read-only. Only replace it when Google actually
                // sent one this time.
                meta: {
                  ...stripTokenKeys(conn.meta),
                  expiry_ms: Date.now() + t.expiresIn * 1000,
                  scope: t.scope ?? conn.meta?.scope,
                },
              });
              return t.accessToken;
            } catch {
              // refresh failed — fall through to the (possibly stale) stored token, then SA
            }
          }
          return accessToken;
        }
      }
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

const READONLY_MESSAGE =
  'Google Drive is connected read-only. Reconnect it in Settings to grant write access.';

/**
 * True when the recorded connection scope actually includes the full `drive`
 * scope (not just `drive.readonly`).
 *
 * HONEST EDGE CASE: a connection stored BEFORE this widening carries no
 * `meta.scope` at all (the callback route only started recording it here) —
 * a missing scope is treated as read-only, the safe default, because the old
 * flow could only ever have granted `drive.readonly`. Never assume write
 * access from the absence of evidence.
 */
export function driveWriteScopeGranted(meta: Record<string, any> | null | undefined): boolean {
  const scope = meta?.scope;
  if (typeof scope !== 'string' || !scope.trim()) return false;
  return scope.split(/\s+/).includes('https://www.googleapis.com/auth/drive');
}

/**
 * Sibling to resolveDriveToken() for mutating calls: resolves a usable
 * access token AND verifies the connection actually carries write scope
 * before handing it back, so every write tool fails with a readable message
 * instead of Google's opaque 403 "Insufficient Permission".
 *
 * The service account (no accountId row, or accountId falls through to it)
 * is always granted the widened SCOPE above by us server-side, so the gate
 * only applies to a per-user OAuth connection row.
 */
export async function requireDriveWriteToken(accountId?: string): Promise<string> {
  if (accountId) {
    const conn = await getConnection(accountId, 'google_drive').catch(() => null);
    if (conn) {
      const { accessToken } = await resolveTokensForRow(conn).catch(() => ({ accessToken: null }));
      if (accessToken && !driveWriteScopeGranted(conn.meta)) {
        throw new Error(READONLY_MESSAGE);
      }
    }
  }
  const token = await resolveDriveToken(accountId);
  if (!token) throw new Error('Google Drive is not connected — connect it in Settings.');
  return token;
}

/** POST/PATCH/DELETE against the Drive API, with the same error unwrapping as drive(). */
async function driveWrite(
  path: string,
  token: string,
  init: { method: 'POST' | 'PATCH' | 'DELETE'; body?: any; contentType?: string },
): Promise<any> {
  const res = await fetch(`${DRIVE_API}/${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body !== undefined ? { 'Content-Type': init.contentType || 'application/json' } : {}),
    },
    body: init.body !== undefined ? (typeof init.body === 'string' ? init.body : JSON.stringify(init.body)) : undefined,
  });
  if (res.status === 204) return { deleted: true };
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
      if (conn) {
        const { accessToken } = await resolveTokensForRow(conn);
        if (accessToken) via = 'oauth';
      }
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

// --- Write tools (2026-09-04) -----------------------------------------------
// Every function below goes through requireDriveWriteToken(), never
// resolveDriveToken() directly — the read-only-connection gate from the file
// header applies to all of them. Thin wrappers over the Drive v3 REST API,
// same discipline as the read functions above: no business logic beyond
// shaping the request and unwrapping the response.

const DEFAULT_FILE_FIELDS = 'id,name,mimeType,modifiedTime,webViewLink,parents';

/** List the files directly inside a folder (by folder id). */
export async function listDriveFilesInFolder(
  accountId: string,
  parentId: string,
  pageSize = 50,
): Promise<DriveFile[]> {
  // Read-only capability (gate: 'read' in lib/capabilities/gdrive.ts) — uses
  // resolveDriveToken, NOT requireDriveWriteToken, so a read-only connection
  // can still list a folder's contents.
  const token = await resolveDriveToken(accountId);
  if (!token) throw new Error('Google Drive is not connected — connect it in Settings.');
  const q = `'${parentId.replace(/'/g, "\\'")}' in parents and trashed = false`;
  const json = await drive(
    `files?q=${encodeURIComponent(q)}&pageSize=${Math.min(Math.max(pageSize, 1), 100)}&fields=files(${DEFAULT_FILE_FIELDS})`,
    token,
  );
  return (json.files || []) as DriveFile[];
}

/** Get one file's metadata by id. */
export async function getDriveFileMetadata(accountId: string, fileId: string): Promise<DriveFile> {
  const token = await resolveDriveToken(accountId);
  if (!token) throw new Error('Google Drive is not connected — connect it in Settings.');
  return drive(`files/${fileId}?fields=${DEFAULT_FILE_FIELDS}`, token) as Promise<DriveFile>;
}

/**
 * Create a file, optionally with text content, via the multipart upload
 * endpoint (https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart)
 * — the standard way to set metadata AND content in one request.
 */
export async function createDriveFile(
  accountId: string,
  opts: { name: string; mimeType: string; parentId?: string; content?: string },
): Promise<DriveFile> {
  const token = await requireDriveWriteToken(accountId);
  const boundary = `leadrail-drive-${Math.random().toString(36).slice(2)}`;
  const metadata: Record<string, any> = { name: opts.name, mimeType: opts.mimeType };
  if (opts.parentId) metadata.parents = [opts.parentId];
  const content = opts.content ?? '';
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${opts.mimeType}\r\n\r\n${content}\r\n` +
    `--${boundary}--`;
  const res = await fetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=${DEFAULT_FILE_FIELDS}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || `Google Drive error (${res.status})`);
  return json as DriveFile;
}

/** Create a folder (mimeType application/vnd.google-apps.folder). Metadata only, no upload needed. */
export async function createDriveFolder(
  accountId: string,
  opts: { name: string; parentId?: string },
): Promise<DriveFile> {
  const token = await requireDriveWriteToken(accountId);
  const metadata: Record<string, any> = { name: opts.name, mimeType: 'application/vnd.google-apps.folder' };
  if (opts.parentId) metadata.parents = [opts.parentId];
  const json = await driveWrite(`files?fields=${DEFAULT_FILE_FIELDS}`, token, { method: 'POST', body: metadata });
  return json as DriveFile;
}

/** Rename a file and/or replace its text content. At least one of name/content must be given. */
export async function updateDriveFile(
  accountId: string,
  opts: { fileId: string; name?: string; content?: string; mimeType?: string },
): Promise<DriveFile> {
  const token = await requireDriveWriteToken(accountId);
  let result: any = null;
  if (opts.name !== undefined) {
    result = await driveWrite(`files/${opts.fileId}?fields=${DEFAULT_FILE_FIELDS}`, token, {
      method: 'PATCH',
      body: { name: opts.name },
    });
  }
  if (opts.content !== undefined) {
    const res = await fetch(
      `${DRIVE_UPLOAD_API}/files/${opts.fileId}?uploadType=media&fields=${DEFAULT_FILE_FIELDS}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': opts.mimeType || 'text/plain',
        },
        body: opts.content,
      },
    );
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.message || `Google Drive error (${res.status})`);
    result = json;
  }
  if (!result) throw new Error('updateDriveFile: provide a new name and/or new content.');
  return result as DriveFile;
}

/** Move a file to a new parent folder (removing it from its old one). */
export async function moveDriveFile(
  accountId: string,
  opts: { fileId: string; newParentId: string; oldParentId?: string },
): Promise<DriveFile> {
  const token = await requireDriveWriteToken(accountId);
  let removeParents = opts.oldParentId;
  if (!removeParents) {
    const current = await drive(`files/${opts.fileId}?fields=parents`, token);
    removeParents = Array.isArray(current.parents) ? current.parents.join(',') : undefined;
  }
  const params = new URLSearchParams({ addParents: opts.newParentId, fields: DEFAULT_FILE_FIELDS });
  if (removeParents) params.set('removeParents', removeParents);
  const json = await driveWrite(`files/${opts.fileId}?${params.toString()}`, token, { method: 'PATCH', body: {} });
  return json as DriveFile;
}

/** Permanently delete a file. Irreversible. */
export async function deleteDriveFile(accountId: string, fileId: string): Promise<{ deleted: boolean; id: string }> {
  const token = await requireDriveWriteToken(accountId);
  await driveWrite(`files/${fileId}`, token, { method: 'DELETE' });
  return { deleted: true, id: fileId };
}

export interface DriveShareResult {
  id: string;
  role: string;
  type: string;
  emailAddress?: string;
}

/**
 * Share a file with a real person (role + emailAddress) or make it a public
 * link (role + type 'anyone'). Grants real access to someone else — this is
 * why shareDriveFile is gated external_send in lib/capabilities/gdrive.ts.
 */
export async function shareDriveFile(
  accountId: string,
  opts: { fileId: string; role: 'reader' | 'commenter' | 'writer'; emailAddress?: string; anyone?: boolean },
): Promise<DriveShareResult> {
  const token = await requireDriveWriteToken(accountId);
  const permission: Record<string, any> = opts.anyone
    ? { role: opts.role, type: 'anyone' }
    : { role: opts.role, type: 'user', emailAddress: opts.emailAddress };
  if (!opts.anyone && !opts.emailAddress) {
    throw new Error('shareDriveFile: provide emailAddress, or set anyone:true for a public link.');
  }
  const json = await driveWrite(`files/${opts.fileId}/permissions?fields=id,role,type,emailAddress`, token, {
    method: 'POST',
    body: permission,
  });
  return json as DriveShareResult;
}
