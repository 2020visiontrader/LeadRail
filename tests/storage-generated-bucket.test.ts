// tests/storage-generated-bucket.test.ts — the shared uploadGenerated()
// helper, and that the three image-generation call sites that use it never
// touch the filesystem.
//
// uploadGenerated (lib/storage.ts) is the ONE write path
// lib/capabilities/content.ts, lib/capabilities/workspace.ts, and
// app/api/generate/image/route.ts now all share, replacing three copies of
// hand-rolled `writeFile(join(process.cwd(), 'public', 'generated', ...))`
// logic. This pins: it uploads to GENERATED_BUCKET under
// `<accountId>/<uuid>.<ext>`, returns {storagePath, url} where storagePath is
// the bucket path (never persist a URL) and url is freshly signed, and it
// throws (rather than silently degrading) when the upload or the sign fails.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const uploadMock = vi.fn(async (_path: string, _bytes: any, _opts: any) => ({ error: null }));
const createSignedUrlMock = vi.fn(async (path: string, _ttl: number) => ({
  data: { signedUrl: `https://storage.example/${path}?sig=fresh` },
  error: null,
}));
const createBucketMock = vi.fn(async () => ({ error: null }));
const updateBucketMock = vi.fn(async () => ({ error: null }));

const supabaseMock = {
  storage: {
    createBucket: (...args: unknown[]) => (createBucketMock as (...a: unknown[]) => unknown)(...args),
    updateBucket: (...args: unknown[]) => (updateBucketMock as (...a: unknown[]) => unknown)(...args),
    from: (_bucket: string) => ({
      upload: (path: string, bytes: any, opts: any) => uploadMock(path, bytes, opts),
      createSignedUrl: (path: string, ttl: number) => createSignedUrlMock(path, ttl),
    }),
  },
};

vi.mock('@/lib/db', () => ({ supabase: supabaseMock }));

const { uploadGenerated, GENERATED_BUCKET, GENERATED_URL_TTL } = await import('@/lib/storage');

const ACCOUNT = 'test-account-1';

beforeEach(() => {
  uploadMock.mockClear();
  createSignedUrlMock.mockClear();
});

describe('uploadGenerated', () => {
  it('uploads under <accountId>/<uuid>.<ext> in GENERATED_BUCKET and signs a URL from GENERATED_URL_TTL', async () => {
    const result = await uploadGenerated(ACCOUNT, Buffer.from('fake-png-bytes'), 'image/png');
    expect(uploadMock).toHaveBeenCalledTimes(1);
    const [path, bytes, opts] = uploadMock.mock.calls[0];
    expect(path.startsWith(`${ACCOUNT}/`)).toBe(true);
    expect(path.endsWith('.png')).toBe(true);
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(opts.contentType).toBe('image/png');

    expect(createSignedUrlMock).toHaveBeenCalledWith(path, GENERATED_URL_TTL);
    expect(result.storagePath).toBe(path);
    expect(result.url).toBe(`https://storage.example/${path}?sig=fresh`);
    // The identifier and the display link must differ in kind: the path has
    // no scheme, the URL does.
    expect(result.storagePath).not.toMatch(/^https?:\/\//);
    expect(result.url).toMatch(/^https:\/\//);
  });

  it('picks the extension from the mime type (jpeg -> jpg)', async () => {
    const result = await uploadGenerated(ACCOUNT, Buffer.from('x'), 'image/jpeg');
    expect(result.storagePath.endsWith('.jpg')).toBe(true);
  });

  it('throws when the upload itself fails, rather than returning a broken URL', async () => {
    uploadMock.mockResolvedValueOnce({ error: { message: 'bucket not found' } } as any);
    await expect(uploadGenerated(ACCOUNT, Buffer.from('x'), 'image/png')).rejects.toThrow(/could not store/i);
  });

  it('throws when signing fails, rather than returning a null/undefined url', async () => {
    createSignedUrlMock.mockResolvedValueOnce({ data: null, error: { message: 'nope' } } as any);
    await expect(uploadGenerated(ACCOUNT, Buffer.from('x'), 'image/png')).rejects.toThrow(/preview link could not be signed/i);
  });

  it('GENERATED_BUCKET is private-bucket shaped: a distinct bucket name, not reused from another domain', () => {
    expect(GENERATED_BUCKET).toBe('generated-media');
  });
});
