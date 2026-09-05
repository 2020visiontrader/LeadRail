// tests/character-ref-storage-path.test.ts — character_refs never persists a
// signed URL.
//
// THE DEFECT THIS GUARDS AGAINST. generateBrandImage produced a URL; the
// model passed it straight to createCharacterRef, which stored it verbatim in
// character_refs.image_url; every later generateBrandImage call conditioned
// on ref.image_url. Once generated images moved onto lib/storage.ts's
// signed-URL bucket, that URL expires — so a persisted signed URL would
// silently break character consistency the moment it expired. Migration 086
// added character_refs.storage_path (nullable — a user-pasted external image
// URL has no storage path) as the stable identifier instead; a fresh URL is
// minted from it only at USE time via resolveCharacterRefUrl, never
// persisted.
//
// This file covers three things: (1) createCharacterRef persists a PATH, not
// a URL, when one is supplied; (2) resolveCharacterRefUrl re-signs from
// storage_path when present; (3) it falls back to image_url when
// storage_path is absent (the external-URL case).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const signUrlMock = vi.fn(async (_bucket: string, path: string, _ttl: number) => `https://storage.example/${path}?sig=fresh`);

vi.mock('@/lib/storage', () => ({
  GENERATED_BUCKET: 'generated-media',
  GENERATED_URL_TTL: 60 * 60 * 24,
  signUrl: (bucket: string, path: string, ttl: number) => signUrlMock(bucket, path, ttl),
}));

// Minimal chainable mock of the one query shape createCharacterRef issues:
// .from('character_refs').insert([row]).select().single()
let lastInsertedRow: any = null;
const supabaseMock = {
  from: (_table: string) => ({
    insert: (rows: any[]) => {
      lastInsertedRow = { id: 'ref-1', created_at: new Date().toISOString(), ...rows[0] };
      return {
        select: () => ({
          single: async () => ({ data: lastInsertedRow, error: null }),
        }),
      };
    },
  }),
};

vi.mock('@/lib/db', () => ({ supabase: supabaseMock, dbReady: () => true }));

const { createCharacterRef, resolveCharacterRefUrl } = await import('@/lib/content/store');

const ACCOUNT = 'test-account-1';

beforeEach(() => {
  lastInsertedRow = null;
  signUrlMock.mockClear();
});

describe('createCharacterRef persists a storage PATH, never a signed URL', () => {
  it('storage_path is stored as the raw bucket-relative path, not an http(s) URL', async () => {
    const row = await createCharacterRef(ACCOUNT, {
      name: 'Ada',
      imageUrl: 'https://storage.example/acct-1/abc-123.png?sig=xyz', // the signed URL, for display
      storagePath: `${ACCOUNT}/abc-123.png`, // the stable identifier — this is what must be persisted
      description: 'A friendly presenter with short brown hair, navy blazer.',
    });
    expect(row.storage_path).toBe(`${ACCOUNT}/abc-123.png`);
    // The defect this guards against, stated as an assertion: what actually
    // landed in the column must NOT be a URL.
    expect(row.storage_path).not.toMatch(/^https?:\/\//);
  });

  it('storage_path is null when the caller supplies none (genuinely external image_url)', async () => {
    const row = await createCharacterRef(ACCOUNT, {
      name: 'External Logo',
      imageUrl: 'https://cdn.example.com/user-uploaded-logo.png',
      description: 'The brand logo as supplied by the user.',
    });
    expect(row.storage_path).toBeNull();
    expect(row.image_url).toBe('https://cdn.example.com/user-uploaded-logo.png');
  });
});

describe('resolveCharacterRefUrl re-signs at use time', () => {
  it('re-signs a fresh URL from storage_path when present, ignoring image_url', async () => {
    const url = await resolveCharacterRefUrl({
      image_url: 'https://storage.example/acct-1/abc-123.png?sig=STALE',
      storage_path: `${ACCOUNT}/abc-123.png`,
    });
    expect(signUrlMock).toHaveBeenCalledWith('generated-media', `${ACCOUNT}/abc-123.png`, 60 * 60 * 24);
    expect(url).toBe(`https://storage.example/${ACCOUNT}/abc-123.png?sig=fresh`);
    expect(url).not.toContain('STALE');
  });

  it('falls back to image_url when storage_path is absent', async () => {
    const url = await resolveCharacterRefUrl({
      image_url: 'https://cdn.example.com/user-uploaded-logo.png',
      storage_path: null,
    });
    expect(signUrlMock).not.toHaveBeenCalled();
    expect(url).toBe('https://cdn.example.com/user-uploaded-logo.png');
  });

  it('falls back to image_url when signing fails (e.g. the object was purged)', async () => {
    signUrlMock.mockResolvedValueOnce(null as any);
    const url = await resolveCharacterRefUrl({
      image_url: 'https://storage.example/acct-1/abc-123.png?sig=OLD-BUT-STILL-RETURNED-ON-FAILURE',
      storage_path: `${ACCOUNT}/abc-123.png`,
    });
    expect(url).toBe('https://storage.example/acct-1/abc-123.png?sig=OLD-BUT-STILL-RETURNED-ON-FAILURE');
  });
});
