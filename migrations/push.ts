/**
 * Apply migrations/apply_all.sql to Supabase.
 *
 * Provide ONE of:
 *   A) SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF   (Management API — no driver needed)
 *   B) DATABASE_URL                                    (direct Postgres; needs `psql` on PATH)
 *
 * Usage:  bun run migrations/push.ts
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

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

function viaPsql(url: string) {
  execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-f', new URL('./apply_all.sql', import.meta.url).pathname], {
    stdio: 'inherit',
  });
  console.log('✓ Applied via psql');
}

const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.SUPABASE_PROJECT_REF;
const dbUrl = process.env.DATABASE_URL;

if (token && ref) {
  await viaManagementApi(token, ref);
} else if (dbUrl) {
  viaPsql(dbUrl);
} else {
  console.error(
    'No credentials found. Set SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF, or DATABASE_URL.\n' +
      'Fastest path with no secrets: paste migrations/apply_all.sql into the Supabase SQL Editor.'
  );
  process.exit(1);
}
