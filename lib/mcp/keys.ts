// Per-account API keys for LeadRail's OWN MCP server (migration
// 039_mcp_keys.sql). Inverse of lib/mcp/clients.ts, which registers EXTERNAL
// MCP servers this account consumes — this file authenticates callers of
// app/api/mcp/route.ts.
//
// The bearer token is never stored: rows carry only its sha256, and lookup is
// by that hash. `allow_sensitive` is the per-key opt-in that lets an MCP caller
// run spend / external-send tools; it defaults to false in the schema so a new
// key is read + safe-write only.

import { createHash } from 'node:crypto';
import { supabase } from '@/lib/db';

/** sha256 hex of a bearer token — the only form of the token that is ever
 * stored or compared. Exported so callers (e.g. the route's per-key rate
 * limiter) can bucket by key identity without re-implementing the hash or
 * holding the raw token. */
export function hashBearer(bearer: string): string {
  return createHash('sha256').update(bearer).digest('hex');
}

export interface ResolvedMcpKey {
  accountId: string;
  allowSensitive: boolean;
}

/**
 * Resolve a bearer token to its account and sensitivity grant.
 *
 * This is a GATE, not a best-effort read: it never swallows a query error and
 * never degrades to a permissive default. A DB failure propagates so the caller
 * refuses the request — denying is the only safe failure mode here.
 *
 * Returns null only when the token genuinely matches no live key; revocation is
 * filtered IN THE QUERY (`revoked_at IS NULL`), so a revoked key can never be
 * resolved even if a later code path forgets to check.
 */
export async function resolveMcpKey(bearer: string): Promise<ResolvedMcpKey | null> {
  if (!bearer) return null;
  const keyHash = hashBearer(bearer);

  const { data, error } = await supabase
    .from('mcp_api_keys')
    .select('id, account_id, allow_sensitive')
    .eq('key_hash', keyHash)
    .is('revoked_at', null) // revoked keys are excluded by the query, not after the fetch
    .maybeSingle();
  if (error) throw error; // gate: a lookup failure must deny, never allow
  if (!data) return null;

  // Best-effort usage stamp. This is the ONLY non-gate part of this function —
  // it must never block or fail the resolve, so it is fire-and-forget with a
  // silent catch (the write is telemetry, not authority).
  void supabase
    .from('mcp_api_keys')
    .update({ last_used_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', data.id)
    .eq('account_id', data.account_id)
    .then(undefined, () => {});

  return { accountId: data.account_id, allowSensitive: Boolean(data.allow_sensitive) };
}
