// Entity resolution did not exist before this change — the architecture note
// that prompted the work assumed context.ts already did it, and a grep for any
// message-to-record resolution across lib/ and app/ returned nothing.
//
// The property that matters most here is ABSTENTION. A false positive silently
// attaches one contact's memory to another and then feeds it to the model as
// established fact, which is worse than resolving nothing at all — so most of
// these assert what it must NOT match.

import { describe, it, expect, vi, beforeEach } from 'vitest';

let tables: Record<string, any[]> = {};

vi.mock('@/lib/db', () => ({
  supabase: {
    from(t: string) {
      const q: any = {
        select: () => q,
        eq: () => q,
        limit: () => Promise.resolve({ data: tables[t] ?? [], error: null }),
      };
      return q;
    },
  },
  dbReady: () => true,
}));

const CONTACTS = [
  { id: 'c1', name: 'Jane Doe', email: 'jane@acme.com' },
  { id: 'c2', name: 'Al', email: 'al@acme.com' },
  { id: 'c3', name: 'Sales', email: 'sales@acme.com' },
];
const COMPANIES = [{ id: 'co1', name: 'Acme', domain: 'acme.com' }];
const DEALS = [{ id: 'd1', name: 'Acme Renewal' }];

async function resolve(message?: string, extra: Record<string, any> = {}) {
  const { resolveSubjects } = await import('@/lib/memory/resolve');
  return resolveSubjects({ accountId: 'acct-1', message, ...extra });
}

describe('resolves what is clearly named', () => {
  beforeEach(() => {
    vi.resetModules();
    tables = { contacts: CONTACTS, companies: COMPANIES, deals: DEALS, ad_campaigns: [], segments: [] };
  });

  it('matches a contact by full name', async () => {
    const s = await resolve('What did Jane Doe say about pricing?');
    expect(s).toContainEqual({ type: 'contact', id: 'c1', label: 'Jane Doe' });
  });

  it('matches a contact by email even when the name is spelled differently', async () => {
    // The highest-precision signal available, and the one that survives the CRM
    // holding a different spelling than the message uses.
    const s = await resolve('Following up with jane@acme.com about the renewal');
    expect(s.some((x) => x.type === 'contact' && x.id === 'c1')).toBe(true);
  });

  it('matches a company by domain', async () => {
    const s = await resolve('Anything new from acme.com?');
    expect(s.some((x) => x.type === 'company' && x.id === 'co1')).toBe(true);
  });

  it('matches a deal by name', async () => {
    const s = await resolve('Where are we on the Acme Renewal?');
    expect(s.some((x) => x.type === 'deal' && x.id === 'd1')).toBe(true);
  });

  it('always includes the selected venture, even when unnamed', async () => {
    // Brand memory — voice rules, what the brand will not say — should condition
    // every turn in that venture, not only turns that mention it.
    const s = await resolve('Draft me a follow-up', { brandId: 'b1', brandName: 'RetentionRail' });
    expect(s[0]).toEqual({ type: 'brand', id: 'b1', label: 'RetentionRail' });
  });
});

describe('abstains rather than guessing', () => {
  beforeEach(() => {
    vi.resetModules();
    tables = { contacts: CONTACTS, companies: COMPANIES, deals: DEALS, ad_campaigns: [], segments: [] };
  });

  it('returns nothing for a message that names no record', async () => {
    expect(await resolve('what should I work on today?')).toEqual([]);
  });

  it('does not match a name too short to identify anybody', async () => {
    // "Al" would otherwise match inside dozens of ordinary words.
    const s = await resolve('Al is going to handle it');
    expect(s.some((x) => x.id === 'c2')).toBe(false);
  });

  it('does not match a single-word name that is a common CRM word', async () => {
    // A contact literally named "Sales" must not absorb every message that
    // mentions sales.
    const s = await resolve('How are sales looking this month?');
    expect(s.some((x) => x.id === 'c3')).toBe(false);
  });

  it('respects word boundaries — a name inside a longer word is not a match', async () => {
    tables.contacts = [{ id: 'c9', name: 'Ada', email: 'ada@x.com' }];
    const s = await resolve('Our adaptive campaign is live');
    expect(s.some((x) => x.id === 'c9')).toBe(false);
  });

  it('returns [] on an empty message rather than everything', async () => {
    expect(await resolve('')).toEqual([]);
    expect(await resolve(undefined)).toEqual([]);
  });

  it('degrades to [] when the database is unavailable', async () => {
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({
      supabase: { from() { throw new Error('db down'); } },
      dbReady: () => false,
    }));
    const { resolveSubjects } = await import('@/lib/memory/resolve');
    // A failed lookup must not fail the turn — the caller falls back to
    // account-scoped grounding exactly as it does today.
    await expect(resolveSubjects({ accountId: 'a', message: 'Jane Doe' })).resolves.toEqual([]);
  });
});

describe('bounds', () => {
  beforeEach(() => { vi.resetModules(); });

  it('caps how many subjects one turn may load', async () => {
    // A message naming many people is a list operation, not N subjects worth of
    // memory to splice into the prompt.
    tables = {
      contacts: Array.from({ length: 20 }, (_, i) => ({
        id: `c${i}`, name: `Personnumber${i}`, email: `p${i}@x.com`,
      })),
      companies: [], deals: [], ad_campaigns: [], segments: [],
    };
    const msg = Array.from({ length: 20 }, (_, i) => `Personnumber${i}`).join(', ');
    const s = await resolve(msg);
    expect(s.length).toBeLessThanOrEqual(4);
  });

  it('does not return the same subject twice', async () => {
    tables = { contacts: CONTACTS, companies: COMPANIES, deals: [], ad_campaigns: [], segments: [] };
    const s = await resolve('Jane Doe (jane@acme.com) asked about it');
    const ids = s.filter((x) => x.type === 'contact').map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
