// scripts/smoke-test.ts
//
// Read-mostly smoke test for the feat/copilot-remediation branch.
//
// WHY THIS EXISTS: every packet on this branch was verified by `tsc --noEmit`
// and `npm run build` — that is compilation, not behaviour. Nothing has been
// exercised against a real database. This script closes that gap for the
// pieces that can be checked without spending money or contacting a third
// party.
//
// Run with:  npx tsx scripts/smoke-test.ts
//   optional: SMOKE_ACCOUNT_ID=<uuid>   (defaults to the first account row)
//
// Requires env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// NVIDIA_API_KEY is optional — without it the memory embedding check is
// reported as SKIP rather than FAIL, since embedding is best-effort by design.
//
// SAFETY — this script never sends anything to a real audience. It touches no
// capability gated `external_send`, `spend`, `destructive` or `standing_rule`.
// The ONLY writes it performs are one durable memory fact and one social
// automation row, both created in a disabled/inert state and both deleted in
// the finally block. It is safe against a production database, though staging
// is obviously preferable.

import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing Supabase env (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)');
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

type Status = 'PASS' | 'FAIL' | 'SKIP';
const results: { name: string; status: Status; detail: string }[] = [];
const record = (name: string, status: Status, detail = '') => {
  results.push({ name, status, detail });
  const mark = status === 'PASS' ? '✓' : status === 'SKIP' ? '–' : '✗';
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`);
};

async function main() {
  // ---- 0. Schema presence -------------------------------------------------
  // The tables shipped by 039/040. apply_all.sql stopped at 036 for a while, so
  // this is the check that catches a database the bundle never reached.
  for (const table of ['mcp_api_keys', 'social_automations', 'agent_memory', 'approvals']) {
    const { error } = await db.from(table).select('id').limit(1);
    if (error) record(`schema: ${table}`, 'FAIL', error.message);
    else record(`schema: ${table}`, 'PASS');
  }

  // ---- 1. Resolve an account ---------------------------------------------
  let accountId = process.env.SMOKE_ACCOUNT_ID;
  if (!accountId) {
    const { data } = await db.from('accounts').select('id').limit(1);
    accountId = data?.[0]?.id;
  }
  if (!accountId) {
    record('account', 'FAIL', 'no account row found; set SMOKE_ACCOUNT_ID');
    return summarize();
  }
  record('account', 'PASS', accountId);

  // ---- 2. Packet 1.1 — durable memory round-trip -------------------------
  // recordFact had zero callers before 1.1, so agent_memory was written by
  // nothing. This proves the write path works end to end.
  const marker = `smoke-test-${Date.now()}`;
  let factId: string | undefined;
  try {
    const { recordFact, listFacts, deleteFact } = await import('../lib/agent/memory');
    await recordFact(accountId, { fact: `${marker}: this account prefers concise weekly reporting.` });

    const facts = await listFacts(accountId, 25);
    const found = facts.find((f) => f.fact.includes(marker));
    factId = found?.id;

    if (!found) {
      record('memory: write + listFacts', 'FAIL', 'fact was written but did not come back');
    } else {
      record('memory: write + listFacts', 'PASS');

      // Embedding is best-effort by design (recordFact catches embed failures
      // and writes the row anyway), so absence is only a failure when the
      // embedding provider was actually configured.
      const { data: row } = await db.from('agent_memory')
        .select('embedding').eq('id', found.id).eq('account_id', accountId).maybeSingle();
      if (row?.embedding) record('memory: embedding present', 'PASS');
      else if (!process.env.NVIDIA_API_KEY) record('memory: embedding present', 'SKIP', 'NVIDIA_API_KEY unset');
      else record('memory: embedding present', 'FAIL', 'embedding null despite configured provider');

      // The secret guard must refuse credential-shaped facts at the WRITE, and
      // it covers both ingestion paths (the tool and passive extraction).
      const secret = `${marker}-secret: my api_key is abcd1234`;
      await recordFact(accountId, { fact: secret });
      const after = await listFacts(accountId, 50);
      if (after.some((f) => f.fact.includes(`${marker}-secret`))) {
        record('memory: secret guard', 'FAIL', 'a credential-shaped fact was stored');
      } else {
        record('memory: secret guard', 'PASS');
      }

      // Tenant scoping: deleting under a different account must not remove it.
      const removedByStranger = await deleteFact('00000000-0000-0000-0000-000000000000', found.id);
      record('memory: cross-account delete refused', removedByStranger ? 'FAIL' : 'PASS');
    }
  } catch (e: any) {
    record('memory: write + listFacts', 'FAIL', String(e?.message || e));
  }

  // ---- 3. Packet 0.2 — transcript is server-owned ------------------------
  // loadTranscript must never distinguish "not yours" from "empty".
  try {
    const { loadTranscript } = await import('../lib/agent/memory');
    const none = await loadTranscript(undefined, accountId);
    const unknown = await loadTranscript('00000000-0000-0000-0000-000000000000', accountId);
    const ok = Array.isArray(none) && none.length === 0 && Array.isArray(unknown) && unknown.length === 0;
    record('transcript: unknown id yields []', ok ? 'PASS' : 'FAIL');
  } catch (e: any) {
    record('transcript: unknown id yields []', 'FAIL', String(e?.message || e));
  }

  // ---- 4. Packet 0.3 — MCP key resolution --------------------------------
  // A bearer that matches nothing must resolve to null, not throw and not
  // return a permissive default.
  try {
    const { resolveMcpKey, hashBearer } = await import('../lib/mcp/keys');
    const resolved = await resolveMcpKey('definitely-not-a-real-key');
    record('mcp: unknown bearer -> null', resolved === null ? 'PASS' : 'FAIL');
    record('mcp: hashBearer is sha256 hex',
      /^[a-f0-9]{64}$/.test(hashBearer('x')) ? 'PASS' : 'FAIL');
  } catch (e: any) {
    record('mcp: unknown bearer -> null', 'FAIL', String(e?.message || e));
  }

  // ---- 5. Packet 2.1 / 2.2-S — registry integrity ------------------------
  // The registry throws at import if a capability is missing from
  // CATALOG_ORDER, so a successful import is itself the check.
  try {
    const { TOOLS, toolCatalogForPrompt } = await import('../lib/agent/tools');
    const names = Object.keys(TOOLS);
    record('registry: imports cleanly', 'PASS', `${names.length} capabilities`);

    const mustBeSensitive = ['publishSocialPost', 'enableSocialAutomation', 'sendEmail', 'launchCampaign'];
    const mustNotBe = ['rememberFact', 'listFacts', 'disableSocialAutomation', 'draftSocialPost'];
    const wrong = [
      ...mustBeSensitive.filter((n) => TOOLS[n] && !TOOLS[n].sensitive),
      ...mustNotBe.filter((n) => TOOLS[n] && TOOLS[n].sensitive),
    ];
    record('registry: gate classification', wrong.length ? 'FAIL' : 'PASS',
      wrong.length ? `misclassified: ${wrong.join(', ')}` : '');

    record('registry: catalog renders', toolCatalogForPrompt().length > 0 ? 'PASS' : 'FAIL');
  } catch (e: any) {
    record('registry: imports cleanly', 'FAIL', String(e?.message || e));
  }

  // ---- 6. Packet 2.2-S — automations are created disabled ----------------
  // The safety property that matters: no single approval can yield a live
  // auto-sender. Verified against the real table, including its CHECK.
  let automationId: string | undefined;
  try {
    const { data, error } = await db.from('social_automations').insert({
      account_id: accountId, platform: 'instagram', external_id: 'smoke-test',
      trigger: 'comment_received', match: { keywords: ['smoke'] }, action: 'notify',
      daily_cap: 25, enabled: false,
    }).select().single();
    if (error) throw error;
    automationId = data.id;
    record('automations: insert defaults disabled', data.enabled === false ? 'PASS' : 'FAIL');

    // The DB-level cap check must reject an over-cap rule even if code doesn't.
    const { error: capError } = await db.from('social_automations').insert({
      account_id: accountId, platform: 'instagram', external_id: 'smoke-test-cap',
      trigger: 'comment_received', match: {}, action: 'notify', daily_cap: 5000,
    }).select().single();
    record('automations: daily_cap CHECK enforced', capError ? 'PASS' : 'FAIL',
      capError ? '' : 'a rule with daily_cap=5000 was accepted');
  } catch (e: any) {
    record('automations: insert defaults disabled', 'FAIL', String(e?.message || e));
  } finally {
    if (automationId) await db.from('social_automations').delete().eq('id', automationId);
    await db.from('social_automations').delete().eq('external_id', 'smoke-test-cap');
  }

  // ---- 7. Cleanup ---------------------------------------------------------
  if (factId) await db.from('agent_memory').delete().eq('id', factId).eq('account_id', accountId);
  await db.from('agent_memory').delete().eq('account_id', accountId).like('fact', `${marker}%`);

  summarize();
}

function summarize() {
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const skip = results.filter((r) => r.status === 'SKIP').length;
  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
  if (fail) {
    console.log('\nFailures:');
    for (const r of results.filter((r) => r.status === 'FAIL')) console.log(`  ✗ ${r.name} — ${r.detail}`);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('smoke test crashed:', e); process.exit(1); });
