// tests/count-capabilities.test.ts
//
// Why this file exists
// ---------------------
// There was no way to count anything, so the assistant answered "how many
// leads do I have" by calling listLeads and reading whole pages of rows —
// three sub-agents once listed the same table and reported 54, 56 and 61
// leads back, and a single 61-row listLeads call was 282K chars just to let
// the model eyeball a total.
//
// countLeads/countDeals/countCompanies (lib/capabilities/leads.ts,
// deals.ts, companies.ts) fix this by counting in the database — a real
// PostgREST aggregate (`count: 'exact', head: true`) for a plain total
// (countContacts/countDeals/countCompanies in lib/db.ts and lib/crm.ts), and
// a Postgres function (migration 085_count_functions.sql) for a grouped
// count, because PostgREST cannot portably express GROUP BY. Neither path
// fetches a row and tallies it in JS — that is the exact defect this exists
// to remove, so every test here that touches the query builder asserts
// `head: true` / an rpc() call, never a plain row-returning `select('*')`.
//
// This file mocks the Supabase client (at the '@supabase/supabase-js' layer
// for lib/db.ts, and at the '@/lib/db' layer for lib/crm.ts, since crm.ts
// imports the shared client from db.ts) — no real database.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// A minimal chainable query-builder mock standing in for Supabase's
// PostgrestFilterBuilder: every filter method returns `this` and records its
// call, and the object itself is a thenable so `await q` resolves the way
// the real client does.
// ---------------------------------------------------------------------------
function makeBuilder(result: { data?: any; count?: number | null; error?: any }) {
  const calls: { table?: string; selects: { cols: string; opts?: any }[]; eq: [string, any][]; is: [string, any][] } =
    { selects: [], eq: [], is: [] };
  const builder: any = {
    __calls: calls,
    select(cols: string, opts?: any) { calls.selects.push({ cols, opts }); return builder; },
    eq(col: string, val: any) { calls.eq.push([col, val]); return builder; },
    is(col: string, val: any) { calls.is.push([col, val]); return builder; },
    then(resolve: any, reject: any) { return Promise.resolve(result).then(resolve, reject); },
  };
  return builder;
}

function makeClient(selectResult: any, rpcResult: any = { data: [], error: null }) {
  const builder = makeBuilder(selectResult);
  const from = vi.fn((table: string) => { builder.__calls.table = table; return builder; });
  const rpc = vi.fn(async (..._args: any[]) => rpcResult);
  return { client: { from, rpc }, builder, from, rpc };
}

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock('@supabase/supabase-js');
  vi.doUnmock('@/lib/db');
  vi.doUnmock('@/lib/crm');
});

// ===========================================================================
// lib/db.ts — countContacts / countContactsGrouped
// ===========================================================================
describe('countContacts (lib/db)', () => {
  it('uses a real aggregate (head:true, count:exact) and never a row-returning select', async () => {
    const { client, builder } = makeClient({ count: 42, error: null });
    vi.doMock('@supabase/supabase-js', () => ({ createClient: () => client }));
    const { countContacts } = await import('@/lib/db');

    const total = await countContacts('acct_1', {});

    expect(total).toBe(42);
    expect(builder.__calls.table).toBe('contacts');
    // Every select() call in this path must be head:true/count:exact — no
    // call ever asks PostgREST to actually return rows.
    for (const s of builder.__calls.selects) {
      expect(s.opts).toMatchObject({ count: 'exact', head: true });
    }
    expect(builder.__calls.selects.length).toBeGreaterThan(0);
  });

  it('scopes by account_id and excludes soft-deleted rows', async () => {
    const { client, builder } = makeClient({ count: 5, error: null });
    vi.doMock('@supabase/supabase-js', () => ({ createClient: () => client }));
    const { countContacts } = await import('@/lib/db');

    await countContacts('acct_1', {});

    expect(builder.__calls.eq).toContainEqual(['account_id', 'acct_1']);
    expect(builder.__calls.is).toContainEqual(['deleted_at', null]);
  });

  it('a different account_id is what gets filtered on — never a global count', async () => {
    const { client, builder } = makeClient({ count: 7, error: null });
    vi.doMock('@supabase/supabase-js', () => ({ createClient: () => client }));
    const { countContacts } = await import('@/lib/db');

    await countContacts('acct_other', {});

    expect(builder.__calls.eq).toContainEqual(['account_id', 'acct_other']);
    expect(builder.__calls.eq.find(([k]: [string, any]) => k === 'account_id')?.[1]).not.toBe('acct_1');
  });

  it('applies brandId/status/segment filters as eq() clauses', async () => {
    const { client, builder } = makeClient({ count: 3, error: null });
    vi.doMock('@supabase/supabase-js', () => ({ createClient: () => client }));
    const { countContacts } = await import('@/lib/db');

    await countContacts('acct_1', { brandId: 'brand_1', status: 'qualified', segment: 'enterprise' });

    expect(builder.__calls.eq).toContainEqual(['brand_id', 'brand_1']);
    expect(builder.__calls.eq).toContainEqual(['status', 'qualified']);
    expect(builder.__calls.eq).toContainEqual(['segment', 'enterprise']);
  });

  it('a tag filter still uses head:true (joins, never fetches rows)', async () => {
    const { client, builder } = makeClient({ count: 2, error: null });
    vi.doMock('@supabase/supabase-js', () => ({ createClient: () => client }));
    const { countContacts } = await import('@/lib/db');

    await countContacts('acct_1', { tag: 'vip' });

    for (const s of builder.__calls.selects) {
      expect(s.opts).toMatchObject({ count: 'exact', head: true });
    }
    expect(builder.__calls.eq).toContainEqual(['contact_tags.tags.name', 'vip']);
  });
});

describe('countContactsGrouped (lib/db)', () => {
  it('computes the breakdown via the count_leads_grouped RPC, not a JS tally', async () => {
    const { client, rpc } = makeClient(
      { count: 0, error: null },
      { data: [{ group_value: 'brand_a', n: 30 }, { group_value: 'brand_b', n: 12 }], error: null },
    );
    vi.doMock('@supabase/supabase-js', () => ({ createClient: () => client }));
    const { countContactsGrouped } = await import('@/lib/db');

    const groups = await countContactsGrouped('acct_1', 'brand', { status: 'qualified' });

    expect(rpc).toHaveBeenCalledWith('count_leads_grouped', {
      p_account_id: 'acct_1',
      p_group_by: 'brand',
      p_brand_id: null,
      p_status: 'qualified',
      p_segment: null,
      p_tag: null,
    });
    expect(groups).toEqual([{ value: 'brand_a', count: 30 }, { value: 'brand_b', count: 12 }]);
  });
});

// ===========================================================================
// lib/crm.ts — countDeals / countDealsGrouped / countCompanies / countCompaniesGrouped
// ===========================================================================
describe('countDeals / countCompanies (lib/crm)', () => {
  it('countDeals uses head:true/count:exact, scoped by account and deleted_at', async () => {
    const { client, builder } = makeClient({ count: 8, error: null });
    vi.doMock('@/lib/db', () => ({ supabase: client }));
    const { countDeals } = await import('@/lib/crm');

    const total = await countDeals('acct_1', {});

    expect(total).toBe(8);
    expect(builder.__calls.table).toBe('deals');
    for (const s of builder.__calls.selects) expect(s.opts).toMatchObject({ count: 'exact', head: true });
    expect(builder.__calls.eq).toContainEqual(['account_id', 'acct_1']);
    expect(builder.__calls.is).toContainEqual(['deleted_at', null]);
  });

  it('countDealsGrouped uses the count_deals_grouped RPC', async () => {
    const { client, rpc } = makeClient(
      { count: 0, error: null },
      { data: [{ group_value: 'negotiation', n: 4 }], error: null },
    );
    vi.doMock('@/lib/db', () => ({ supabase: client }));
    const { countDealsGrouped } = await import('@/lib/crm');

    const groups = await countDealsGrouped('acct_1', 'stage', { brandId: 'brand_1' });

    expect(rpc).toHaveBeenCalledWith('count_deals_grouped', {
      p_account_id: 'acct_1', p_group_by: 'stage', p_brand_id: 'brand_1', p_stage: null,
    });
    expect(groups).toEqual([{ value: 'negotiation', count: 4 }]);
  });

  it('countCompanies uses head:true/count:exact, scoped by account and deleted_at', async () => {
    const { client, builder } = makeClient({ count: 9, error: null });
    vi.doMock('@/lib/db', () => ({ supabase: client }));
    const { countCompanies } = await import('@/lib/crm');

    const total = await countCompanies('acct_1', {});

    expect(total).toBe(9);
    expect(builder.__calls.table).toBe('companies');
    for (const s of builder.__calls.selects) expect(s.opts).toMatchObject({ count: 'exact', head: true });
    expect(builder.__calls.eq).toContainEqual(['account_id', 'acct_1']);
    expect(builder.__calls.is).toContainEqual(['deleted_at', null]);
  });

  it('countCompaniesGrouped uses the count_companies_grouped RPC', async () => {
    const { client, rpc } = makeClient(
      { count: 0, error: null },
      { data: [{ group_value: 'software', n: 6 }, { group_value: '(none)', n: 3 }], error: null },
    );
    vi.doMock('@/lib/db', () => ({ supabase: client }));
    const { countCompaniesGrouped } = await import('@/lib/crm');

    const groups = await countCompaniesGrouped('acct_1', 'industry', {});

    expect(rpc).toHaveBeenCalledWith('count_companies_grouped', {
      p_account_id: 'acct_1', p_group_by: 'industry', p_brand_id: null,
    });
    expect(groups).toEqual([{ value: 'software', count: 6 }, { value: '(none)', count: 3 }]);
  });
});

// ===========================================================================
// Capability layer — countLeads / countDeals / countCompanies
// ===========================================================================
async function loadCountLeads(countContacts: any, countContactsGrouped: any, assertBrandOwned: any) {
  vi.doMock('@/lib/db', () => ({
    supabase: {}, getContacts: vi.fn(), updateContact: vi.fn(), createContact: vi.fn(),
    assertBrandOwned, countContacts, countContactsGrouped,
  }));
  vi.doMock('@/lib/integrations/apollo', () => ({ searchPeople: vi.fn(), matchPerson: vi.fn() }));
  vi.doMock('@/lib/tags', () => ({ listTags: vi.fn(), addTagToContact: vi.fn() }));
  const { LEAD_CAPABILITIES } = await import('@/lib/capabilities/leads');
  return LEAD_CAPABILITIES.find((c) => c.name === 'countLeads')!;
}

async function loadCountDeals(countDeals: any, countDealsGrouped: any, assertBrandOwned: any) {
  vi.doMock('@/lib/db', () => ({ assertBrandOwned }));
  vi.doMock('@/lib/crm', () => ({
    getDeals: vi.fn(), getDeal: vi.fn(), updateDeal: vi.fn(), deleteDeal: vi.fn(),
    getActivities: vi.fn(), createActivity: vi.fn(), countDeals, countDealsGrouped,
  }));
  const { DEAL_CAPABILITIES } = await import('@/lib/capabilities/deals');
  return DEAL_CAPABILITIES.find((c) => c.name === 'countDeals')!;
}

async function loadCountCompanies(countCompanies: any, countCompaniesGrouped: any, assertBrandOwned: any) {
  vi.doMock('@/lib/db', () => ({ assertBrandOwned }));
  vi.doMock('@/lib/crm', () => ({
    getCompanies: vi.fn(), getCompany: vi.fn(), createCompany: vi.fn(), linkContactCompany: vi.fn(),
    countCompanies, countCompaniesGrouped,
  }));
  const { COMPANY_CAPABILITIES } = await import('@/lib/capabilities/companies');
  return COMPANY_CAPABILITIES.find((c) => c.name === 'countCompanies')!;
}

describe('countLeads capability', () => {
  it('returns just a total when groupBy is omitted, without calling the grouped RPC path', async () => {
    const countContacts = vi.fn(async () => 25);
    const countContactsGrouped = vi.fn();
    const assertBrandOwned = vi.fn(async () => true);
    const cap = await loadCountLeads(countContacts, countContactsGrouped, assertBrandOwned);

    const result = await cap.run('acct_1', {});

    expect(result).toEqual({ total: 25 });
    expect(countContactsGrouped).not.toHaveBeenCalled();
  });

  it('returns groups when groupBy is set', async () => {
    const countContacts = vi.fn(async () => 25);
    const countContactsGrouped = vi.fn(async () => [{ value: 'new', count: 10 }, { value: 'qualified', count: 15 }]);
    const assertBrandOwned = vi.fn(async () => true);
    const cap = await loadCountLeads(countContacts, countContactsGrouped, assertBrandOwned);

    const result: any = await cap.run('acct_1', { groupBy: 'status' });

    expect(result.total).toBe(25);
    expect(result.groupBy).toBe('status');
    expect(result.groups).toEqual([{ value: 'new', count: 10 }, { value: 'qualified', count: 15 }]);
  });

  it('ownership-checks a supplied brandId and throws "Brand not found" when unowned', async () => {
    const countContacts = vi.fn(async () => 0);
    const countContactsGrouped = vi.fn();
    const assertBrandOwned = vi.fn(async () => false);
    const cap = await loadCountLeads(countContacts, countContactsGrouped, assertBrandOwned);

    await expect(cap.run('acct_1', { brandId: 'brand_evil' })).rejects.toThrow('Brand not found');
    expect(countContacts).not.toHaveBeenCalled();
  });

  it('passes an owned brandId through to countContacts', async () => {
    const countContacts = vi.fn(async () => 4);
    const countContactsGrouped = vi.fn();
    const assertBrandOwned = vi.fn(async () => true);
    const cap = await loadCountLeads(countContacts, countContactsGrouped, assertBrandOwned);

    await cap.run('acct_1', { brandId: 'brand_1' });

    expect(assertBrandOwned).toHaveBeenCalledWith('brand_1', 'acct_1');
    expect(countContacts).toHaveBeenCalledWith('acct_1', expect.objectContaining({ brandId: 'brand_1' }));
  });

  it('the serialised result stays well under 2,000 chars for a large fabricated account', async () => {
    // A fabricated account with 60 distinct segment values (unrealistically
    // many, to stress-test rather than merely satisfy the bound).
    const bigGroups = Array.from({ length: 60 }, (_, i) => ({ value: `segment_${i}`, count: 1000 - i }));
    const countContacts = vi.fn(async () => 58000);
    const countContactsGrouped = vi.fn(async () => bigGroups);
    const assertBrandOwned = vi.fn(async () => true);
    const cap = await loadCountLeads(countContacts, countContactsGrouped, assertBrandOwned);

    const result = await cap.run('acct_1', { groupBy: 'segment' });

    expect(JSON.stringify(result).length).toBeLessThan(2000);
  });
});

describe('countLeads digest', () => {
  it('states the total and nothing about groups when there are none', async () => {
    const cap = await loadCountLeads(vi.fn(), vi.fn(), vi.fn());
    const line = cap.digest!({}, { total: 61 });
    expect(line).toContain('61 leads total');
    expect(line).not.toMatch(/by /i);
  });

  it('states the breakdown when groups are present', async () => {
    const cap = await loadCountLeads(vi.fn(), vi.fn(), vi.fn());
    const line = cap.digest!({}, { total: 25, groupBy: 'status', groups: [{ value: 'new', count: 10 }, { value: 'qualified', count: 15 }] });
    expect(line).toContain('25 leads total');
    expect(line).toContain('By status:');
    expect(line).toContain('new: 10');
    expect(line).toContain('qualified: 15');
  });

  it('emits nothing for a malformed/absent total, never fabricating one', async () => {
    const cap = await loadCountLeads(vi.fn(), vi.fn(), vi.fn());
    expect(cap.digest!({}, {})).toBe('');
    expect(cap.digest!({}, null)).toBe('');
    expect(cap.digest!({}, [])).toBe('');
  });
});

describe('countDeals capability', () => {
  it('returns a total, and groups when groupBy is set', async () => {
    const countDeals = vi.fn(async () => 12);
    const countDealsGrouped = vi.fn(async () => [{ value: 'negotiation', count: 5 }]);
    const assertBrandOwned = vi.fn(async () => true);
    const cap = await loadCountDeals(countDeals, countDealsGrouped, assertBrandOwned);

    const noGroup = await cap.run('acct_1', {});
    expect(noGroup).toEqual({ total: 12 });
    expect(countDealsGrouped).not.toHaveBeenCalled();

    const grouped: any = await cap.run('acct_1', { groupBy: 'stage' });
    expect(grouped.groups).toEqual([{ value: 'negotiation', count: 5 }]);
  });

  it('ownership-checks brandId and throws "Brand not found" when unowned', async () => {
    const countDeals = vi.fn(async () => 0);
    const countDealsGrouped = vi.fn();
    const assertBrandOwned = vi.fn(async () => false);
    const cap = await loadCountDeals(countDeals, countDealsGrouped, assertBrandOwned);

    await expect(cap.run('acct_1', { brandId: 'brand_evil' })).rejects.toThrow('Brand not found');
    expect(countDeals).not.toHaveBeenCalled();
  });

  it('digest states only the total when ungrouped, and the breakdown when grouped', async () => {
    const cap = await loadCountDeals(vi.fn(), vi.fn(), vi.fn());
    expect(cap.digest!({}, { total: 8 })).toBe('8 deals total.');
    const line = cap.digest!({}, { total: 8, groupBy: 'brand', groups: [{ value: 'brand_a', count: 8 }] });
    expect(line).toContain('By brand: brand_a: 8');
  });
});

describe('countCompanies capability', () => {
  it('returns a total, and groups when groupBy is set', async () => {
    const countCompanies = vi.fn(async () => 9);
    const countCompaniesGrouped = vi.fn(async () => [{ value: 'software', count: 6 }, { value: '(none)', count: 3 }]);
    const assertBrandOwned = vi.fn(async () => true);
    const cap = await loadCountCompanies(countCompanies, countCompaniesGrouped, assertBrandOwned);

    const noGroup = await cap.run('acct_1', {});
    expect(noGroup).toEqual({ total: 9 });

    const grouped: any = await cap.run('acct_1', { groupBy: 'industry' });
    expect(grouped.groups).toEqual([{ value: 'software', count: 6 }, { value: '(none)', count: 3 }]);
  });

  it('ownership-checks brandId and throws "Brand not found" when unowned', async () => {
    const countCompanies = vi.fn(async () => 0);
    const countCompaniesGrouped = vi.fn();
    const assertBrandOwned = vi.fn(async () => false);
    const cap = await loadCountCompanies(countCompanies, countCompaniesGrouped, assertBrandOwned);

    await expect(cap.run('acct_1', { brandId: 'brand_evil' })).rejects.toThrow('Brand not found');
    expect(countCompanies).not.toHaveBeenCalled();
  });

  it('digest is truthful: "companies" pluralization, and only states groups that exist', async () => {
    const cap = await loadCountCompanies(vi.fn(), vi.fn(), vi.fn());
    expect(cap.digest!({}, { total: 1 })).toBe('1 company total.');
    expect(cap.digest!({}, { total: 9 })).toBe('9 companies total.');
    expect(cap.digest!({}, {})).toBe('');
  });
});
