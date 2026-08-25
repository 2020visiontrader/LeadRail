-- 053_mcp_oauth.sql — OAuth for external MCP servers.
--
-- WHY: lib/mcp/client.ts sends a static `Authorization` header and nothing
-- else. That is enough for a server issuing a long-lived token, and useless
-- for the growing number that are OAuth-protected — Higgsfield among them.
-- There was no discovery, no client registration, no PKCE, no refresh, so
-- those servers were simply unreachable and the UI had no way to say why.
--
-- Two additions, and one deliberate omission.
--
-- ADDED: per-connection OAuth state on mcp_clients (which authorization server,
-- which client_id we registered as, the encrypted tokens, when they expire),
-- and a short-lived table for in-flight authorization attempts.
--
-- OMITTED: any storage of the PKCE verifier outside the server. The verifier is
-- the secret that proves the token request came from whoever started the flow;
-- putting it in a cookie or a signed blob handed to the browser means an
-- attacker who can read it can complete someone else's authorization. It lives
-- in mcp_oauth_states, is looked up by an opaque `state` value, and is deleted
-- the moment it is used.
--
-- Idempotent; safe to re-run.

-- How this connection authenticates. 'header' is every existing row — a static
-- Authorization header — and stays the default so nothing already registered
-- changes behaviour.
ALTER TABLE mcp_clients ADD COLUMN IF NOT EXISTS auth_mode TEXT NOT NULL DEFAULT 'header';

-- Discovery + registration results, so a reconnect does not re-register and a
-- refresh knows where to go. None of this is secret: an authorization endpoint
-- is public, and a dynamically-registered client_id identifies us, it does not
-- authenticate us.
ALTER TABLE mcp_clients ADD COLUMN IF NOT EXISTS oauth_issuer          TEXT;
ALTER TABLE mcp_clients ADD COLUMN IF NOT EXISTS oauth_authorize_url   TEXT;
ALTER TABLE mcp_clients ADD COLUMN IF NOT EXISTS oauth_token_url       TEXT;
ALTER TABLE mcp_clients ADD COLUMN IF NOT EXISTS oauth_registration_url TEXT;
ALTER TABLE mcp_clients ADD COLUMN IF NOT EXISTS oauth_client_id       TEXT;
ALTER TABLE mcp_clients ADD COLUMN IF NOT EXISTS oauth_scope           TEXT;

-- Secrets. Encrypted with the same lib/ai/crypto vault that protects
-- auth_header_encrypted — never plaintext, never returned by the API
-- projection (see toSafe in lib/mcp/clients.ts).
--
-- A dynamically-registered client MAY be issued a client_secret; most public
-- clients are not, which is why PKCE is mandatory below rather than optional.
ALTER TABLE mcp_clients ADD COLUMN IF NOT EXISTS oauth_client_secret_encrypted  TEXT;
ALTER TABLE mcp_clients ADD COLUMN IF NOT EXISTS oauth_access_token_encrypted   TEXT;
ALTER TABLE mcp_clients ADD COLUMN IF NOT EXISTS oauth_refresh_token_encrypted  TEXT;

-- Expiry drives proactive refresh. Nullable because a server may issue a token
-- with no stated lifetime, in which case we refresh reactively on a 401 rather
-- than guessing a duration.
ALTER TABLE mcp_clients ADD COLUMN IF NOT EXISTS oauth_expires_at TIMESTAMPTZ;
ALTER TABLE mcp_clients ADD COLUMN IF NOT EXISTS oauth_connected_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'mcp_clients_auth_mode_check' AND conrelid = 'mcp_clients'::regclass
  ) THEN
    ALTER TABLE mcp_clients
      ADD CONSTRAINT mcp_clients_auth_mode_check CHECK (auth_mode IN ('header', 'oauth'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- In-flight authorization attempts.
--
-- One row per "user clicked Connect", deleted on completion. Holds the PKCE
-- verifier — the one genuinely secret part of the exchange — plus the account
-- and connection the callback belongs to, so the callback route needs no
-- session cookie and trusts nothing the browser hands it except an opaque
-- lookup key.
--
-- `state` is the lookup key AND the CSRF defence: it is random, single-use, and
-- a callback whose state is not in this table is refused outright.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mcp_oauth_states (
  state          TEXT PRIMARY KEY,
  account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  client_id      UUID NOT NULL REFERENCES mcp_clients(id) ON DELETE CASCADE,
  -- PKCE. Stored server-side only; see the header note.
  code_verifier  TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Ten minutes is the standard authorization-code window. An expired row is
  -- refused even if it is still present, so a stalled tab cannot be completed
  -- an hour later.
  expires_at     TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes')
);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_states_expiry ON mcp_oauth_states(expires_at);

ALTER TABLE mcp_oauth_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mcp_oauth_states FROM anon, authenticated;
