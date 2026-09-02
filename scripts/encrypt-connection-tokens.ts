// scripts/encrypt-connection-tokens.ts
//
// Backfill for the exposure closed by lib/social/connection-token.ts: rows in
// integration_connections whose OAuth token still sits in plaintext `meta`
// (access_token / refresh_token / user_token) get it encrypted into
// secret_encrypted, and those keys are cleared from meta. Idempotent — a row
// already migrated (no token keys left in meta) is skipped, so re-running is
// safe and reports 0 for anything already done.
//
// This does NOT touch Buffer/GHL rows — those have used secret_encrypted via
// lib/social/credentials.ts since migration 042 and never had a plaintext
// token in meta to begin with.
//
// Refuses to run if the vault (AI_VAULT_KEY) isn't configured: writing
// "ciphertext" under no key would be encryptSecret() throwing, and this
// script would rather report that plainly than half-run.
//
// Run with:  npx tsx scripts/encrypt-connection-tokens.ts
// Add --dry-run to report what WOULD change without writing anything.
//
// Requires env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, AI_VAULT_KEY.
// AI_VAULT_KEY lives on the deployed service, not in a local/dev container —
// this must be run from an environment that has it (e.g. `vercel env pull`
// first, or run as a one-off task in the deployed environment).

import { createClient } from '@supabase/supabase-js';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('Missing Supabase env (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)'); process.exit(1); }

// Inlined rather than imported from lib/ai/crypto.ts: this script runs under
// `tsx` outside the Next.js module graph, and the encryption logic is small,
// stable (AES-256-GCM, matches encryptSecret exactly), and easy to eyeball
// here for a one-shot script that touches every provider's live tokens.
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

function vaultConfigured(): boolean {
  return !!process.env.AI_VAULT_KEY;
}

function vaultKey(): Buffer {
  return createHash('sha256').update(process.env.AI_VAULT_KEY as string).digest();
}

function encryptTokenBundle(tokens: Record<string, string | undefined>): string {
  const payload: Record<string, string> = {};
  for (const k of ['access_token', 'refresh_token', 'user_token']) {
    const v = tokens[k];
    if (v) payload[k] = v;
  }
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, vaultKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64url');
}

if (!vaultConfigured()) {
  console.error('AI_VAULT_KEY is not set — refusing to run (would write plaintext-as-ciphertext).');
  process.exit(1);
}

const DRY_RUN = process.argv.includes('--dry-run');
const TOKEN_KEYS = ['access_token', 'refresh_token', 'user_token'];

const db = createClient(url, key, { auth: { persistSession: false } });
const BATCH = 100;

function hasPlaintextToken(meta: Record<string, any> | null): boolean {
  if (!meta) return false;
  return TOKEN_KEYS.some((k) => !!meta[k]);
}

function stripTokenKeys(meta: Record<string, any> | null): Record<string, any> {
  const out = { ...(meta || {}) };
  for (const k of TOKEN_KEYS) delete out[k];
  return out;
}

async function main() {
  const perProvider: Record<string, { migrated: number; skipped: number; failed: number }> = {};
  let offset = 0;
  let totalMigrated = 0;
  let totalFailed = 0;

  for (;;) {
    const { data, error } = await db
      .from('integration_connections')
      .select('id, provider, meta, secret_encrypted, secret_ref')
      .range(offset, offset + BATCH - 1);
    if (error) { console.error('read error:', error.message); process.exit(1); }
    if (!data?.length) break;

    for (const row of data) {
      const provider = String((row as any).provider);
      perProvider[provider] = perProvider[provider] || { migrated: 0, skipped: 0, failed: 0 };
      const meta = (row as any).meta as Record<string, any> | null;

      if (!hasPlaintextToken(meta)) {
        perProvider[provider].skipped++;
        continue;
      }

      const tokens: Record<string, string | undefined> = {};
      for (const k of TOKEN_KEYS) if (meta?.[k]) tokens[k] = String(meta[k]);

      if (DRY_RUN) {
        console.log(`[dry-run] would migrate id=${(row as any).id} provider=${provider} keys=${Object.keys(tokens).join(',')}`);
        perProvider[provider].migrated++;
        totalMigrated++;
        continue;
      }

      try {
        const { error: uErr } = await db
          .from('integration_connections')
          .update({
            secret_encrypted: encryptTokenBundle(tokens),
            secret_ref: (row as any).secret_ref || `user-oauth:${provider}`,
            meta: stripTokenKeys(meta),
            updated_at: new Date().toISOString(),
          })
          .eq('id', (row as any).id);
        if (uErr) throw uErr;
        perProvider[provider].migrated++;
        totalMigrated++;
      } catch (e: any) {
        console.error(`FAILED id=${(row as any).id} provider=${provider}: ${e?.message || e}`);
        perProvider[provider].failed++;
        totalFailed++;
      }
    }

    offset += BATCH;
  }

  console.log(`\n${DRY_RUN ? '[dry-run] ' : ''}Done.`);
  for (const [provider, counts] of Object.entries(perProvider)) {
    console.log(`  ${provider}: migrated=${counts.migrated} skipped=${counts.skipped} failed=${counts.failed}`);
  }
  console.log(`\nTotal migrated: ${totalMigrated}, failed: ${totalFailed}`);
  if (totalFailed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
