-- 084_count_functions.sql
--
-- THE GAP THIS CLOSES. There is no way to count anything, so the assistant
-- answers "how many leads do I have" by calling listLeads and reading whole
-- pages of rows. Measured: three sub-agents each listed the same table and
-- reported 54, 56 and 61 leads back (pagination + a race against imports, but
-- the point stands — nobody should ever need a page of rows to answer a
-- question Postgres can return in one line), and a single 61-row listLeads
-- call was 282K chars just to let the model eyeball a total.
--
-- A plain total (`count: 'exact', head: true`) needs no migration — PostgREST
-- already does that as a real aggregate. A GROUPED total is the part
-- PostgREST cannot express without either enabling its (per-project,
-- unconfirmed-here) aggregate-functions feature or fetching every distinct
-- group's rows client-side and tallying in JS — the exact defect this whole
-- change exists to remove. So grouping is done here, in SQL, returning one
-- row per group (never a row per record).
--
-- Three functions, one per counted entity. Each is STABLE (read-only, no
-- writes) and takes the account_id plus the same filters the capability
-- accepts, so the WHERE clause — tenancy and soft-delete included — lives in
-- one place instead of being re-derived by every caller. count_leads_grouped
-- and count_companies_grouped switch on an allowlisted column via
-- format(%I) — p_group_by is checked against a fixed CASE before it ever
-- reaches format(), so it can select a column, never inject SQL.
-- count_deals_grouped groups explicitly (brand_id, or a join to
-- pipeline_stages for a human-readable stage name) since a plain column
-- switch can't express the stage join.

CREATE OR REPLACE FUNCTION count_leads_grouped(
  p_account_id UUID,
  p_group_by TEXT,
  p_brand_id TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_segment TEXT DEFAULT NULL,
  p_tag TEXT DEFAULT NULL
)
RETURNS TABLE(group_value TEXT, n BIGINT)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  col TEXT;
BEGIN
  col := CASE p_group_by
    WHEN 'brand' THEN 'brand_id'
    WHEN 'status' THEN 'status'
    WHEN 'segment' THEN 'segment'
    ELSE NULL
  END;
  IF col IS NULL THEN
    RAISE EXCEPTION 'count_leads_grouped: invalid group_by %', p_group_by;
  END IF;
  RETURN QUERY EXECUTE format(
    'SELECT COALESCE(c.%1$I::text, %2$L), COUNT(*)::bigint
       FROM contacts c
      WHERE c.account_id = $1
        AND c.deleted_at IS NULL
        AND ($2 IS NULL OR c.brand_id = $2)
        AND ($3 IS NULL OR c.status = $3)
        AND ($4 IS NULL OR c.segment = $4)
        AND ($5 IS NULL OR EXISTS (
              SELECT 1 FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
               WHERE ct.contact_id = c.id AND t.name = $5))
      GROUP BY c.%1$I
      ORDER BY 2 DESC',
    col, '(none)'
  ) USING p_account_id, p_brand_id, p_status, p_segment, p_tag;
END;
$$;

CREATE OR REPLACE FUNCTION count_deals_grouped(
  p_account_id UUID,
  p_group_by TEXT,
  p_brand_id TEXT DEFAULT NULL,
  p_stage TEXT DEFAULT NULL
)
RETURNS TABLE(group_value TEXT, n BIGINT)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF p_group_by = 'brand' THEN
    RETURN QUERY
      SELECT COALESCE(d.brand_id, '(none)'), COUNT(*)::bigint
        FROM deals d
       WHERE d.account_id = p_account_id
         AND d.deleted_at IS NULL
         AND (p_brand_id IS NULL OR d.brand_id = p_brand_id)
         AND (p_stage IS NULL OR EXISTS (
               SELECT 1 FROM pipeline_stages ps
                WHERE ps.id = d.stage_id AND ps.name = p_stage))
       GROUP BY d.brand_id
       ORDER BY 2 DESC;
  ELSIF p_group_by = 'stage' THEN
    RETURN QUERY
      SELECT COALESCE(ps.name, '(no stage)'), COUNT(*)::bigint
        FROM deals d
        LEFT JOIN pipeline_stages ps ON ps.id = d.stage_id
       WHERE d.account_id = p_account_id
         AND d.deleted_at IS NULL
         AND (p_brand_id IS NULL OR d.brand_id = p_brand_id)
         AND (p_stage IS NULL OR ps.name = p_stage)
       GROUP BY ps.name
       ORDER BY 2 DESC;
  ELSE
    RAISE EXCEPTION 'count_deals_grouped: invalid group_by %', p_group_by;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION count_companies_grouped(
  p_account_id UUID,
  p_group_by TEXT,
  p_brand_id TEXT DEFAULT NULL
)
RETURNS TABLE(group_value TEXT, n BIGINT)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  col TEXT;
BEGIN
  col := CASE p_group_by
    WHEN 'brand' THEN 'brand_id'
    WHEN 'industry' THEN 'industry'
    ELSE NULL
  END;
  IF col IS NULL THEN
    RAISE EXCEPTION 'count_companies_grouped: invalid group_by %', p_group_by;
  END IF;
  RETURN QUERY EXECUTE format(
    'SELECT COALESCE(c.%1$I::text, %2$L), COUNT(*)::bigint
       FROM companies c
      WHERE c.account_id = $1
        AND c.deleted_at IS NULL
        AND ($2 IS NULL OR c.brand_id = $2)
      GROUP BY c.%1$I
      ORDER BY 2 DESC',
    col, '(none)'
  ) USING p_account_id, p_brand_id;
END;
$$;
