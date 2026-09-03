// tests/list-capability-projection.test.ts
//
// Why this file exists
// ---------------------
// listLeads/listDeals/listCompanies previously did `select('*')` under the
// hood and handed the WHOLE row back to the model. Measured: a contact row
// averages ~4,871 chars, ~4,070 of it a raw Apollo enrichment blob (largest
// observed 66,542 chars) that the model never reasons over — it only ever
// needs name/title/company/status. A single 61-lead listLeads call produced
// a 281,956-char tool observation that then rode along on ~40 later model
// calls in the same conversation (~2.8M tokens for one read).
//
// The fix is `projectRows` (lib/capabilities/types.ts) applied inside each
// list capability's `run`. This file is the contract test for that: given a
// fabricated fat row, the projected result must drop every unlisted key and
// stay small, must never fabricate an absent key, and must pass through
// anything that isn't an array of plain objects untouched. It also covers
// limit clamping and the new listLeads brandId ownership check.
//
// getContacts/getDeals/getCompanies themselves are NOT touched by the fix —
// they're shared with the UI pages, which legitimately need full rows — so
// this file mocks lib/db and lib/crm rather than hitting a real database.

import { describe, it, expect, vi } from 'vitest';

// A big raw Apollo-shaped enrichment blob, standing in for the real thing.
const BIG_BLOB = 'x'.repeat(60_000);

function fatContactRow(overrides: Record<string, any> = {}) {
  return {
    id: 'c1',
    name: 'Jane Doe',
    title: 'VP Sales',
    company: 'Acme Inc',
    email: 'jane@acme.com',
    status: 'qualified',
    score: 87,
    segment: 'enterprise',
    brand_id: 'brand_1',
    enrichment_status: 'enriched',
    created_at: '2026-01-01T00:00:00Z',
    // Fields that must NOT survive projection:
    enriched: BIG_BLOB,
    raw_apollo: { bio: BIG_BLOB, employment_history: [{ title: 'x'.repeat(1000) }] },
    phone: '+15551234567',
    internal_notes: 'some private note',
    account_id: 'acct_1',
    ...overrides,
  };
}

function fatDealRow(overrides: Record<string, any> = {}) {
  return {
    id: 'd1',
    title: 'Acme renewal',
    name: 'Acme renewal',
    value: 50000,
    amount: 50000,
    stage: 'negotiation',
    stage_id: 'stage_3',
    status: 'open',
    company: 'Acme Inc',
    contact_id: 'c1',
    brand_id: 'brand_1',
    created_at: '2026-01-01T00:00:00Z',
    raw_apollo: { blob: BIG_BLOB },
    account_id: 'acct_1',
    ...overrides,
  };
}

function fatCompanyRow(overrides: Record<string, any> = {}) {
  return {
    id: 'co1',
    name: 'Acme Inc',
    domain: 'acme.com',
    industry: 'software',
    size: '51-200',
    employee_count: 120,
    brand_id: 'brand_1',
    created_at: '2026-01-01T00:00:00Z',
    raw_apollo: { blob: BIG_BLOB },
    account_id: 'acct_1',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// projectRows unit tests (no mocking needed — pure function)
// ---------------------------------------------------------------------------
describe('projectRows', () => {
  it('drops unlisted keys and keeps listed ones', async () => {
    const { projectRows } = await import('@/lib/capabilities/types');
    const rows = [fatContactRow()];
    const out: any = projectRows(rows, ['id', 'name', 'company', 'status']);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ id: 'c1', name: 'Jane Doe', company: 'Acme Inc', status: 'qualified' });
    expect(out[0]).not.toHaveProperty('enriched');
    expect(out[0]).not.toHaveProperty('raw_apollo');
    expect(out[0]).not.toHaveProperty('account_id');
  });

  it('never fabricates an absent key', async () => {
    const { projectRows } = await import('@/lib/capabilities/types');
    const rows = [{ id: 'c1', name: 'Jane' }]; // no `score`
    const out: any = projectRows(rows, ['id', 'name', 'score']);
    expect(out[0]).toEqual({ id: 'c1', name: 'Jane' });
    expect('score' in out[0]).toBe(false);
  });

  it('passes through a non-array result untouched', async () => {
    const { projectRows } = await import('@/lib/capabilities/types');
    const obj = { id: 'x', enriched: BIG_BLOB };
    expect(projectRows(obj, ['id'])).toBe(obj);
    expect(projectRows(null, ['id'])).toBe(null);
    expect(projectRows('oops', ['id'])).toBe('oops');
  });

  it('passes through non-object array entries untouched', async () => {
    const { projectRows } = await import('@/lib/capabilities/types');
    const rows = ['a', 'b'];
    expect(projectRows(rows, ['id'])).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// Contract test: each list capability projects fat rows down to a small,
// field-limited summary.
// ---------------------------------------------------------------------------
describe('list capability projection contract', () => {
  it('listLeads drops unlisted keys and stays under 600 chars/row', async () => {
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({
      supabase: {},
      getContacts: vi.fn(async () => [fatContactRow(), fatContactRow({ id: 'c2' })]),
      updateContact: vi.fn(),
      createContact: vi.fn(),
      assertBrandOwned: vi.fn(async () => true),
    }));
    vi.doMock('@/lib/integrations/apollo', () => ({ searchPeople: vi.fn(), matchPerson: vi.fn() }));
    vi.doMock('@/lib/tags', () => ({ listTags: vi.fn(), addTagToContact: vi.fn() }));

    const { LEAD_CAPABILITIES } = await import('@/lib/capabilities/leads');
    const listLeads = LEAD_CAPABILITIES.find((c) => c.name === 'listLeads')!;
    const result: any = await listLeads.run('acct_1', {});

    expect(result).toHaveLength(2);
    for (const row of result) {
      expect(row).not.toHaveProperty('enriched');
      expect(row).not.toHaveProperty('raw_apollo');
      expect(row).not.toHaveProperty('phone');
      expect(row).not.toHaveProperty('internal_notes');
      expect(row).not.toHaveProperty('account_id');
      expect(JSON.stringify(row).length).toBeLessThan(600);
    }
    // Fields the digest depends on must survive.
    expect(result[0]).toMatchObject({ id: 'c1', name: 'Jane Doe', company: 'Acme Inc', status: 'qualified', score: 87 });

    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/integrations/apollo');
    vi.doUnmock('@/lib/tags');
  });

  it('listDeals drops unlisted keys and stays under 600 chars/row', async () => {
    vi.resetModules();
    vi.doMock('@/lib/crm', () => ({
      getDeals: vi.fn(async () => [fatDealRow()]),
      getDeal: vi.fn(),
      updateDeal: vi.fn(),
      deleteDeal: vi.fn(),
      getActivities: vi.fn(),
      createActivity: vi.fn(),
    }));

    const { DEAL_CAPABILITIES } = await import('@/lib/capabilities/deals');
    const listDeals = DEAL_CAPABILITIES.find((c) => c.name === 'listDeals')!;
    const result: any = await listDeals.run('acct_1', {});

    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty('raw_apollo');
    expect(result[0]).not.toHaveProperty('account_id');
    expect(JSON.stringify(result[0]).length).toBeLessThan(600);
    expect(result[0]).toMatchObject({ id: 'd1', title: 'Acme renewal', stage: 'negotiation', status: 'open' });

    vi.doUnmock('@/lib/crm');
  });

  it('listCompanies drops unlisted keys and stays under 600 chars/row', async () => {
    vi.resetModules();
    vi.doMock('@/lib/crm', () => ({
      getCompanies: vi.fn(async () => [fatCompanyRow()]),
      getCompany: vi.fn(),
      createCompany: vi.fn(),
      linkContactCompany: vi.fn(),
    }));

    const { COMPANY_CAPABILITIES } = await import('@/lib/capabilities/companies');
    const listCompanies = COMPANY_CAPABILITIES.find((c) => c.name === 'listCompanies')!;
    const result: any = await listCompanies.run('acct_1', {});

    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty('raw_apollo');
    expect(result[0]).not.toHaveProperty('account_id');
    expect(JSON.stringify(result[0]).length).toBeLessThan(600);
    expect(result[0]).toMatchObject({ id: 'co1', name: 'Acme Inc', domain: 'acme.com' });

    vi.doUnmock('@/lib/crm');
  });
});

// ---------------------------------------------------------------------------
// Limit clamping
// ---------------------------------------------------------------------------
describe('list capability limit clamping', () => {
  it('listLeads defaults to 25 and clamps to a max of 100', async () => {
    vi.resetModules();
    const getContacts = vi.fn(async () => []);
    vi.doMock('@/lib/db', () => ({
      supabase: {},
      getContacts,
      updateContact: vi.fn(),
      createContact: vi.fn(),
      assertBrandOwned: vi.fn(async () => true),
    }));
    vi.doMock('@/lib/integrations/apollo', () => ({ searchPeople: vi.fn(), matchPerson: vi.fn() }));
    vi.doMock('@/lib/tags', () => ({ listTags: vi.fn(), addTagToContact: vi.fn() }));

    const { LEAD_CAPABILITIES } = await import('@/lib/capabilities/leads');
    const listLeads = LEAD_CAPABILITIES.find((c) => c.name === 'listLeads')!;

    await listLeads.run('acct_1', {});
    expect(getContacts).toHaveBeenCalledWith('acct_1', 'all', 25, 0);

    await listLeads.run('acct_1', { limit: 9999 });
    expect(getContacts).toHaveBeenLastCalledWith('acct_1', 'all', 100, 0);

    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/integrations/apollo');
    vi.doUnmock('@/lib/tags');
  });

  it('listDeals defaults to 50 and clamps to a max of 200', async () => {
    vi.resetModules();
    const getDeals = vi.fn(async () => []);
    vi.doMock('@/lib/crm', () => ({
      getDeals, getDeal: vi.fn(), updateDeal: vi.fn(), deleteDeal: vi.fn(),
      getActivities: vi.fn(), createActivity: vi.fn(),
    }));

    const { DEAL_CAPABILITIES } = await import('@/lib/capabilities/deals');
    const listDeals = DEAL_CAPABILITIES.find((c) => c.name === 'listDeals')!;

    await listDeals.run('acct_1', {});
    expect(getDeals).toHaveBeenCalledWith('acct_1', undefined, 50, 0);

    await listDeals.run('acct_1', { limit: 9999 });
    expect(getDeals).toHaveBeenLastCalledWith('acct_1', undefined, 200, 0);

    vi.doUnmock('@/lib/crm');
  });

  it('listCompanies defaults to 25 and clamps to a max of 100', async () => {
    vi.resetModules();
    const getCompanies = vi.fn(async () => []);
    vi.doMock('@/lib/crm', () => ({
      getCompanies, getCompany: vi.fn(), createCompany: vi.fn(), linkContactCompany: vi.fn(),
    }));

    const { COMPANY_CAPABILITIES } = await import('@/lib/capabilities/companies');
    const listCompanies = COMPANY_CAPABILITIES.find((c) => c.name === 'listCompanies')!;

    await listCompanies.run('acct_1', {});
    expect(getCompanies).toHaveBeenCalledWith('acct_1', undefined, 25, 0);

    await listCompanies.run('acct_1', { limit: 9999 });
    expect(getCompanies).toHaveBeenLastCalledWith('acct_1', undefined, 100, 0);

    vi.doUnmock('@/lib/crm');
  });
});

// ---------------------------------------------------------------------------
// listLeads brandId ownership
// ---------------------------------------------------------------------------
describe('listLeads brandId scoping', () => {
  it('scopes to brandId and passes it to getContacts when owned', async () => {
    vi.resetModules();
    const getContacts = vi.fn(async () => []);
    const assertBrandOwned = vi.fn(async () => true);
    vi.doMock('@/lib/db', () => ({
      supabase: {}, getContacts, updateContact: vi.fn(), createContact: vi.fn(), assertBrandOwned,
    }));
    vi.doMock('@/lib/integrations/apollo', () => ({ searchPeople: vi.fn(), matchPerson: vi.fn() }));
    vi.doMock('@/lib/tags', () => ({ listTags: vi.fn(), addTagToContact: vi.fn() }));

    const { LEAD_CAPABILITIES } = await import('@/lib/capabilities/leads');
    const listLeads = LEAD_CAPABILITIES.find((c) => c.name === 'listLeads')!;

    await listLeads.run('acct_1', { brandId: 'brand_1' });
    expect(assertBrandOwned).toHaveBeenCalledWith('brand_1', 'acct_1');
    expect(getContacts).toHaveBeenCalledWith('acct_1', 'brand_1', 25, 0);

    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/integrations/apollo');
    vi.doUnmock('@/lib/tags');
  });

  it('throws "Brand not found" for an unowned brandId, and never calls getContacts', async () => {
    vi.resetModules();
    const getContacts = vi.fn(async () => []);
    const assertBrandOwned = vi.fn(async () => false);
    vi.doMock('@/lib/db', () => ({
      supabase: {}, getContacts, updateContact: vi.fn(), createContact: vi.fn(), assertBrandOwned,
    }));
    vi.doMock('@/lib/integrations/apollo', () => ({ searchPeople: vi.fn(), matchPerson: vi.fn() }));
    vi.doMock('@/lib/tags', () => ({ listTags: vi.fn(), addTagToContact: vi.fn() }));

    const { LEAD_CAPABILITIES } = await import('@/lib/capabilities/leads');
    const listLeads = LEAD_CAPABILITIES.find((c) => c.name === 'listLeads')!;

    await expect(listLeads.run('acct_1', { brandId: 'brand_evil' })).rejects.toThrow('Brand not found');
    expect(getContacts).not.toHaveBeenCalled();

    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/integrations/apollo');
    vi.doUnmock('@/lib/tags');
  });

  it('keeps today\'s behaviour ("all") when brandId is absent', async () => {
    vi.resetModules();
    const getContacts = vi.fn(async () => []);
    const assertBrandOwned = vi.fn(async () => true);
    vi.doMock('@/lib/db', () => ({
      supabase: {}, getContacts, updateContact: vi.fn(), createContact: vi.fn(), assertBrandOwned,
    }));
    vi.doMock('@/lib/integrations/apollo', () => ({ searchPeople: vi.fn(), matchPerson: vi.fn() }));
    vi.doMock('@/lib/tags', () => ({ listTags: vi.fn(), addTagToContact: vi.fn() }));

    const { LEAD_CAPABILITIES } = await import('@/lib/capabilities/leads');
    const listLeads = LEAD_CAPABILITIES.find((c) => c.name === 'listLeads')!;

    await listLeads.run('acct_1', {});
    expect(assertBrandOwned).not.toHaveBeenCalled();
    expect(getContacts).toHaveBeenCalledWith('acct_1', 'all', 25, 0);

    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/integrations/apollo');
    vi.doUnmock('@/lib/tags');
  });
});
