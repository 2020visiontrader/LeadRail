-- 034_notifications.sql — In-app notifications, per account.
--
-- Simple flat feed: type/title/body/link + read flag. No push/email fan-out
-- here — this table is just the in-app bell/panel backing store.
--
-- Scoping/RLS convention matches 030_segments.sql / 031_events.sql /
-- 033_budgets.sql: account_id UUID NOT NULL, RLS enabled with no anon
-- policies — service-role bypasses, the app scopes every read/write by
-- account_id in code (see lib/notifications/store.ts).
-- Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS notifications (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  type         TEXT,
  title        TEXT NOT NULL,
  body         TEXT,
  link         TEXT,
  read         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_account_created ON notifications(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_account_read ON notifications(account_id, read);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
