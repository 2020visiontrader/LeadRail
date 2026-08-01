-- ===========================================================================
-- 018_app_logs.sql — Durable application log for every API action.
--
-- Purpose: capture a structured, queryable record of every request handled by
-- the app (method, path, status, latency, actor) plus every warning/error, so
-- failures are caught and diagnosed without tailing container logs.
--
-- Written server-side only via the service-role client (lib/logger.ts). Best-
-- effort: a failed insert never breaks the request it describes.
--
-- account_id is intentionally NOT a foreign key: many rows come from
-- unauthenticated or cron/system contexts (account_id NULL), and error rows
-- must survive even if the referenced account is later purged.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS app_logs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id   text,
  level        text NOT NULL DEFAULT 'info',   -- 'info' | 'warn' | 'error'
  route        text,                            -- e.g. '/api/leads'
  method       text,                            -- GET | POST | PATCH | DELETE
  status       integer,                         -- HTTP status of the response
  duration_ms  integer,                         -- handler wall time
  account_id   uuid,                            -- tenant, when known (no FK; see header)
  actor_email  text,                            -- caller, when authenticated
  message      text,                            -- human-readable summary
  detail       jsonb,                           -- error stack / structured extras
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_logs_created_idx    ON app_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS app_logs_level_idx      ON app_logs (level, created_at DESC);
CREATE INDEX IF NOT EXISTS app_logs_account_idx    ON app_logs (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS app_logs_route_idx      ON app_logs (route, created_at DESC);
CREATE INDEX IF NOT EXISTS app_logs_request_idx    ON app_logs (request_id);

-- RLS parity with the rest of the schema: service-role bypasses; the app scopes
-- reads by account_id in the /api/logs route. No anon access.
ALTER TABLE app_logs ENABLE ROW LEVEL SECURITY;
