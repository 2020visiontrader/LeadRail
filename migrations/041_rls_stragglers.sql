-- 041_rls_stragglers.sql — close a live data exposure.
--
-- Four tables shipped with ROW LEVEL SECURITY disabled while every other table
-- in the schema has it enabled:
--
--     ad_sets, ads, agent_conversations, agent_memory
--
-- They are not merely readable. Verified against the live database, the `anon`
-- and `authenticated` roles hold DELETE, INSERT, SELECT, TRIGGER, TRUNCATE and
-- UPDATE on all four, with no RLS to constrain them. `anon` is the key shipped
-- in the browser bundle (NEXT_PUBLIC_SUPABASE_ANON_KEY), so anyone who opens
-- devtools on the app could read, modify, or TRUNCATE these tables.
--
-- Two of them are the worst candidates in the schema:
--   agent_conversations — full assistant transcripts
--   agent_memory        — durable facts, which Packet 1.1 only just began writing
--
-- WHY NO POLICIES: this restores the convention the rest of the schema already
-- uses (see 026_mcp_clients.sql, 028_approvals.sql, 039_mcp_keys.sql): RLS on,
-- no anon policies. The application connects with the SERVICE ROLE key
-- (lib/db.ts), which bypasses RLS entirely, and scopes every read and write by
-- account_id in code. The browser never talks to Postgres directly — it calls
-- /api/* routes, which are session-gated by middleware.ts. So denying anon and
-- authenticated outright is precisely the intent, not a side effect.
--
-- If a future client-side reader for these tables is ever added, it needs its
-- own explicit policy. Adding one silently to make an error go away would
-- reopen this hole.
--
-- Idempotent; safe to re-run.

ALTER TABLE public.ad_sets             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ads                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_memory        ENABLE ROW LEVEL SECURITY;

-- Belt and braces: revoke the DML grants themselves, so the exposure cannot
-- return if RLS is ever toggled off again on one of these tables. The service
-- role is unaffected — it bypasses both grants and RLS.
REVOKE ALL ON public.ad_sets             FROM anon, authenticated;
REVOKE ALL ON public.ads                 FROM anon, authenticated;
REVOKE ALL ON public.agent_conversations FROM anon, authenticated;
REVOKE ALL ON public.agent_memory        FROM anon, authenticated;
