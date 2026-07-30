-- 016_purge_function.sql
-- The retention purge function the tick already calls (purge_soft_deleted) but
-- which was never created — so soft-deleted rows were hidden forever, never
-- actually erased. This makes "delete" real. Idempotent.
--
-- Hard-deletes contacts/companies/deals/brands whose deleted_at is older than
-- p_days. Account-level purge (which also clears storage objects) is handled in
-- app code because storage deletion cannot happen inside SQL.

CREATE OR REPLACE FUNCTION purge_soft_deleted(p_days INT DEFAULT 30)
RETURNS INT AS $$
DECLARE
  cutoff TIMESTAMPTZ := NOW() - (p_days || ' days')::interval;
  n INT := 0; c INT;
BEGIN
  DELETE FROM contacts  WHERE deleted_at IS NOT NULL AND deleted_at < cutoff;
  GET DIAGNOSTICS c = ROW_COUNT; n := n + c;
  DELETE FROM companies WHERE deleted_at IS NOT NULL AND deleted_at < cutoff;
  GET DIAGNOSTICS c = ROW_COUNT; n := n + c;
  DELETE FROM deals     WHERE deleted_at IS NOT NULL AND deleted_at < cutoff;
  GET DIAGNOSTICS c = ROW_COUNT; n := n + c;
  DELETE FROM brands    WHERE deleted_at IS NOT NULL AND deleted_at < cutoff;
  GET DIAGNOSTICS c = ROW_COUNT; n := n + c;
  RETURN n;
END;
$$ LANGUAGE plpgsql;
