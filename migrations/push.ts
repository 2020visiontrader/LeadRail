/**
 * Apply migrations/apply_all.sql to Supabase.
 *
 * Provide ONE of:
 *   A) SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF   (Management API PAT, sbp_… — no driver)
 *   B) DATABASE_URL                                    (direct Postgres; uses Bun's native driver, no psql)
 *
 * SUPABASE_ACCESS_TOKEN must be a Personal Access Token (sbp_…) from
 * Supabase → Account → Access Tokens. A publishable/anon/service key
 * (sb_publishable_… / eyJ…) is a DATA-plane key and CANNOT run DDL.
 *
 * Usage:  bun run migrations/push.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// @ts-ignore - 'bun' is a runtime module; this script is executed with `bun run`, not tsc.
import { SQL } from 'bun';

/**
 * Every numbered migration, in order.
 *
 * THIS USED TO READ apply_all.sql AND NOTHING ELSE, which made the documented
 * path silently wrong. apply_all.sql had drifted: migrations 056 through 060
 * existed as numbered files and had reached production by some other route,
 * while apply_all.sql — the only thing this script read — did not contain them.
 * Anyone adding 061 and running `bun run migrations/push.ts` would have applied
 * NOTHING and been told it succeeded.
 *
 * The failure is silent twice over, which is why it survived: the script exits
 * 0, and the missing column only surfaces later as an insert failing inside a
 * catch that swallows it (recordAiUsage does exactly this). Concatenating the
 * real files removes the second source of truth rather than trying to keep two
 * in step.
 *
 * Safe because every migration in this directory is idempotent — verified: all
 * 69 use CREATE TABLE IF NOT EXISTS and ADD COLUMN IF NOT EXISTS. Re-running
 * the full set is a no-op on an up-to-date database, which is what makes
 * "just run them all, in order" a sound strategy at this size.
 */
function loadMigrations(): { name: string; sql: string }[] {
  const dir = dirname(fileURLToPath(import.meta.url));
  return readdirSync(dir)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))   // numbered only; skips apply_all.sql
    .sort()                                      // zero-padded, so lexical IS numeric
    .map((f) => ({ name: f, sql: readFileSync(join(dir, f), 'utf8') }));
}

const migrations = loadMigrations();
if (!migrations.length) {
  console.error('No numbered migrations found — refusing to run an empty batch.');
  process.exit(1);
}
console.log(`Applying ${migrations.length} migrations: ${migrations[0].name} … ${migrations[migrations.length - 1].name}`);

// Separators name each file, so a failure reports WHICH migration broke rather
// than a line number in a concatenation nobody can map back.
const sql = migrations
  .map((m) => `-- ─────────── ${m.name} ───────────\n${m.sql}`)
  .join('\n\n');

async function viaManagementApi(token: string, ref: string) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Management API ${res.status}: ${text.slice(0, 500)}`);
  console.log('✓ Applied via Management API');
  console.log(text.slice(0, 500));
}

async function viaDirectPostgres(url: string) {
  // Bun's native Postgres driver — no psql/pg dependency. Simple-query
  // protocol runs the whole multi-statement migration in one round-trip.
  const db = new SQL(url);
  try {
    await db.unsafe(sql).simple();
    console.log('✓ Applied via direct Postgres (Bun driver)');
  } finally {
    await db.end();
  }
}

const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.SUPABASE_PROJECT_REF;
const dbUrl = process.env.DATABASE_URL;

const looksLikePat = !!token && token.startsWith('sbp_');

if (dbUrl) {
  await viaDirectPostgres(dbUrl);
} else if (token && ref && looksLikePat) {
  await viaManagementApi(token, ref);
} else {
  const reason = token && !looksLikePat
    ? `SUPABASE_ACCESS_TOKEN is set but is not a Personal Access Token (expected sbp_…, got ${token.slice(0, 4)}…). ` +
      'That is a data-plane key and cannot run DDL.\n'
    : 'No usable credential found.\n';
  console.error(
    reason +
      'Provide ONE of:\n' +
      '  • DATABASE_URL  (Supabase → Settings → Database → Connection string → URI)\n' +
      '  • SUPABASE_ACCESS_TOKEN=sbp_…  (Supabase → Account → Access Tokens) + SUPABASE_PROJECT_REF\n' +
      'Zero-secret path: paste each migrations/NNN_*.sql into the Supabase SQL Editor in order and Run.'
  );
  process.exit(1);
}
