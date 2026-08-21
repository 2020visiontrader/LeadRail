// scripts/sync-skills.ts
//
// Push the static skill catalog (lib/skills/registry.ts -> ROUTABLE_SKILLS)
// into the `skills` table. Global rows only — account_id IS NULL.
//
// WHY THIS EXISTS ALONGSIDE /api/skills/sync
// The API route does the same job but needs a deployed build and an owner
// session. After a harvest the catalog is already correct in the repo and
// wrong in the database, and waiting for a deploy to reconcile them means the
// Skills page shows a stale catalog for however long that takes. This runs the
// same reconciliation from a checkout, against whichever project the service
// key points at.
//
// Run with:
//   SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/sync-skills.ts
//   SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/sync-skills.ts --dry-run
//
// The service-role key bypasses RLS, which is the point — `skills` has RLS on
// with no policy, so the catalog is deliberately unwritable by anon/authed
// clients. Never commit the key; pass it in the environment.
//
// NO UPSERT. Global uniqueness is enforced by a PARTIAL index
// (idx_skills_global_slug ON skills(slug) WHERE account_id IS NULL), and
// Postgres cannot use a partial index as an ON CONFLICT arbiter. So this reads
// what is there, then inserts or updates each row explicitly — the same reason
// app/api/skills/sync/route.ts is written that way. Deleting first is not an
// option either: account_skills references these rows ON DELETE CASCADE, so a
// delete-then-insert would silently unenroll every account.

import { createClient } from '@supabase/supabase-js';
import { ROUTABLE_SKILLS } from '../lib/skills/registry';

const DRY = process.argv.includes('--dry-run');
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!URL) throw new Error('NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) is not set.');
if (!KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set — the catalog is RLS-protected and needs it.');

const db = createClient(URL, KEY, { auth: { persistSession: false } });

interface Row {
  account_id: null;
  slug: string;
  name: string;
  category: string;
  description: string;
  instructions: string;
  source: string;
  inspired_by: string | null;
}

function desired(): Row[] {
  return (ROUTABLE_SKILLS as any[])
    .map((s) => ({
      account_id: null as null,
      slug: s.id,
      name: s.name,
      category: s.category,
      // `when` is the one-line relevance trigger Hermes shortlists on; it maps
      // to `description` because that is the column the catalog UI reads.
      description: s.when ?? '',
      instructions: s.systemModule ?? '',
      source: 'builtin',
      inspired_by: s.inspiredBy ?? null,
    }))
    // instructions is NOT NULL — a row without a body is not a skill.
    .filter((r) => r.slug && r.name && r.instructions);
}

async function main() {
  const rows = desired();
  const { data: existing, error } = await db
    .from('skills')
    .select('id, slug, name, category, description, instructions, inspired_by')
    .is('account_id', null);
  if (error) throw error;

  const byslug = new Map((existing || []).map((r: any) => [r.slug, r]));
  const toInsert: Row[] = [];
  const toUpdate: { id: string; row: Row }[] = [];

  for (const r of rows) {
    const cur: any = byslug.get(r.slug);
    if (!cur) { toInsert.push(r); continue; }
    const changed =
      cur.name !== r.name || cur.category !== r.category ||
      cur.description !== r.description || cur.instructions !== r.instructions ||
      (cur.inspired_by ?? null) !== r.inspired_by;
    if (changed) toUpdate.push({ id: cur.id, row: r });
  }

  // Reported, never deleted. A slug that vanished from the registry may still
  // be enrolled by an account, and quietly removing it would cascade.
  const orphans = (existing || []).filter((r: any) => !rows.some((x) => x.slug === r.slug));

  console.log(`registry ${rows.length} | catalog ${byslug.size} | insert ${toInsert.length} | update ${toUpdate.length} | orphan ${orphans.length}`);
  if (orphans.length) console.log('  orphans (left alone):', orphans.map((o: any) => o.slug).join(', '));
  if (DRY) { console.log('--dry-run: nothing written'); return; }

  let ins = 0;
  for (let i = 0; i < toInsert.length; i += 20) {
    const chunk = toInsert.slice(i, i + 20);
    const { error: e } = await db.from('skills').insert(chunk);
    if (e) { console.error(`insert chunk ${i}: ${e.message}`); continue; }
    ins += chunk.length;
  }
  let upd = 0;
  for (const { id, row } of toUpdate) {
    const { error: e } = await db
      .from('skills')
      .update({ ...row, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (e) { console.error(`update ${row.slug}: ${e.message}`); continue; }
    upd++;
  }
  console.log(`inserted ${ins}/${toInsert.length}, updated ${upd}/${toUpdate.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
