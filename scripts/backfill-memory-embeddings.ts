// scripts/backfill-memory-embeddings.ts
//
// Backfill pgvector embeddings for agent_memory rows that lack one (migration
// 036). Idempotent: only touches rows WHERE embedding IS NULL, in batches. Safe
// to run any time — after 036 is applied, or if the embedding model is ever
// swapped (delete the old vectors first, then re-run).
//
// Run with:  npx tsx scripts/backfill-memory-embeddings.ts
//
// Requires env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NVIDIA_API_KEY.

import { createClient } from '@supabase/supabase-js';
import { embedPassages, toPgVector } from '../lib/agent/embeddings';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('Missing Supabase env'); process.exit(1); }
if (!process.env.NVIDIA_API_KEY) { console.error('Missing NVIDIA_API_KEY'); process.exit(1); }

const db = createClient(url, key, { auth: { persistSession: false } });
const BATCH = 32;

async function main() {
  let done = 0, failed = 0;
  for (;;) {
    const { data, error } = await db
      .from('agent_memory')
      .select('id, fact')
      .is('embedding', null)
      .limit(BATCH);
    if (error) { console.error('read error:', error.message); process.exit(1); }
    if (!data?.length) break;

    const vecs = await embedPassages(data.map((r) => r.fact as string));
    if (!vecs || vecs.length !== data.length) {
      // Embedding provider unavailable — stop cleanly, rows stay recency-only.
      console.error('embedding batch failed; stopping (rows left for next run)');
      break;
    }
    for (let i = 0; i < data.length; i++) {
      const { error: uErr } = await db
        .from('agent_memory')
        .update({ embedding: toPgVector(vecs[i]) })
        .eq('id', (data[i] as any).id);
      if (uErr) failed++; else done++;
    }
    console.log(`embedded ${done} (failed ${failed})…`);
  }
  console.log(`\nDone. Backfilled ${done} rows, ${failed} failures.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
