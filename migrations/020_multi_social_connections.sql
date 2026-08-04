-- 020_multi_social_connections.sql
-- Allow MULTIPLE connected accounts per social platform (e.g. 6 Instagram accounts,
-- several Facebook Pages). Each row = one connected account, keyed by
-- (account_id, provider, external_id). Providers move to one-per-platform:
-- facebook | instagram | threads | linkedin | tiktok | x  (plus non-social: resend, postiz…).

ALTER TABLE integration_connections ADD COLUMN IF NOT EXISTS external_id  TEXT;
ALTER TABLE integration_connections ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE integration_connections ADD COLUMN IF NOT EXISTS username     TEXT;

-- Backfill: social rows key on their platform account id; everything else on the provider name.
UPDATE integration_connections
   SET external_id = COALESCE(external_id, meta->>'page_id', meta->>'ig_user_id', provider)
 WHERE external_id IS NULL;

-- Migrate the legacy single 'meta' row into a 'facebook' row (its page) so the new
-- per-platform resolver picks it up. A linked IG becomes its own 'instagram' row.
INSERT INTO integration_connections (account_id, provider, status, secret_ref, meta, external_id, display_name, username, created_at, updated_at)
SELECT account_id, 'instagram', status, secret_ref, meta, meta->>'ig_user_id', meta->>'ig_username', meta->>'ig_username', created_at, NOW()
  FROM integration_connections
 WHERE provider = 'meta' AND COALESCE(meta->>'ig_user_id','') <> ''
ON CONFLICT DO NOTHING;

UPDATE integration_connections
   SET provider = 'facebook',
       external_id = COALESCE(meta->>'page_id', external_id),
       display_name = COALESCE(display_name, meta->>'page_name')
 WHERE provider = 'meta';

-- Non-null external_id keeps the composite unique meaningful (PG treats NULLs as distinct).
ALTER TABLE integration_connections ALTER COLUMN external_id SET DEFAULT '';
UPDATE integration_connections SET external_id = provider WHERE external_id IS NULL OR external_id = '';

-- Swap single-per-provider uniqueness for per-account uniqueness.
ALTER TABLE integration_connections DROP CONSTRAINT IF EXISTS integration_connections_account_id_provider_key;
ALTER TABLE integration_connections
  ADD CONSTRAINT integration_connections_acct_prov_ext_key UNIQUE (account_id, provider, external_id);

CREATE INDEX IF NOT EXISTS idx_intconn_acct_provider ON integration_connections (account_id, provider);
