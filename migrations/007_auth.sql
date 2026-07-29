-- Auth: password login for account members.
ALTER TABLE account_members ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE account_members ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
