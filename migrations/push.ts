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
import { readFileSync } from 'node:fs';
import { SQL } from 'bun';

const sql = readFileSync(new URL('./apply_all.sql', import.meta.url), 'utf8');

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
      'Zero-secret path: paste migrations/apply_all.sql into the Supabase SQL Editor and Run.'
  );
  process.exit(1);
}
