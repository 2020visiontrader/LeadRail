// enqueueCompanyEnrichment's header comment claimed the partial unique index
// (status in pending|running) made a duplicate insert a no-op. The only such
// index that ever existed — uniq_enrichment_job_live_contact — covers
// contact_id only. There was never an equivalent for company_id, so the same
// company could be queued for enrichment (and billed to Apollo) repeatedly.
// Migration 070 adds uniq_enrichment_job_live_company to close that gap.
//
// This suite mocks Supabase's insert().select('id').single() chain and
// simulates the partial unique index's actual behaviour (23505 on a live
// duplicate, success otherwise) so the fake can't accidentally agree with a
// buggy implementation the way a hand-picked mock return value could.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATION_PATH = join(__dirname, '..', 'migrations', '070_company_enrichment_idempotency.sql');

// The migration's own header comments narrate the fix in prose — including
// the literal index name and phrases like "CREATE UNIQUE INDEX" — to explain
// why it's built the way it is. Matching against the raw file text lets that
// prose satisfy a regex meant to check the real SQL, so every structural
// assertion below matches against the comment-stripped SQL instead.
function readMigrationSql(): string {
  const raw = readFileSync(MIGRATION_PATH, 'utf8');
  return raw
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');
}

let rows: any[] = [];
let nextId = 1;
let forceError: any = null;

function reset() {
  rows = [];
  nextId = 1;
  forceError = null;
}

vi.mock('@/lib/db', () => ({
  supabase: {
    from(_table: string) {
      return {
        insert(records: any[]) {
          const rec = records[0];
          return {
            select(_cols: string) {
              return {
                async single() {
                  if (forceError) return { data: null, error: forceError };
                  // Mirror the partial unique indexes: one live (pending/running)
                  // row per non-null contact_id, and (as of migration 070) one
                  // live row per non-null company_id.
                  const isLive = (r: any) => r.status === 'pending' || r.status === 'running';
                  const contactConflict =
                    rec.contact_id != null && rows.some((r) => r.contact_id === rec.contact_id && isLive(r));
                  const companyConflict =
                    rec.company_id != null && rows.some((r) => r.company_id === rec.company_id && isLive(r));
                  if (contactConflict || companyConflict) {
                    return {
                      data: null,
                      error: { code: '23505', message: 'duplicate key value violates unique constraint' },
                    };
                  }
                  const row = { id: `job-${nextId++}`, status: 'pending', ...rec };
                  rows.push(row);
                  return { data: { id: row.id }, error: null };
                },
              };
            },
          };
        },
      };
    },
  },
}));

const ACC = 'acct-1';

async function jobs() {
  return import('@/lib/enrichment-jobs');
}

describe('enrichment job idempotency', () => {
  beforeEach(() => {
    vi.resetModules();
    reset();
  });

  it('a second company enqueue while one is live returns already-in-flight, not a new row', async () => {
    const { enqueueCompanyEnrichment } = await jobs();
    const first = await enqueueCompanyEnrichment(ACC, 'co-1');
    expect(first.queued).toBe(true);

    const second = await enqueueCompanyEnrichment(ACC, 'co-1');
    expect(second).toEqual({ id: null, queued: false, reason: 'already in flight' });
    expect(rows.filter((r) => r.company_id === 'co-1')).toHaveLength(1);
  });

  it('a second person enqueue while one is live returns already-in-flight (existing behaviour, still holds)', async () => {
    const { enqueuePersonEnrichment } = await jobs();
    const first = await enqueuePersonEnrichment(ACC, 'ct-1');
    expect(first.queued).toBe(true);

    const second = await enqueuePersonEnrichment(ACC, 'ct-1');
    expect(second).toEqual({ id: null, queued: false, reason: 'already in flight' });
    expect(rows.filter((r) => r.contact_id === 'ct-1')).toHaveLength(1);
  });

  it.each(['cancelled', 'failed', 'done'])(
    'a company whose previous job is %s can be re-queued',
    async (status) => {
      const { enqueueCompanyEnrichment } = await jobs();
      rows.push({ id: 'stale', company_id: 'co-2', status, account_id: ACC, kind: 'company' });

      const result = await enqueueCompanyEnrichment(ACC, 'co-2');
      expect(result.queued).toBe(true);
      expect(rows.filter((r) => r.company_id === 'co-2')).toHaveLength(2);
    },
  );

  it('a non-23505 error still throws rather than being swallowed as already-in-flight', async () => {
    const { enqueueCompanyEnrichment } = await jobs();
    forceError = { code: '42501', message: 'permission denied' };
    await expect(enqueueCompanyEnrichment(ACC, 'co-3')).rejects.toBeTruthy();
  });

  it('migration 070 creates a partial unique index on company_id mirroring the contact one', () => {
    const sql = readMigrationSql();
    // Ties this test to the actual fix: without the index, this regex has
    // nothing in the file to match, independent of any application-level
    // idempotency logic tested above.
    // (?!\w) after the index name matters: without it, a renamed index like
    // uniq_enrichment_job_live_company_DISABLED still contains this string
    // as a substring and would falsely satisfy the match.
    const indexPattern =
      /CREATE\s+UNIQUE\s+INDEX[^;]*uniq_enrichment_job_live_company(?!\w)[^;]*ON\s+enrichment_jobs\s*\(\s*company_id\s*\)[^;]*WHERE[^;]*status\s+IN\s*\(\s*'pending'\s*,\s*'running'\s*\)[^;]*company_id\s+IS\s+NOT\s+NULL/i;
    expect(sql).toMatch(indexPattern);
  });

  it('migration 070 de-duplicates live company jobs BEFORE creating the unique index, not after', () => {
    const sql = readMigrationSql();
    // A dedupe that runs after CREATE UNIQUE INDEX is useless — the index
    // build is exactly the statement that would fail on the duplicates the
    // dedupe is meant to clear. Order matters, so this checks position, not
    // just presence.
    const dedupeMatch = sql.match(/ROW_NUMBER\(\)\s*OVER\s*\(\s*PARTITION\s+BY\s+company_id[^)]*\)/i);
    const indexMatch = sql.match(/CREATE\s+UNIQUE\s+INDEX[^;]*uniq_enrichment_job_live_company(?!\w)/i);
    expect(dedupeMatch, 'expected a ROW_NUMBER()-partitioned-by-company_id dedupe step').not.toBeNull();
    expect(indexMatch, 'expected the CREATE UNIQUE INDEX statement').not.toBeNull();
    expect(dedupeMatch!.index!).toBeLessThan(indexMatch!.index!);

    // The dedupe must actually resolve the UPDATE'd rows out of the live set
    // the index enforces uniqueness over, not just rank them.
    expect(sql).toMatch(/UPDATE\s+enrichment_jobs[\s\S]*?SET\s+status\s*=\s*'cancelled'/i);
  });

  it('the index creation is not wrapped in an exception handler that swallows a duplicate-key failure', () => {
    const sql = readMigrationSql();
    // A DO block catching unique_violation would let the migration report
    // success while silently leaving the index (and the guarantee the code
    // comments now claim) not created — the same defect this migration
    // fixes, reintroduced one layer down. The index must be free to fail the
    // migration loudly instead.
    expect(sql).not.toMatch(/EXCEPTION\s+WHEN\s+unique_violation/i);
    expect(sql).not.toMatch(/DO\s*\$\$/i);
  });
});
