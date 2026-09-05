// tests/generations-capabilities.test.ts — the review surface: listGenerations,
// reviewGeneration, promoteGenerationToContent.
//
// lib/content/store.ts's createContentItem/updateContentItem are the real
// functions (only their supabase surface is faked) — promoteGenerationToContent
// must reuse them, never write content_items itself (see the module header).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// A minimal fake supabase supporting BOTH `generations` and `content_items`
// tables, since promoteGenerationToContent touches both through their real
// store modules.
const TABLES: Record<string, any[]> = { generations: [], content_items: [] };
let nextId = 1;

function applyFilters(rows: any[], filters: ((r: any) => boolean)[]) {
  return rows.filter((r) => filters.every((f) => f(r)));
}

function makeQuery(table: string) {
  const filters: ((r: any) => boolean)[] = [];
  let mode: 'select' | 'insert' | 'update' | 'delete' | null = null;
  let payload: any = null;
  let singleMode: 'single' | 'maybeSingle' | null = null;

  const api: any = {
    insert(rows: any[]) { mode = 'insert'; payload = rows; return api; },
    update(patch: any) { mode = 'update'; payload = patch; return api; },
    delete() { mode = 'delete'; return api; },
    select() { if (!mode) mode = 'select'; return api; },
    eq(field: string, value: any) { filters.push((r) => r[field] === value); return api; },
    neq(field: string, value: any) { filters.push((r) => r[field] !== value); return api; },
    order() { return api; },
    limit() { return api; },
    single() { singleMode = 'single'; return exec(); },
    maybeSingle() { singleMode = 'maybeSingle'; return exec(); },
    then(resolve: any, reject: any) { return exec().then(resolve, reject); },
  };

  async function exec(): Promise<{ data: any; error: any }> {
    const rows = TABLES[table];
    if (mode === 'insert') {
      const inserted = (payload as any[]).map((r) => ({
        id: `${table}-${nextId++}`, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...r,
      }));
      rows.push(...inserted);
      return singleMode ? { data: inserted[0], error: null } : { data: inserted, error: null };
    }
    if (mode === 'select') {
      const result = applyFilters(rows, filters);
      if (singleMode === 'single') return { data: result[0] ?? null, error: result[0] ? null : { message: 'not found' } };
      if (singleMode === 'maybeSingle') return { data: result[0] ?? null, error: null };
      return { data: result, error: null };
    }
    if (mode === 'update') {
      const matched = applyFilters(rows, filters);
      matched.forEach((r) => Object.assign(r, payload));
      if (singleMode) return { data: matched[0] ?? null, error: matched[0] ? null : { message: 'not found' } };
      return { data: matched, error: null };
    }
    return { data: null, error: null };
  }
  return api;
}

vi.mock('@/lib/db', () => ({
  supabase: { from: (table: string) => makeQuery(table) },
  dbReady: () => true,
}));

const signUrlMock = vi.fn(async (_bucket: string, path: string, _ttl: number) => `https://storage.example/${path}?sig=fresh`);
vi.mock('@/lib/storage', () => ({
  GENERATED_BUCKET: 'generated-media',
  GENERATED_URL_TTL: 60 * 60 * 24,
  signUrl: (bucket: string, path: string, ttl: number) => signUrlMock(bucket, path, ttl),
  uploadGenerated: vi.fn(),
  removeObjects: vi.fn(),
}));

const { GENERATIONS_CAPABILITIES } = await import('@/lib/capabilities/generations');
const { recordGeneration, reviewGeneration } = await import('@/lib/generations/store');

function cap(name: string) {
  const c = GENERATIONS_CAPABILITIES.find((x) => x.name === name);
  expect(c, `capability ${name} not registered`).toBeTruthy();
  return c!;
}

const ACCOUNT = 'acct-1';

beforeEach(() => {
  TABLES.generations = [];
  TABLES.content_items = [];
  nextId = 1;
  signUrlMock.mockClear();
});

describe('listGenerations capability', () => {
  it('resolves a display URL for each row without persisting it', async () => {
    await recordGeneration(ACCOUNT, { kind: 'image', sourceTool: 'test', storagePath: 'p1', bytes: 10 });
    const result: any[] = await (cap('listGenerations').run as any)(ACCOUNT, {});
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://storage.example/p1?sig=fresh');
  });

  it('digest reports counts by review state, not a row dump', () => {
    const digest = cap('listGenerations').digest!;
    const rows = [
      { review_state: 'PENDING', kind: 'image' },
      { review_state: 'APPROVED', kind: 'video' },
    ];
    const line = digest({}, rows);
    expect(line).toMatch(/2 generations/);
    expect(line).toMatch(/PENDING/);
    expect(line).toMatch(/APPROVED/);
  });
});

describe('reviewGeneration capability', () => {
  it('approves and clears expires_at', async () => {
    const row = await recordGeneration(ACCOUNT, { kind: 'image', sourceTool: 'test', storagePath: 'p1', bytes: 10 });
    const result: any = await (cap('reviewGeneration').run as any)(ACCOUNT, { generationId: row.id, decision: 'APPROVED' });
    expect(result.review_state).toBe('APPROVED');
    expect(result.expires_at).toBeNull();
  });
});

describe('promoteGenerationToContent capability', () => {
  it('rejects a PENDING generation — must be approved first', async () => {
    const row = await recordGeneration(ACCOUNT, { kind: 'image', sourceTool: 'test', storagePath: 'p1', bytes: 10 });
    await expect(
      (cap('promoteGenerationToContent').run as any)(ACCOUNT, { generationId: row.id, title: 'A post' }),
    ).rejects.toThrow(/APPROVED/);
  });

  it('creates a content item and links content_item_id back on the generation', async () => {
    const row = await recordGeneration(ACCOUNT, { kind: 'image', sourceTool: 'test', storagePath: 'p1', bytes: 10 });
    await reviewGeneration(ACCOUNT, row.id, 'APPROVED');

    const result: any = await (cap('promoteGenerationToContent').run as any)(ACCOUNT, {
      generationId: row.id, title: 'A post', platforms: ['instagram'],
    });

    expect(result.contentItemId).toBeTruthy();
    expect(result.mediaUrl).toBe('https://storage.example/p1?sig=fresh');
    // content_items actually got the row — never written by this module
    // directly, but through createContentItem (lib/content/store.ts).
    const item = TABLES.content_items.find((r) => r.id === result.contentItemId);
    expect(item).toBeTruthy();
    expect(item.media_url).toBe('https://storage.example/p1?sig=fresh');
    expect(item.title).toBe('A post');
    // The generation itself is linked back.
    expect(result.generation.content_item_id).toBe(result.contentItemId);
    const genRow = TABLES.generations.find((r) => r.id === row.id);
    expect(genRow.content_item_id).toBe(result.contentItemId);
  });

  it('attaches to an EXISTING content item when contentItemId is given, via updateContentItem', async () => {
    const row = await recordGeneration(ACCOUNT, { kind: 'image', sourceTool: 'test', storagePath: 'p1', bytes: 10 });
    await reviewGeneration(ACCOUNT, row.id, 'APPROVED');
    TABLES.content_items.push({ id: 'ci-existing', account_id: ACCOUNT, title: 'Existing', status: 'DRAFT' });

    const result: any = await (cap('promoteGenerationToContent').run as any)(ACCOUNT, {
      generationId: row.id, contentItemId: 'ci-existing',
    });

    expect(result.contentItemId).toBe('ci-existing');
    const item = TABLES.content_items.find((r) => r.id === 'ci-existing');
    expect(item.media_url).toBe('https://storage.example/p1?sig=fresh');
    expect(item.title).toBe('Existing'); // untouched — only media_url was set
  });
});
