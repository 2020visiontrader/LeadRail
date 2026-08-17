-- 042_social_credentials.sql — per-account credentials for Buffer / GoHighLevel
-- (Packet 7.2).
--
-- WHY: lib/social/buffer.ts and lib/social/ghl.ts authenticated from the
-- process-level env vars BUFFER_API_KEY / GOHIGHLEVEL_ACCESS_TOKEN. One
-- credential served every tenant, so `getChannels()` and `getSocialAccounts()`
-- returned the SAME third-party data to every account on the deployment.
-- Packet 2.2-S guarded around that with `requireBuffer`; this migration removes
-- the cause by giving each account somewhere to keep its OWN token.
--
-- WHERE: `integration_connections` already holds one row per connected account,
-- keyed (account_id, provider, external_id) since 020_multi_social_connections.
-- That is the correct home — no new table, and the existing account_id filter,
-- RLS posture and delete-cascade all apply unchanged.
--
-- HOW: a dedicated encrypted column, NOT `meta`. `meta` is a JSONB blob that
-- POST /api/integrations accepts verbatim from the client body, and it is the
-- field that leaked live Meta tokens to browser JS before Packet 7.1b. A token
-- must not be storable, or readable, through that path. `secret_encrypted`
-- holds AES-256-GCM ciphertext produced by lib/ai/crypto.ts `encryptSecret`
-- (the same vault as ai_providers and mcp_clients.auth_header_encrypted) and is
-- only ever decrypted server-side, for one outbound call, never returned to a
-- client — see the allowlist projection in app/api/integrations/route.ts.
--
-- Idempotent; safe to re-run. No backfill: env-var deployments keep working
-- through the single explicit owner-account fallback described in
-- lib/social/credentials.ts, and there is nothing to migrate because no
-- per-account token has ever been stored.

ALTER TABLE integration_connections
  ADD COLUMN IF NOT EXISTS secret_encrypted TEXT;

COMMENT ON COLUMN integration_connections.secret_encrypted IS
  'AES-256-GCM ciphertext of this account''s provider token (lib/ai/crypto.ts encryptSecret). Server-side only — never projected to a browser response.';
