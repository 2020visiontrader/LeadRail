// Per-account credentials for the token-based social services — Buffer and
// GoHighLevel (Packet 7.2).
//
// THE BUG THIS REPLACES. lib/social/buffer.ts and lib/social/ghl.ts read
// BUFFER_API_KEY / GOHIGHLEVEL_ACCESS_TOKEN straight out of process.env. One
// credential authenticated every tenant, so `getChannels()` returned the same
// Buffer channels, and `getSocialAccounts()` the same GHL profiles, to every
// account on the deployment. Packet 2.2-S refused to expose Buffer to the agent
// because of it (see `requireBuffer` in lib/capabilities/social.ts). This module
// is the fix: a credential is a property of ONE account's connection row.
//
// THREE RULES, and none of them is negotiable:
//
//  1. EVERY RESOLVE TAKES accountId AND FILTERS IN-QUERY. `getConnection`
//     applies `.eq('account_id', accountId)` inside the Postgres query, so a
//     row belonging to another tenant is never fetched, let alone filtered out
//     afterwards. There is no variant of these functions without an accountId.
//
//  2. NO SILENT CATCH. A failed credential resolve must surface as an error.
//     Swallowing it and falling through to a shared env token is exactly how
//     the cross-tenant leak worked, so a DB error here propagates.
//
//  3. THE PLAINTEXT TOKEN NEVER LEAVES THE SERVER. It is decrypted for one
//     outbound fetch and returned to the caller in lib/social/*, which put it
//     in an Authorization header. It is never logged, never placed in an error
//     message, and never projected into an API response — the browser-facing
//     projection in app/api/integrations/route.ts is an allowlist that drops
//     `secret_encrypted` along with `secret_ref` and the raw `meta`.
//
// STORAGE: `integration_connections.secret_encrypted` (migration 042), holding
// AES-256-GCM ciphertext from lib/ai/crypto.ts — the same vault used by
// ai_providers and mcp_clients.auth_header_encrypted. Deliberately NOT `meta`:
// POST /api/integrations writes `meta` verbatim from the client body, and
// `meta` is the field that shipped live Meta tokens to browser JS before
// Packet 7.1b.

import { getConnection, upsertConnection } from '@/lib/db';
import { decryptSecret, encryptSecret, vaultConfigured } from '@/lib/ai/crypto';

/** Providers whose credential is a single long-lived token pasted by the user. */
export type TokenProvider = 'buffer' | 'ghl';

interface ProviderSpec {
  /** Env var holding the deployment owner's own token. */
  envVar: string;
  /** Human-facing name used in the "not connected" message. */
  label: string;
}

const PROVIDERS: Record<TokenProvider, ProviderSpec> = {
  buffer: { envVar: 'BUFFER_API_KEY', label: 'Buffer' },
  ghl: { envVar: 'GOHIGHLEVEL_ACCESS_TOKEN', label: 'GoHighLevel' },
};

/**
 * THE ENV FALLBACK, AND WHY IT IS TENANT-SAFE.
 *
 * The plan text for this packet says to keep the env vars working "when zero
 * connection rows exist". Implemented literally that is a global count, and it
 * is not safe: on a deployment with five accounts and no Buffer rows, all five
 * would authenticate as the operator's Buffer organisation — the very leak this
 * packet exists to close, just with an extra condition in front of it.
 *
 * So the fallback is bound to ONE account, named explicitly by the operator:
 *
 *     SOCIAL_ENV_FALLBACK_ACCOUNT_ID=<the owner's account uuid>
 *
 * Unset (the default, including every existing deployment) means there is no
 * env fallback at all and an account without its own row is simply not
 * connected. Set, it applies to exactly that one account id and to no other, so
 * a second tenant can never inherit the operator's credential no matter how
 * many rows exist or don't. A single-tenant owner setup keeps working by
 * setting one variable; a multi-tenant deployment cannot leak by forgetting to.
 *
 * The account's own stored row always wins over the env value, so connecting a
 * real per-account token silently supersedes the fallback.
 */
function envFallbackAppliesTo(accountId: string): boolean {
  const owner = process.env.SOCIAL_ENV_FALLBACK_ACCOUNT_ID;
  return Boolean(owner) && owner === accountId;
}

export interface SocialCredential {
  token: string;
  /** The connection row's external_id — Buffer organisation / GHL location. */
  externalId: string | null;
  /** Non-secret connection metadata (e.g. GHL locationId). Never a token. */
  meta: Record<string, any>;
  /** Where the token came from, for diagnostics. Carries no secret material. */
  source: 'connection' | 'env';
}

/**
 * Resolve this account's credential for a token provider, or null if it has
 * none. Account-scoped in-query; throws on a DB or vault failure rather than
 * degrading to a shared credential.
 */
export async function resolveSocialCredential(
  accountId: string,
  provider: TokenProvider,
): Promise<SocialCredential | null> {
  if (!accountId) throw new Error('resolveSocialCredential requires an accountId');

  // Account-scoped read. getConnection filters .eq('account_id', accountId)
  // .eq('provider', provider) .eq('status','connected') inside the query.
  // Any error propagates — see rule 2 in the header.
  const conn = await getConnection(accountId, provider);

  if (conn?.secret_encrypted) {
    return {
      token: decryptSecret(String(conn.secret_encrypted)),
      externalId: conn.external_id ? String(conn.external_id) : null,
      meta: (conn.meta as Record<string, any>) || {},
      source: 'connection',
    };
  }

  if (envFallbackAppliesTo(accountId)) {
    const token = process.env[PROVIDERS[provider].envVar];
    if (token) {
      return {
        token,
        externalId: conn?.external_id ? String(conn.external_id) : null,
        meta: (conn?.meta as Record<string, any>) || {},
        source: 'env',
      };
    }
  }

  return null;
}

/**
 * Same, but throws the message the user needs instead of returning null. This
 * is the form the service wrappers use: an unauthenticated outbound call must
 * never be attempted.
 */
export async function requireSocialCredential(
  accountId: string,
  provider: TokenProvider,
): Promise<SocialCredential> {
  const cred = await resolveSocialCredential(accountId, provider);
  if (!cred) {
    throw new Error(
      `${PROVIDERS[provider].label} is not connected for this account — connect it in Settings → Integrations.`,
    );
  }
  return cred;
}

/** True when this account can authenticate to the provider. Boolean only — it
 * deliberately returns no part of the credential, so it is safe to drive a
 * browser-facing status response. */
export async function hasSocialCredential(
  accountId: string,
  provider: TokenProvider,
): Promise<boolean> {
  return (await resolveSocialCredential(accountId, provider)) !== null;
}

/**
 * Store (or replace) this account's token for a provider. Encrypts before it
 * touches the database and refuses outright when the vault is unconfigured —
 * storing a plaintext token would be strictly worse than not storing one.
 */
export async function storeSocialCredential(
  accountId: string,
  provider: TokenProvider,
  token: string,
  opts?: { externalId?: string; displayName?: string; meta?: Record<string, any> },
): Promise<void> {
  if (!accountId) throw new Error('storeSocialCredential requires an accountId');
  if (!token) throw new Error('storeSocialCredential requires a token');
  if (!vaultConfigured()) {
    const err: any = new Error('AI_VAULT_KEY is not set on this deployment; cannot store a provider token');
    err.code = 'vault_not_configured';
    throw err;
  }
  await upsertConnection({
    account_id: accountId,
    provider,
    external_id: opts?.externalId || provider,
    display_name: opts?.displayName ?? null,
    status: 'connected',
    // The token lives in the encrypted column only. secret_ref records WHERE it
    // came from, never any part of the value.
    secret_ref: `user-provided:${provider}`,
    secret_encrypted: encryptSecret(token),
    meta: opts?.meta ?? {},
  });
}
