// listSelectableModels / assertSelectableModel (lib/ai/providers.ts) — the
// REAL functions, against a fake supabase client (same pattern as
// tests/plan-store-batch.test.ts / tests/plan-capabilities-start.test.ts for
// lib/plans/store), not a mock of '@/lib/ai/providers'.
//
// tests/agent-model-picker-route.test.ts mocks '@/lib/ai/providers' with its
// own assertSelectableModel stub, so it only pins that the ROUTE calls the
// validator — it says nothing about whether the validator itself validates.
// This file is the other half: the tenant-isolation property lives in
// listSelectableModels' account-scoped join (ai_models scoped through
// ai_providers.account_id), and until this file existed nothing in tests/
// exercised that join for real.

import { describe, it, expect, vi, beforeEach } from 'vitest';

let providers: any[] = [];
let models: any[] = [];

/** Generic fluent fake, modelled on tests/plan-store-batch.test.ts's
 *  makeClient(): each table's rows are filtered by a list of predicates
 *  accumulated from .eq()/.in() calls, and the query resolves when awaited
 *  (a thenable), matching how listSelectableModels calls it (no .single()/
 *  .maybeSingle() needed here — both queries in lib/ai/providers.ts just
 *  await the builder directly). */
function makeClient() {
  function table(name: string) {
    const rows = () => (name === 'ai_providers' ? providers : models);
    const q: any = {
      _f: [] as ((r: any) => boolean)[],
      select() { return q; },
      eq(c: string, v: any) { q._f.push((r: any) => r[c] === v); return q; },
      in(c: string, v: any[]) { q._f.push((r: any) => v.includes(r[c])); return q; },
      order() { return q; },
      then(resolve: any) {
        const matched = rows().filter((r) => q._f.every((f: any) => f(r)));
        return resolve({ data: matched, error: null });
      },
    };
    return q;
  }
  return { from: (t: string) => table(t) };
}

vi.mock('@/lib/db', () => ({ supabase: makeClient(), dbReady: () => true }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() } }));

async function mod() { return import('@/lib/ai/providers'); }

const ACC = 'acct-1';
const OTHER_ACC = 'acct-2';

beforeEach(() => {
  vi.resetModules();
  providers = [
    { id: 'prov-1', account_id: ACC, name: 'Anthropic', enabled: true },
    { id: 'prov-2', account_id: ACC, name: 'Disabled Co', enabled: false },
    { id: 'prov-3', account_id: OTHER_ACC, name: 'Other Tenant', enabled: true },
  ];
  models = [
    { id: 'model-mine', provider_id: 'prov-1', model_id: 'claude-sonnet-5', label: 'Claude Sonnet 5', tier: 'heavy', enabled: true, created_at: '2026-01-01' },
    { id: 'model-disabled', provider_id: 'prov-1', model_id: 'claude-old', label: 'Claude Old', tier: 'fast', enabled: false, created_at: '2026-01-02' },
    { id: 'model-behind-disabled-provider', provider_id: 'prov-2', model_id: 'some-model', label: 'Some Model', tier: 'fast', enabled: true, created_at: '2026-01-03' },
    { id: 'model-other-tenant', provider_id: 'prov-3', model_id: 'other-tenant-model', label: 'Other Tenant Model', tier: 'fast', enabled: true, created_at: '2026-01-04' },
  ];
});

describe('listSelectableModels — real function, real join, fake DB', () => {
  it('returns only this account\'s enabled models through enabled providers', async () => {
    const { listSelectableModels } = await mod();
    const result = await listSelectableModels(ACC);
    expect(result.map((m) => m.id)).toEqual(['model-mine']);
    expect(result[0]).toMatchObject({ model_id: 'claude-sonnet-5', provider: 'Anthropic' });
  });

  it('an account with no providers returns [] rather than throwing', async () => {
    const { listSelectableModels } = await mod();
    const result = await listSelectableModels('acct-with-nothing');
    expect(result).toEqual([]);
  });
});

describe('assertSelectableModel — real function, real join, fake DB', () => {
  it('an id belonging to THIS account\'s enabled models comes back unchanged', async () => {
    const { assertSelectableModel } = await mod();
    await expect(assertSelectableModel(ACC, 'model-mine')).resolves.toBe('model-mine');
  });

  it('TENANT ISOLATION: an id belonging to ANOTHER account\'s provider returns undefined', async () => {
    const { assertSelectableModel } = await mod();
    await expect(assertSelectableModel(ACC, 'model-other-tenant')).resolves.toBeUndefined();
  });

  it('an id that exists but whose model is disabled returns undefined', async () => {
    const { assertSelectableModel } = await mod();
    await expect(assertSelectableModel(ACC, 'model-disabled')).resolves.toBeUndefined();
  });

  it('an id that exists but whose PROVIDER is disabled returns undefined', async () => {
    const { assertSelectableModel } = await mod();
    await expect(assertSelectableModel(ACC, 'model-behind-disabled-provider')).resolves.toBeUndefined();
  });

  it('undefined in, undefined out', async () => {
    const { assertSelectableModel } = await mod();
    await expect(assertSelectableModel(ACC, undefined)).resolves.toBeUndefined();
  });

  it('an account with no providers returns undefined rather than throwing', async () => {
    const { assertSelectableModel } = await mod();
    await expect(assertSelectableModel('acct-with-nothing', 'model-mine')).resolves.toBeUndefined();
  });
});
