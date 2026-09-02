// lib/social/connection-token.ts — the ONE place every OAuth-token reader for
// `integration_connections` goes through (Meta, Google Drive, LinkedIn,
// TikTok, X, Threads, Notion, Postiz, venture Resend keys).
//
// THE EXPOSURE THIS CLOSES (verified against production 2026-09-02):
// integration_connections.secret_encrypted has existed since migration 042
// for exactly this, and lib/social/credentials.ts already routes Buffer/GHL
// through it correctly. Every OTHER provider bypassed the vault and put its
// access/refresh token straight into `meta` — which POST /api/integrations
// writes verbatim from the client body and which app/api/integrations/route.ts
// used to (and Meta's per-page tokens still did, until this packet) project
// toward the browser. Live rows: 2 Instagram, 2 Facebook, 1 Notion token sat
// in plaintext `meta`.
//
// CONTRACT:
//  - secret_encrypted present -> decrypt it, parse the JSON token bundle,
//    return it. A malformed or tampered payload THROWS (rule 2 in
//    lib/social/credentials.ts's header: no silent catch that degrades to a
//    plaintext fallback).
//  - secret_encrypted empty, meta holds token keys -> return those values AND
//    best-effort LAZILY MIGRATE: encrypt them into secret_encrypted and strip
//    the token keys from meta, in one UPDATE by row id (never upsertConnection
//    here — that upserts on (account_id, provider, external_id) and this read
//    path sees rows, like venture-scoped Resend connections, that aren't
//    addressable that way). The migration write is best-effort: a failure is
//    logged at warn and swallowed, and the plaintext token already read is
//    still returned — a lazy migration must never turn a working connection
//    into a broken one.
//  - neither present -> null tokens, no throw.
//
// The token bundle is a small JSON object ({access_token?, refresh_token?,
// user_token?}) rather than one bare string, because a single connection row
// can legitimately hold more than one secret at once — see the Meta comment
// below. Never logged, never echoed in an error message, never placed in an
// API response.

import { supabase, getConnection } from '@/lib/db';
import { decryptSecret, encryptSecret, vaultConfigured } from '@/lib/ai/crypto';

export type TokenKey = 'access_token' | 'refresh_token' | 'user_token';
const TOKEN_KEYS: TokenKey[] = ['access_token', 'refresh_token', 'user_token'];

export interface ConnectionTokens {
  accessToken: string | null;
  refreshToken: string | null;
  /**
   * Meta only: the long-lived USER token alongside a Page's access token.
   * getUserPages() exchanges one user token for many Pages, and the Page
   * token (not the user token) is what publishes — but the user token is
   * kept too (future re-derivation of a Page token, and it's the credential
   * getMeId/getUserPages themselves were called with). MULTI-PAGE NOTE: each
   * Page already gets its OWN `facebook`/`instagram` connection row, keyed by
   * external_id = page id (see app/api/social/meta/callback/route.ts) — so
   * "several tokens in one connection" here means the page token + the user
   * token that produced it, never several pages' tokens sharing a row. The
   * per-page association is therefore carried by external_id, unchanged; this
   * bundle just keeps a page row's two secrets encrypted together instead of
   * splitting them across two columns.
   */
  userToken: string | null;
}

const EMPTY_TOKENS: ConnectionTokens = { accessToken: null, refreshToken: null, userToken: null };

/** Row shape this module reads/writes. `id` is required for the lazy-migrate
 * update path; every getConnection()/getConnections() row has it. */
export interface ConnectionRowLike {
  id?: string;
  account_id?: string;
  provider?: string;
  secret_encrypted?: string | null;
  secret_ref?: string | null;
  meta?: Record<string, any> | null;
}

/** Drop the token keys from a meta object, leaving everything else untouched.
 * Exported so writers can build a token-free `meta` the same way readers
 * strip one during migration — one definition of "these keys are secrets". */
export function stripTokenKeys(meta: Record<string, any> | null | undefined): Record<string, any> {
  const out: Record<string, any> = { ...(meta || {}) };
  for (const k of TOKEN_KEYS) delete out[k];
  return out;
}

/** Encrypt a token bundle for secret_encrypted. Omits null/undefined/empty
 * keys so a bundle with only an access_token doesn't store `"refresh_token":
 * null` as ciphertext padding. Throws (rule: never store plaintext-as-
 * ciphertext) when AI_VAULT_KEY is unset — see storeSocialCredential's
 * identical refusal in lib/social/credentials.ts. */
export function encryptTokenBundle(tokens: Partial<Record<TokenKey, string | null | undefined>>): string {
  const payload: Partial<Record<TokenKey, string>> = {};
  for (const k of TOKEN_KEYS) {
    const v = tokens[k];
    if (v) payload[k] = v;
  }
  return encryptSecret(JSON.stringify(payload));
}

function decryptTokenBundle(encoded: string): ConnectionTokens {
  const parsed = JSON.parse(decryptSecret(encoded));
  return {
    accessToken: parsed.access_token ? String(parsed.access_token) : null,
    refreshToken: parsed.refresh_token ? String(parsed.refresh_token) : null,
    userToken: parsed.user_token ? String(parsed.user_token) : null,
  };
}

/**
 * Resolve a connection's tokens by (accountId, provider[, externalId]) —
 * the common case, for callers that don't already have the row.
 */
export async function resolveConnectionTokens(
  accountId: string,
  provider: string,
  externalId?: string,
): Promise<ConnectionTokens> {
  const conn = await getConnection(accountId, provider, externalId);
  if (!conn) return EMPTY_TOKENS;
  return resolveTokensForRow(conn);
}

/**
 * Same resolution, given a row the caller already fetched (avoids a second
 * DB round trip — used by capabilities/social.ts and the per-brand Resend
 * lookup, which query integration_connections themselves).
 */
export async function resolveTokensForRow(conn: ConnectionRowLike): Promise<ConnectionTokens> {
  if (conn.secret_encrypted) {
    // Malformed/tampered ciphertext throws — never degrade to plaintext meta.
    return decryptTokenBundle(String(conn.secret_encrypted));
  }

  const meta = conn.meta || {};
  const accessToken = meta.access_token ? String(meta.access_token) : null;
  const refreshToken = meta.refresh_token ? String(meta.refresh_token) : null;
  const userToken = meta.user_token ? String(meta.user_token) : null;
  if (!accessToken && !refreshToken && !userToken) return EMPTY_TOKENS;

  // Lazy migration: best-effort, never blocks the caller. Skipped outright
  // (rather than writing pretend-ciphertext) when the vault isn't configured.
  if (vaultConfigured() && conn.id) {
    try {
      const { error } = await supabase
        .from('integration_connections')
        .update({
          secret_encrypted: encryptTokenBundle({
            access_token: accessToken,
            refresh_token: refreshToken,
            user_token: userToken,
          }),
          secret_ref: conn.secret_ref || `user-oauth:${conn.provider || 'unknown'}`,
          meta: stripTokenKeys(meta),
          updated_at: new Date().toISOString(),
        })
        .eq('id', conn.id);
      if (error) throw error;
    } catch (e: any) {
      console.warn(
        `[connection-token] lazy migration failed for connection id=${conn.id} provider=${conn.provider || 'unknown'}: ${e?.message || e}`,
      );
    }
  }

  return { accessToken, refreshToken, userToken };
}
