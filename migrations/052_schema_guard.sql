-- 052_schema_guard.sql — introspection for the schema-drift check.
--
-- WHY: four migrations (039, 042, 043, 044) sat unapplied against production
-- for weeks and nothing noticed, because nothing compares the schema the
-- deployed code writes against with the schema that is actually there. The
-- symptom, when it finally surfaced, was a modal saying "Internal error" over
-- a log line reading PGRST204, column 'allow_auto' not found.
--
-- PostgREST does not expose information_schema, so the application cannot ask
-- "does this column exist?" directly. This is the narrowest possible window
-- onto that question: given a list of table names, return the (table, column)
-- pairs that exist in the public schema. Nothing else.
--
-- SECURITY DEFINER with a pinned search_path, and it returns only NAMES —
-- never a value, never a row of anyone's data. The worst an unexpected caller
-- learns is the shape of a schema they can already infer from the API's own
-- error messages.
--
-- Idempotent; safe to re-run.

CREATE OR REPLACE FUNCTION public.schema_columns_for(p_tables TEXT[])
RETURNS TABLE (table_name TEXT, column_name TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
STABLE
AS $$
  SELECT c.table_name::text, c.column_name::text
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = ANY(p_tables);
$$;

-- Service-role only. The app calls this with the service key; no anon or
-- authenticated client has any reason to introspect the schema.
REVOKE ALL ON FUNCTION public.schema_columns_for(TEXT[]) FROM PUBLIC, anon, authenticated;
