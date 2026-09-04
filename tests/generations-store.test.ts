// tests/generations-store.test.ts — the generations ledger: quota,
// review/expiry, the two-lifetime purge (row vs stored object), URL
// resolution, and promotion to the content board.
//
// A minimal in-memory fake of the one supabase surface lib/generations/
// store.ts actually issues (.from('generations') with eq/neq/lt/is/not/in/
// order/limit/select/insert/update/delete) stands in for @/lib/db, so these
// tests exercise the real query logic (which rows a filter set matches)
// rather than mocking away store.ts's own decisions.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Fake supabase — in-memory `generations` table.
// ---------------------------------------------------------------------------
let TABLE: any[] = [];
let nextId = 1;

function applyFilters(rows: any[], filters: ((r: any) => boolean)[]) {
  return rows.filter((r) => filters.every((f) => f(r)));
}

function makeQuery() {
  const filters: ((r: any) => boolean)[] = [];
  let mode: 'select' | 'insert' | 'update' | 'delete' | null = null;
  let payload: any = null;
  let singleMode: 'single' | 'maybeSingle' | null = null;
  let limitN: number | null = null;
  let countExact = false;

  const api: any = {
    insert(rows: any[]) { mode = 'insert'; payload = rows; return api; },
    update(patch: any) { mode = 'update'; payload = patch; return api; },
    delete(opts?: any) { mode = 'delete'; countExact = opts?.count === 'exact'; return api; },
    select(_cols?: string) { if (!mode) mode = 'select'; return api; },
    eq(field: string, value: any) { filters.push((r) => r[field] === value); return api; },
    neq(field: string, value: any) { filters.push((r) => r[field] !== value); return api; },
    lt(field: string, value: any) { filters.push((r) => r[field] != null && r[field] < value); return api; },
    gte(field: string, value: any) { filters.push((r) => r[field] != null && r[field] >= value); return api; },
    is(field: string, value: any) { filters.push((r) => (value === null ? r[field] == null : r[field] === value)); return api; },
    not(field: string, op: string, value: any) {
      if (op === 'is' && value === null) filters.push((r) => r[field] != null);
      else if (op === 'eq') filters.push((r) => r[field] !== value);
      return api;
    },
    in(field: string, values: any[]) { filters.push((r) => values.includes(r[field])); return api; },
    order() { return api; },
    limit(n: number) { limitN = n; return api; },
    single() { singleMode = 'single'; return exec(); },
    maybeSingle() { singleMode = 'maybeSingle'; return exec(); },
    then(resolve: any, reject: any) { return exec().then(resolve, reject); },
    catch(reject: any) { return exec().catch(reject); },
  };

  async function exec(): Promise<{ data: any; error: any; count?: number }> {
    if (mode === 'insert') {
      const inserted = (payload as any[]).map((r) => ({
        id: `gen-${nextId++}`,
        created_at: new Date().toISOString(),
        brand_id: null, prompt: null, model: null, storage_path: null,
        external_url: null, mime_type: null, review_note: null, reviewed_at: null,
        content_item_id: null, expires_at: null, published_at: null,
        purged_at: null, channel_url: null,
        ...r,
      }));
      TABLE.push(...inserted);
      return singleMode ? { data: inserted[0], error: null } : { data: inserted, error: null };
    }
    if (mode === 'select') {
      let result = applyFilters(TABLE, filters);
      if (limitN != null) result = result.slice(0, limitN);
      if (singleMode === 'single') return { data: result[0] ?? null, error: result[0] ? null : { message: 'not found' } };
      if (singleMode === 'maybeSingle') return { data: result[0] ?? null, error: null };
      return { data: result, error: null };
    }
    if (mode === 'update') {
      const matched = applyFilters(TABLE, filters);
      matched.forEach((r) => Object.assign(r, payload));
      if (singleMode) return { data: matched[0] ?? null, error: matched[0] ? null : { message: 'not found' } };
      return { data: matched, error: null };
    }
    if (mode === 'delete') {
      const matched = applyFilters(TABLE, filters);
      const ids = new Set(matched.map((r) => r.id));
      TABLE = TABLE.filter((r) => !ids.has(r.id));
      return { data: null, error: null, count: countExact ? matched.length : undefined };
    }
    return { data: null, error: null };
  }
  return api;
}

vi.mock('@/lib/db', () => ({
  supabase: { from: (_table: string) => makeQuery() },
  dbReady: () => true,
}));

const signUrlMock = vi.fn(async (_bucket: string, path: string, _ttl: number) => `https://storage.example/${path}?sig=fresh`);
const uploadGeneratedMock = vi.fn(async (accountId: string, _bytes: Buffer, mimeType: string) => ({
  storagePath: `${accountId}/generated-abc.${mimeType.includes('png') ? 'png' : 'bin'}`,
  url: `https://storage.example/${accountId}/generated-abc.png?sig=xyz`,
}));
const removeObjectsMock = vi.fn(async (_bucket: string, paths: string[]) => paths.length);

vi.mock('@/lib/storage', () => ({
  GENERATED_BUCKET: 'generated-media',
  GENERATED_URL_TTL: 60 * 60 * 24,
  signUrl: (bucket: string, path: string, ttl: number) => signUrlMock(bucket, path, ttl),
  uploadGenerated: (accountId: string, bytes: Buffer, mimeType: string) => uploadGeneratedMock(accountId, bytes, mimeType),
  removeObjects: (bucket: string, paths: string[]) => removeObjectsMock(bucket, paths),
}));

const {
  recordGeneration, recordMediaGeneration, recordExternalVideoGeneration,
  listGenerations, getGeneration, reviewGeneration, markGenerationPublished,
  linkGenerationToContentItem, resolveGenerationUrl, accountStorageBytes,
  assertGenerationQuota, purgeExpiredGenerations,
  GENERATION_QUOTA_BYTES, GENERATION_RETENTION_DAYS, GENERATION_PUBLISH_GRACE_DAYS,
} = await import('@/lib/generations/store');

const ACCOUNT = 'acct-1';

beforeEach(() => {
  TABLE = [];
  nextId = 1;
  signUrlMock.mockClear();
  uploadGeneratedMock.mockClear();
  removeObjectsMock.mockClear();
});

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------
describe('assertGenerationQuota', () => {
  it('allows a generation that lands exactly at the limit', async () => {
    await recordGeneration(ACCOUNT, {
      kind: 'image', sourceTool: 'test', storagePath: 'p1', bytes: GENERATION_QUOTA_BYTES - 100,
    });
    // Approve so bytes is real storage use (purged_at null, storage_path set) —
    // matches accountStorageBytes' actual filter.
    await expect(assertGenerationQuota(ACCOUNT, 100)).resolves.toBeUndefined();
  });

  it('rejects a generation that would land ONE BYTE over the limit — boundary', async () => {
    await recordGeneration(ACCOUNT, {
      kind: 'image', sourceTool: 'test', storagePath: 'p1', bytes: GENERATION_QUOTA_BYTES - 100,
    });
    await expect(assertGenerationQuota(ACCOUNT, 101)).rejects.toThrow(/quota exceeded/i);
  });

  it('the error names the limit and current usage', async () => {
    await recordGeneration(ACCOUNT, { kind: 'image', sourceTool: 'test', storagePath: 'p1', bytes: GENERATION_QUOTA_BYTES });
    await expect(assertGenerationQuota(ACCOUNT, 1)).rejects.toThrow(/2048 MB|MB limit/);
  });

  it('a Higgsfield-hosted video (bytes=0, no storage_path) never counts toward quota', async () => {
    await recordExternalVideoGeneration(ACCOUNT, {
      sourceTool: 'generateBrandVideo', externalUrl: 'https://higgsfield.example/vid.mp4',
    });
    expect(await accountStorageBytes(ACCOUNT)).toBe(0);
  });

  it('recordMediaGeneration throws (and records nothing) when over quota', async () => {
    await recordGeneration(ACCOUNT, { kind: 'image', sourceTool: 'test', storagePath: 'p1', bytes: GENERATION_QUOTA_BYTES });
    const before = TABLE.length;
    await expect(
      recordMediaGeneration(ACCOUNT, { kind: 'image', sourceTool: 'x', bytes: Buffer.alloc(10), mimeType: 'image/png' }),
    ).rejects.toThrow(/quota/i);
    expect(TABLE.length).toBe(before); // no row written — upload never happened either
    expect(uploadGeneratedMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Review: approval clears expires_at, rejection keeps it
// ---------------------------------------------------------------------------
describe('reviewGeneration', () => {
  it('APPROVED clears expires_at', async () => {
    const row = await recordGeneration(ACCOUNT, { kind: 'image', sourceTool: 'test', storagePath: 'p1', bytes: 10 });
    expect(row.expires_at).not.toBeNull();
    const reviewed = await reviewGeneration(ACCOUNT, row.id, 'APPROVED');
    expect(reviewed.expires_at).toBeNull();
    expect(reviewed.review_state).toBe('APPROVED');
  });

  it('REJECTED keeps its original expires_at', async () => {
    const row = await recordGeneration(ACCOUNT, { kind: 'image', sourceTool: 'test', storagePath: 'p1', bytes: 10 });
    const originalExpiry = row.expires_at;
    const reviewed = await reviewGeneration(ACCOUNT, row.id, 'REJECTED', 'not on brand');
    expect(reviewed.expires_at).toBe(originalExpiry);
    expect(reviewed.review_state).toBe('REJECTED');
    expect(reviewed.review_note).toBe('not on brand');
  });
});

// ---------------------------------------------------------------------------
// resolveGenerationUrl — signs at read time
// ---------------------------------------------------------------------------
describe('resolveGenerationUrl', () => {
  it('signs a fresh URL from storage_path when present', async () => {
    const url = await resolveGenerationUrl({ storage_path: `${ACCOUNT}/x.png`, external_url: null });
    expect(signUrlMock).toHaveBeenCalledWith('generated-media', `${ACCOUNT}/x.png`, 60 * 60 * 24);
    expect(url).toBe(`https://storage.example/${ACCOUNT}/x.png?sig=fresh`);
  });

  it('falls back to external_url when storage_path is absent (Higgsfield video)', async () => {
    const url = await resolveGenerationUrl({ storage_path: null, external_url: 'https://higgsfield.example/v.mp4' });
    expect(signUrlMock).not.toHaveBeenCalled();
    expect(url).toBe('https://higgsfield.example/v.mp4');
  });

  it('never returns a persisted signed URL — signs fresh on every call', async () => {
    const row = { storage_path: `${ACCOUNT}/x.png`, external_url: null };
    await resolveGenerationUrl(row);
    await resolveGenerationUrl(row);
    expect(signUrlMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// accountStorageBytes — only counts objects that still physically exist
// ---------------------------------------------------------------------------
describe('accountStorageBytes', () => {
  it('ignores a purged row (published, bytes dropped)', async () => {
    const row = await recordGeneration(ACCOUNT, { kind: 'image', sourceTool: 'test', storagePath: 'p1', bytes: 500 });
    await reviewGeneration(ACCOUNT, row.id, 'APPROVED');
    await markGenerationPublished(ACCOUNT, row.id, 'https://x.com/i/web/status/123');
    expect(await accountStorageBytes(ACCOUNT)).toBe(500); // not yet purged
    // Simulate the purge dropping the object directly (as purgeExpiredGenerations does).
    const found = TABLE.find((r) => r.id === row.id)!;
    found.storage_path = null;
    found.purged_at = new Date().toISOString();
    expect(await accountStorageBytes(ACCOUNT)).toBe(0);
  });

  // The query filters on BOTH storage_path IS NOT NULL and purged_at IS NULL.
  // Under every write path in this module the two always change together
  // (purgeExpiredGenerations' Job B nulls storage_path and sets purged_at in
  // the same update), so the test above alone cannot tell the two filters
  // apart — removing the purged_at clause did not fail it (checked via
  // revert-check). This test isolates purged_at on its own, against a
  // storage_path that is (inconsistently, deliberately, for this test) still
  // set: it exists specifically so the purged_at filter is not a redundant,
  // never-independently-exercised clause — a hand-corrupted row, or a future
  // write path that clears purged_at without clearing storage_path, must
  // still be excluded from quota.
  it('a row with purged_at set is excluded even if storage_path is (inconsistently) still present', async () => {
    const row = await recordGeneration(ACCOUNT, { kind: 'image', sourceTool: 'test', storagePath: 'p1', bytes: 500 });
    const found = TABLE.find((r) => r.id === row.id)!;
    found.purged_at = new Date().toISOString(); // storage_path deliberately left set
    expect(found.storage_path).toBe('p1');
    expect(await accountStorageBytes(ACCOUNT)).toBe(0);
  });

  it('counts an approved-but-not-yet-published row', async () => {
    const row = await recordGeneration(ACCOUNT, { kind: 'image', sourceTool: 'test', storagePath: 'p1', bytes: 300 });
    await reviewGeneration(ACCOUNT, row.id, 'APPROVED');
    expect(await accountStorageBytes(ACCOUNT)).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// markGenerationPublished
// ---------------------------------------------------------------------------
describe('markGenerationPublished', () => {
  it('requires a channel URL', async () => {
    const row = await recordGeneration(ACCOUNT, { kind: 'image', sourceTool: 'test', storagePath: 'p1', bytes: 10 });
    await expect(markGenerationPublished(ACCOUNT, row.id, '')).rejects.toThrow(/channel URL/);
  });

  it('sets published_at and channel_url together', async () => {
    const row = await recordGeneration(ACCOUNT, { kind: 'image', sourceTool: 'test', storagePath: 'p1', bytes: 10 });
    const published = await markGenerationPublished(ACCOUNT, row.id, 'https://www.linkedin.com/feed/update/urn:li:share:1');
    expect(published.published_at).not.toBeNull();
    expect(published.channel_url).toBe('https://www.linkedin.com/feed/update/urn:li:share:1');
  });
});

// ---------------------------------------------------------------------------
// purgeExpiredGenerations — the two jobs
// ---------------------------------------------------------------------------
describe('purgeExpiredGenerations', () => {
  it('deletes storage object AND row for an expired PENDING generation', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const row = await recordGeneration(ACCOUNT, { kind: 'image', sourceTool: 'test', storagePath: 'expired/1.png', bytes: 10 });
    TABLE.find((r) => r.id === row.id)!.expires_at = past;

    const result = await purgeExpiredGenerations(Date.now() + 5000);
    expect(result.deletedRows).toBe(1);
    expect(result.deletedObjects).toBe(1);
    expect(removeObjectsMock).toHaveBeenCalledWith('generated-media', ['expired/1.png']);
    expect(TABLE.find((r) => r.id === row.id)).toBeUndefined();
  });

  it('deletes storage object AND row for an expired REJECTED generation', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const row = await recordGeneration(ACCOUNT, { kind: 'image', sourceTool: 'test', storagePath: 'rejected/1.png', bytes: 10 });
    await reviewGeneration(ACCOUNT, row.id, 'REJECTED');
    TABLE.find((r) => r.id === row.id)!.expires_at = past;

    const result = await purgeExpiredGenerations(Date.now() + 5000);
    expect(result.deletedRows).toBe(1);
    expect(TABLE.length).toBe(0);
  });

  it('a PUBLISHED row is never deleted by the purge, even if somehow past a stray expires_at', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const row = await recordGeneration(ACCOUNT, { kind: 'image', sourceTool: 'test', storagePath: 'pub/1.png', bytes: 10 });
    await reviewGeneration(ACCOUNT, row.id, 'APPROVED');
    await markGenerationPublished(ACCOUNT, row.id, 'https://x.com/i/web/status/1');
    // Defensive: even if expires_at were somehow set on an APPROVED row (it
    // never should be — reviewGeneration clears it), Job A's explicit
    // review_state exclusion must still keep it safe.
    TABLE.find((r) => r.id === row.id)!.expires_at = past;

    await purgeExpiredGenerations(Date.now() + 5000);
    expect(TABLE.find((r) => r.id === row.id)).toBeDefined();
  });

  it('drops ONLY the object for a published generation past its grace period — row survives', async () => {
    const row = await recordGeneration(ACCOUNT, { kind: 'image', sourceTool: 'test', storagePath: 'pub/2.png', bytes: 777 });
    await reviewGeneration(ACCOUNT, row.id, 'APPROVED');
    await markGenerationPublished(ACCOUNT, row.id, 'https://x.com/i/web/status/2');
    const pastGrace = new Date(Date.now() - (GENERATION_PUBLISH_GRACE_DAYS + 1) * 864e5).toISOString();
    TABLE.find((r) => r.id === row.id)!.published_at = pastGrace;

    const result = await purgeExpiredGenerations(Date.now() + 5000);
    expect(result.publishedPurged).toBe(1);
    const survivor = TABLE.find((r) => r.id === row.id);
    expect(survivor).toBeDefined();
    expect(survivor!.storage_path).toBeNull();
    expect(survivor!.purged_at).not.toBeNull();
    expect(survivor!.channel_url).toBe('https://x.com/i/web/status/2');
    expect(survivor!.prompt === null || typeof survivor!.prompt === 'string' || survivor!.prompt === undefined).toBe(true);
  });

  it('does NOT purge a published generation still inside its grace period', async () => {
    const row = await recordGeneration(ACCOUNT, { kind: 'image', sourceTool: 'test', storagePath: 'pub/3.png', bytes: 10 });
    await reviewGeneration(ACCOUNT, row.id, 'APPROVED');
    await markGenerationPublished(ACCOUNT, row.id, 'https://x.com/i/web/status/3'); // published_at = now

    const result = await purgeExpiredGenerations(Date.now() + 5000);
    expect(result.publishedPurged).toBe(0);
    expect(TABLE.find((r) => r.id === row.id)!.storage_path).toBe('pub/3.png');
  });

  it('does not purge an approved, not-yet-published generation (no expiry, no grace clock running)', async () => {
    const row = await recordGeneration(ACCOUNT, { kind: 'image', sourceTool: 'test', storagePath: 'held/1.png', bytes: 10 });
    await reviewGeneration(ACCOUNT, row.id, 'APPROVED');
    const result = await purgeExpiredGenerations(Date.now() + 5000);
    expect(result.deletedRows).toBe(0);
    expect(result.publishedPurged).toBe(0);
    expect(TABLE.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Promotion linking (store half — capability is covered separately)
// ---------------------------------------------------------------------------
describe('linkGenerationToContentItem', () => {
  it('sets content_item_id', async () => {
    const row = await recordGeneration(ACCOUNT, { kind: 'image', sourceTool: 'test', storagePath: 'p1', bytes: 10 });
    const linked = await linkGenerationToContentItem(ACCOUNT, row.id, 'ci-1');
    expect(linked.content_item_id).toBe('ci-1');
  });
});
