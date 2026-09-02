// lib/email/gmail-account.ts — storage for the ONE Gmail connection an
// account may have. See migrations/081_gmail_accounts.sql's header for why
// email_accounts (not integration_connections) and why secret_encrypted
// (never meta) hold the refresh token.
//
// PRODUCT RULE: exactly one connected `gmail` row per account_id (2026-09-02),
// enforced twice — the partial unique index in 081, and connectGmailAccount()
// below refusing a second connect with a message naming the address already
// connected. Neither is optional: the index is the guarantee against a race
// or a future direct-write bug; the app check is what turns that guarantee
// into a message a user can act on instead of a raw constraint-violation 500.
import { supabase } from '@/lib/db';
import { decryptSecret, encryptSecret, vaultConfigured } from '@/lib/ai/crypto';

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/userinfo.email',
];

/**
 * Google returns inconsistent casing on the userinfo email (and a user may
 * retype an address with different casing). Addresses are matched
 * case-insensitively everywhere else in this codebase (reply-send.ts /
 * ingest.ts both use .ilike), but the UNIQUE (account_id, address) constraint
 * is case-SENSITIVE — without normalising here, connecting "Bob@x.com" then
 * "bob@x.com" would pass that constraint as two distinct rows. Lowercasing
 * before every write and every conflict check is what keeps it to one.
 */
export function normalizeAddress(address: string): string {
  return String(address || '').trim().toLowerCase();
}

export interface GmailAccountRow {
  id: string;
  account_id: string;
  provider: string;
  address: string;
  status: string;
  secret_ref: string | null;
  secret_encrypted: string | null;
  token_expires_at: string | null;
  scopes: string[] | null;
  last_error: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** The account's Gmail row, or null if none is connected. Account-scoped. */
export async function getGmailAccount(accountId: string): Promise<GmailAccountRow | null> {
  if (!accountId) throw new Error('getGmailAccount requires an accountId');
  const { data, error } = await supabase
    .from('email_accounts')
    .select('*')
    .eq('account_id', accountId)
    .eq('provider', 'gmail')
    .maybeSingle();
  if (error) throw error;
  return (data as GmailAccountRow) ?? null;
}

/** The browser-facing projection: an ALLOWLIST that drops secret_encrypted,
 * secret_ref, and raw meta (this table has no meta column, but the same
 * discipline as lib/social/credentials.ts's header applies — name exactly
 * what is safe, don't filter for what isn't). */
export function safeGmailAccount(row: GmailAccountRow) {
  return {
    id: row.id,
    provider: row.provider,
    address: row.address,
    status: row.status,
    scopes: row.scopes ?? [],
    last_error: row.last_error ?? null,
    connected_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

export class GmailAlreadyConnectedError extends Error {
  existingAddress: string;
  constructor(existingAddress: string) {
    super(
      `A Gmail account is already connected (${existingAddress}). Disconnect it in Settings before connecting a different one.`,
    );
    this.name = 'GmailAlreadyConnectedError';
    this.existingAddress = existingAddress;
  }
}

/**
 * Connect this account's one Gmail row. Refuses cleanly — naming the address
 * already connected — when a CONNECTED row exists; never silently replaces it
 * (per the 2026-09-02 product correction: one at a time, swap by disconnect
 * then reconnect, not by overwrite).
 *
 * A row left behind by a previous disconnect (status 'disconnected' or
 * 'error', secret cleared) is UPDATED in place rather than inserted as a new
 * row — the partial unique index (081) is on `provider = 'gmail'` alone, not
 * `AND status = 'connected'`, so a second insert while that row still exists
 * would violate the index regardless of its status. Updating in place also
 * preserves inbox_messages.email_account_id history (ON DELETE CASCADE would
 * otherwise silently delete past mail on a delete-and-reinsert).
 */
export async function connectGmailAccount(params: {
  accountId: string;
  address: string;
  refreshToken: string;
  scopes: string[];
  expiresInSec: number;
}): Promise<GmailAccountRow> {
  const { accountId, refreshToken, scopes, expiresInSec } = params;
  if (!accountId) throw new Error('connectGmailAccount requires an accountId');
  const address = normalizeAddress(params.address);
  if (!address) throw new Error('connectGmailAccount requires an address');
  if (!vaultConfigured()) {
    const err: any = new Error('AI_VAULT_KEY is not set on this deployment; cannot store a Gmail refresh token');
    err.code = 'vault_not_configured';
    throw err;
  }

  // Application-side check first, for a clean user-facing message. The
  // partial unique index (081) is the backstop if this races.
  const existing = await getGmailAccount(accountId);
  if (existing && existing.status === 'connected') {
    throw new GmailAlreadyConnectedError(existing.address);
  }

  const nowIso = new Date().toISOString();
  const payload = {
    account_id: accountId,
    provider: 'gmail',
    address,
    status: 'connected',
    secret_ref: 'user-oauth:gmail',
    secret_encrypted: encryptSecret(refreshToken),
    scopes,
    token_expires_at: new Date(Date.now() + expiresInSec * 1000).toISOString(),
    last_error: null,
    updated_at: nowIso,
  };

  const { data, error } = existing
    ? await supabase.from('email_accounts').update(payload).eq('id', existing.id).select('*').single()
    : await supabase.from('email_accounts').insert([payload]).select('*').single();
  if (error) {
    // The unique index's own message is a raw Postgres constraint-violation
    // string. Translate the one case a race could produce into the same
    // clean error the app-side check above returns for the common case.
    if ((error as any).code === '23505') {
      const raced = await getGmailAccount(accountId);
      throw new GmailAlreadyConnectedError(raced?.address || address);
    }
    throw error;
  }
  return data as GmailAccountRow;
}

/** Decrypt this account's stored refresh token. Throws (never returns
 * plaintext-looking garbage) if the row or the vault key is missing. */
export async function getGmailRefreshToken(accountId: string): Promise<string> {
  const row = await getGmailAccount(accountId);
  if (!row?.secret_encrypted) throw new Error('No Gmail account connected for this account');
  return decryptSecret(row.secret_encrypted);
}

/** Record a refresh/API failure (e.g. a revoked refresh token) without
 * throwing into a user-facing send/read path — see lib/email/gmail.ts. */
export async function markGmailAccountError(accountId: string, message: string): Promise<void> {
  await supabase
    .from('email_accounts')
    .update({ status: 'error', last_error: message, updated_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('provider', 'gmail');
}

/**
 * Disconnect: clears the encrypted secret (never leaves a decryptable token
 * behind) and marks the row disconnected rather than deleting it, so
 * inbox_messages.email_account_id (ON DELETE CASCADE) isn't silently
 * orphaned-and-deleted history. Caller (the route) attempts Google token
 * revocation first — this always succeeds locally regardless of whether that
 * call did.
 */
export async function disconnectGmailAccount(accountId: string): Promise<void> {
  if (!accountId) throw new Error('disconnectGmailAccount requires an accountId');
  const { error } = await supabase
    .from('email_accounts')
    .update({
      status: 'disconnected',
      secret_encrypted: null,
      secret_ref: null,
      token_expires_at: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('account_id', accountId)
    .eq('provider', 'gmail');
  if (error) throw error;
}
