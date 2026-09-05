// lib/email/gmail.ts — Gmail OAuth + API: read, send, and write (labels /
// read-state / archive), full scopes. Mirrors the shape of
// lib/social/google-oauth.ts (the Google Drive precedent this packet was told
// to follow) but is its own module: Drive requests drive.readonly only, Gmail
// needs gmail.readonly + gmail.send + gmail.modify, and the token is stored
// in email_accounts (081), not integration_connections.meta.
//
// ACCESS TOKENS ARE NEVER PERSISTED. mintAccessToken() exchanges the stored
// refresh token for a ~1h access token on every call that needs one and hands
// it back to the caller for that one request; nothing here writes it to the
// database or to any cache with a lifetime beyond the current call.
import { publicBase, signState, verifyState } from '@/lib/social/meta-oauth';
import { getGmailRefreshToken, markGmailAccountError, GMAIL_SCOPES } from '@/lib/email/gmail-account';

export { signState, verifyState };

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://www.googleapis.com/oauth2/v2/userinfo';
const GOOGLE_REVOKE = 'https://oauth2.googleapis.com/revoke';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export function gmailConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function gmailRedirectUri(): string {
  return `${publicBase()}/api/email/gmail/callback`;
}

/**
 * access_type=offline + prompt=consent, BOTH required: without offline
 * Google never issues a refresh token, and without forcing the consent
 * screen a user re-authorizing (e.g. after a revoke) gets no NEW refresh
 * token either — Google only issues one on the first-ever grant unless the
 * consent screen is forced again. Missing either turns this connection
 * silently unrefreshable in ~1 hour.
 */
export function buildGmailAuthorizeUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: gmailRedirectUri(),
    response_type: 'code',
    scope: GMAIL_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${GOOGLE_AUTH}?${p.toString()}`;
}

export interface GmailTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scope: string;
}

export async function exchangeGmailCode(code: string): Promise<GmailTokens> {
  const form = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    client_secret: process.env.GOOGLE_CLIENT_SECRET!,
    redirect_uri: gmailRedirectUri(),
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
    scope: json.scope || '',
  };
}

export async function getGmailUserEmail(accessToken: string): Promise<string | null> {
  const res = await fetch(GOOGLE_USERINFO, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return null;
  const json = await res.json();
  return json?.email || null;
}

/**
 * Mint a fresh access token from the account's stored refresh token. Never
 * caches beyond the caller's own call. On a revoked/expired refresh token
 * (Google's invalid_grant), marks the stored account status='error' with
 * last_error set — per the brief, this NEVER throws into a user-facing
 * read/send/write path; callers get a null token back and decide what to
 * show instead of a raw 500.
 */
export async function mintAccessToken(accountId: string): Promise<string | null> {
  let refreshToken: string;
  try {
    refreshToken = await getGmailRefreshToken(accountId);
  } catch {
    return null; // no Gmail account connected — not an error state, just absent
  }
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
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    const reason = json?.error_description || json?.error || res.statusText || 'refresh failed';
    // invalid_grant is Google's code for "this refresh token no longer
    // works" (revoked by the user, or the app's access was removed) —
    // recorded so the Settings UI can show it, never thrown further.
    await markGmailAccountError(accountId, `Gmail token refresh failed: ${reason}`).catch(() => {});
    return null;
  }
  return json.access_token as string;
}

/** Best-effort revoke at Google. Never throws — the caller (disconnect route)
 * must succeed locally regardless of whether Google's side succeeds. */
export async function revokeGmailToken(refreshToken: string): Promise<boolean> {
  try {
    const res = await fetch(GOOGLE_REVOKE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }).toString(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Gmail API — read / send / write.
// ---------------------------------------------------------------------------

async function gmailFetch(accessToken: string, path: string, init?: RequestInit) {
  const res = await fetch(`${GMAIL_API}${path}`, {
    ...init,
    headers: { ...(init?.headers || {}), Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(`Gmail API ${path} failed: ${json?.error?.message || res.statusText}`);
  }
  return json;
}

export interface GmailListResult {
  messages: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
}

/** read: list message ids/thread ids matching a query (Gmail search syntax). */
export async function listMessages(
  accessToken: string,
  opts?: { query?: string; maxResults?: number; pageToken?: string },
): Promise<GmailListResult> {
  const p = new URLSearchParams();
  if (opts?.query) p.set('q', opts.query);
  p.set('maxResults', String(opts?.maxResults ?? 25));
  if (opts?.pageToken) p.set('pageToken', opts.pageToken);
  const json = await gmailFetch(accessToken, `/messages?${p.toString()}`);
  return { messages: json.messages || [], nextPageToken: json.nextPageToken };
}

/** read: fetch one message. format='full' by default for headers + body. */
export async function getMessage(accessToken: string, messageId: string, format: 'full' | 'metadata' | 'raw' = 'full') {
  return gmailFetch(accessToken, `/messages/${encodeURIComponent(messageId)}?format=${format}`);
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Build an RFC 2822 message, base64url-encoded for messages.send. */
export function buildRawMessage(params: {
  from: string;
  to: string;
  subject: string;
  html: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const headers = [
    `From: ${params.from}`,
    `To: ${params.to}`,
    `Subject: ${encodeMimeHeader(params.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
  ];
  if (params.inReplyTo) headers.push(`In-Reply-To: ${params.inReplyTo}`);
  if (params.references) headers.push(`References: ${params.references}`);
  const message = `${headers.join('\r\n')}\r\n\r\n${params.html}`;
  return base64UrlEncode(message);
}

/** RFC 2047-encode a subject line so non-ASCII survives raw MIME. Plain ASCII
 * subjects pass through unchanged (no '=?UTF-8?B?…' wrapper needed). */
function encodeMimeHeader(text: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

/** send: RFC 2822 message, base64url per Gmail's messages.send contract. */
export async function sendMessage(
  accessToken: string,
  params: { from: string; to: string; subject: string; html: string; inReplyTo?: string; references?: string; threadId?: string },
) {
  const raw = buildRawMessage(params);
  const body: Record<string, any> = { raw };
  if (params.threadId) body.threadId = params.threadId;
  return gmailFetch(accessToken, '/messages/send', { method: 'POST', body: JSON.stringify(body) });
}

/** write: modify labels (add/remove) — mark read/unread, archive, star, etc. */
export async function modifyMessage(
  accessToken: string,
  messageId: string,
  opts: { addLabelIds?: string[]; removeLabelIds?: string[] },
) {
  return gmailFetch(accessToken, `/messages/${encodeURIComponent(messageId)}/modify`, {
    method: 'POST',
    body: JSON.stringify({ addLabelIds: opts.addLabelIds || [], removeLabelIds: opts.removeLabelIds || [] }),
  });
}

/** write convenience: mark read (removes UNREAD label). */
export function markRead(accessToken: string, messageId: string) {
  return modifyMessage(accessToken, messageId, { removeLabelIds: ['UNREAD'] });
}

/** write convenience: mark unread (adds UNREAD label). */
export function markUnread(accessToken: string, messageId: string) {
  return modifyMessage(accessToken, messageId, { addLabelIds: ['UNREAD'] });
}

/** write convenience: archive (removes INBOX label). */
export function archiveMessage(accessToken: string, messageId: string) {
  return modifyMessage(accessToken, messageId, { removeLabelIds: ['INBOX'] });
}

// ---------------------------------------------------------------------------
// Drafts, threads, labels.
// ---------------------------------------------------------------------------

export interface GmailDraftListResult {
  drafts: Array<{ id: string; message: { id: string; threadId: string } }>;
  resultSizeEstimate?: number;
  nextPageToken?: string;
}

/** read: list drafts. Gmail's own count (resultSizeEstimate) is carried
 *  through unchanged — callers must not derive a count Gmail didn't report. */
export async function listDrafts(
  accessToken: string,
  opts?: { maxResults?: number; pageToken?: string },
): Promise<GmailDraftListResult> {
  const p = new URLSearchParams();
  p.set('maxResults', String(opts?.maxResults ?? 25));
  if (opts?.pageToken) p.set('pageToken', opts.pageToken);
  const json = await gmailFetch(accessToken, `/drafts?${p.toString()}`);
  return { drafts: json.drafts || [], resultSizeEstimate: json.resultSizeEstimate, nextPageToken: json.nextPageToken };
}

/** read: fetch one draft by id, including its underlying message. */
export async function getDraft(accessToken: string, draftId: string, format: 'full' | 'metadata' | 'raw' = 'full') {
  return gmailFetch(accessToken, `/drafts/${encodeURIComponent(draftId)}?format=${format}`);
}

/** internal_write: create a draft in the owner's own mailbox. Nothing is
 *  sent — this only writes the draft resource. */
export async function createDraft(
  accessToken: string,
  params: { from: string; to: string; subject: string; html: string; inReplyTo?: string; references?: string; threadId?: string },
) {
  const raw = buildRawMessage(params);
  const message: Record<string, any> = { raw };
  if (params.threadId) message.threadId = params.threadId;
  return gmailFetch(accessToken, '/drafts', { method: 'POST', body: JSON.stringify({ message }) });
}

/** external_send: send an existing draft as-is. */
export async function sendDraft(accessToken: string, draftId: string) {
  return gmailFetch(accessToken, '/drafts/send', { method: 'POST', body: JSON.stringify({ id: draftId }) });
}

/** destructive: permanently delete a draft (not a send-cancel — the draft
 *  resource itself is removed and cannot be recovered from chat). */
export async function deleteDraft(accessToken: string, draftId: string) {
  await gmailFetch(accessToken, `/drafts/${encodeURIComponent(draftId)}`, { method: 'DELETE' });
  return { id: draftId, deleted: true };
}

/** read: fetch a whole thread (every message in the conversation), not just
 *  one message. */
export async function getThread(accessToken: string, threadId: string, format: 'full' | 'metadata' | 'raw' = 'full') {
  return gmailFetch(accessToken, `/threads/${encodeURIComponent(threadId)}?format=${format}`);
}

export interface GmailLabel {
  id: string;
  name: string;
  type?: string;
}

/** read: list labels (system + user-created) in the mailbox. */
export async function listLabels(accessToken: string): Promise<{ labels: GmailLabel[] }> {
  const json = await gmailFetch(accessToken, '/labels');
  return { labels: json.labels || [] };
}
