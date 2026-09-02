-- 081_gmail_accounts.sql — let a user connect their Gmail account, for real.
--
-- THE DEFECT THIS CLOSES. email_accounts (migration 004) has had two readers
-- and no writer since it was created:
--   - lib/inbox/reply-send.ts's ownership gate — "only allow sending from an
--     address this account actually owns, otherwise a caller could reply
--     'from' an arbitrary spoofed address" — queries this table and, finding
--     it permanently empty, refuses every reply with "from address not owned
--     by account".
--   - lib/inbox/ingest.ts maps an inbound message's recipient address back to
--     the owning account by the same table, so inbound routing was equally
--     dead.
-- Nothing in the codebase ever inserted a row. This migration adds the
-- columns a real OAuth connection needs; the writer is
-- lib/email/gmail-account.ts (POST-equivalent: the OAuth callback route).
--
-- WHERE THE REFRESH TOKEN LIVES, AND WHY NOT `meta`. Same rule
-- lib/social/credentials.ts already documents for integration_connections:
-- `secret_encrypted` holds AES-256-GCM ciphertext from lib/ai/crypto.ts
-- (encryptSecret/decryptSecret, keyed by AI_VAULT_KEY — the same vault as
-- ai_providers and mcp_clients.auth_header_encrypted). `meta` is reserved for
-- NON-secret display data (scopes, expiry, profile), because `meta` is a
-- field this codebase has already shipped verbatim to browser JS once
-- (Packet 7.1b, Meta tokens) — putting a refresh token there again would be
-- repeating a fixed bug. The Gmail ACCESS token is never stored anywhere: it
-- lives ~1h and is minted on demand from the refresh token
-- (lib/email/gmail.ts), kept in memory only for the call that needed it.
--
-- ONE GMAIL ACCOUNT PER LEADRAIL ACCOUNT — A PRODUCT RULE, NOT A SCHEMA LIMIT.
-- The product decision (2026-09-02) is exactly one connected Gmail mailbox at
-- a time; to switch addresses, disconnect first, then connect the new one.
-- That is enforced by a single PARTIAL UNIQUE INDEX below
-- (idx_email_accounts_one_gmail_per_account), deliberately kept separate from
-- the pre-existing UNIQUE (account_id, address) constraint (migration 004,
-- unchanged), which is a different invariant (no duplicate address rows) that
-- stays true regardless of how many providers or accounts-per-provider are
-- ever allowed. If multi-account Gmail is wanted later, the schema already
-- supports it (address is the natural per-row key) — dropping this one index
-- is the entire migration that would take.
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS secret_encrypted TEXT;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS scopes TEXT[];
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- THE ONE-AT-A-TIME RULE, ENFORCED WHERE IT CANNOT BE FORGOTTEN. A partial
-- unique index rather than a plain UNIQUE(account_id) so it applies only to
-- provider = 'gmail' — other providers (outlook, imap, brevo, resend) are
-- untouched by this product decision and free to have their own rules later.
-- The app-side connect route also refuses a second Gmail connect with a
-- clear message naming the existing address (see the callback route) — this
-- index is the backstop that makes that refusal a guarantee, not a
-- convention, the same "belt + suspenders" reasoning migration 024 used for
-- personas.is_coordinator, just a database constraint deep instead of an
-- app-side clear (there is nothing to "clear" here: a second insert must
-- fail, not silently replace the first).
DROP INDEX IF EXISTS idx_email_accounts_one_gmail_per_account;
CREATE UNIQUE INDEX idx_email_accounts_one_gmail_per_account
  ON email_accounts (account_id)
  WHERE provider = 'gmail';

-- RLS posture matching its siblings (024/041/062/079/080): on, no anon/authenticated
-- policies — the app connects with the service-role key (lib/db.ts) which
-- bypasses RLS, and every read/write is scoped by account_id in application
-- code (lib/email/gmail-account.ts, lib/inbox/reply-send.ts, lib/inbox/ingest.ts).
-- email_accounts already had RLS enabled by migration 004's bulk loop; this
-- migration only adds the REVOKE that migration never issued.
ALTER TABLE public.email_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_accounts FROM anon, authenticated;

COMMENT ON COLUMN email_accounts.secret_encrypted IS
  'AES-256-GCM ciphertext (lib/ai/crypto.ts, AI_VAULT_KEY) of the OAuth refresh token. Never the access token — that is minted on demand and never persisted. Never written to meta.';
COMMENT ON COLUMN email_accounts.token_expires_at IS
  'Expiry of the last-minted access token, informational only (the refresh flow does not trust it to decide whether to refresh — it always mints fresh on demand). NULL until a token has been minted at least once.';
COMMENT ON COLUMN email_accounts.scopes IS
  'OAuth scopes actually granted (gmail.readonly, gmail.send, gmail.modify, userinfo.email), as returned by Google — non-secret, safe for the browser-facing projection.';
COMMENT ON COLUMN email_accounts.last_error IS
  'Set alongside status=''error'' when a refresh or API call fails (e.g. a revoked refresh token) — read by the Settings UI so a broken connection is visible instead of silently failing sends. Cleared on the next successful connect.';
COMMENT ON COLUMN email_accounts.updated_at IS
  'Bumped on every status/token change, so "connected 3 minutes ago" vs "connected in March" is answerable without a separate audit table.';
COMMENT ON INDEX idx_email_accounts_one_gmail_per_account IS
  'Product rule: exactly one connected Gmail row per account_id (2026-09-02). One line to drop if multi-account Gmail is ever wanted — the rest of the schema (address as the natural per-row key) already supports it.';
