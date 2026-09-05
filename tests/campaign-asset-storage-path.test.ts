// tests/campaign-asset-storage-path.test.ts — campaign_assets never persists
// a signed URL.
//
// THE DEFECT THIS GUARDS AGAINST. generateImage (lib/capabilities/
// workspace.ts, and the same-shaped app/api/generate/image/route.ts handler)
// produced a URL from uploadGenerated() and passed it straight to
// insertCampaignAsset, which stored it verbatim in campaign_assets.url. Once
// generated images moved onto lib/storage.ts's signed-URL bucket, that URL
// expires after GENERATED_URL_TTL (24h) — so every image attached to a
// campaign worked for a day and then silently 404d. This is the exact defect
// 086 already closed for character_refs.image_url. Migration 087 added
// campaign_assets.storage_path (nullable — importAsset/POST .../assets can
// attach a genuinely external URL with no storage path) as the stable
// identifier instead; a fresh URL is minted from it only at READ time via
// resolveCampaignAssetUrl, never persisted.
//
// This file covers: (1) generateImage (lib/capabilities/workspace.ts)
// persists a storage PATH alongside the display url; (2)
// resolveCampaignAssetUrl re-signs from storage_path when present; (3) it
// falls back to url when storage_path is absent (the external-URL case, and
// the case where signing fails).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const signUrlMock = vi.fn(async (_bucket: string, path: string, _ttl: number) => `https://storage.example/${path}?sig=fresh`);
const uploadGeneratedMock = vi.fn(async (accountId: string, _bytes: Buffer, _mimeType: string) => ({
  storagePath: `${accountId}/generated-abc.png`,
  url: `https://storage.example/${accountId}/generated-abc.png?sig=xyz`,
}));

vi.mock('@/lib/storage', () => ({
  GENERATED_BUCKET: 'generated-media',
  GENERATED_URL_TTL: 60 * 60 * 24,
  signUrl: (bucket: string, path: string, ttl: number) => signUrlMock(bucket, path, ttl),
  uploadGenerated: (accountId: string, bytes: Buffer, mimeType: string) => uploadGeneratedMock(accountId, bytes, mimeType),
}));

const insertCampaignAssetMock = vi.fn(async (row: any) => ({ id: 'asset-1', ...row }));

vi.mock('@/lib/db', () => ({
  supabase: {},
  dbReady: () => true,
  insertCampaignAsset: (row: any) => insertCampaignAssetMock(row),
  getTemplates: vi.fn(), createTemplate: vi.fn(), createVenture: vi.fn(), updateVenture: vi.fn(), getVenture: vi.fn(),
}));
vi.mock('@/lib/notifications/store', () => ({ listNotifications: vi.fn(), markAllRead: vi.fn(), unreadCount: vi.fn() }));
vi.mock('@/lib/approvals/store', () => ({ listApprovals: vi.fn() }));
vi.mock('@/lib/sequences', () => ({ createSequence: vi.fn(), listSequences: vi.fn() }));
vi.mock('@/lib/skills/store', () => ({ listVisibleSkills: vi.fn(), listAccountSkillStates: vi.fn(), setAccountSkillState: vi.fn() }));
vi.mock('@/lib/ai/image-router', () => ({
  imageConfigured: () => true,
  generateImage: async (_a: any) => ({ base64: Buffer.from('fake-png').toString('base64'), mimeType: 'image/png' }),
}));
// generateImage (lib/capabilities/workspace.ts) now routes its upload through
// recordMediaGeneration (lib/generations/store.ts) rather than calling
// uploadGenerated directly — see migration 088 / the generations ledger.
// This test is about campaign_assets.storage_path specifically, so the
// generations ledger itself is mocked out rather than wiring a second fake
// supabase query surface here; tests/generations-store.test.ts covers the
// ledger's own behaviour (quota, review, purge).
vi.mock('@/lib/generations/store', () => ({
  recordMediaGeneration: async (accountId: string, input: any) => {
    const r = await uploadGeneratedMock(accountId, input.bytes, input.mimeType);
    return { ...r, generationId: 'gen-1' };
  },
}));

const { WORKSPACE_CAPABILITIES } = await import('@/lib/capabilities/workspace');
const { resolveCampaignAssetUrl } = await import('@/lib/crm');

const ACCOUNT = 'test-account-1';

beforeEach(() => {
  signUrlMock.mockClear();
  uploadGeneratedMock.mockClear();
  insertCampaignAssetMock.mockClear();
});

describe('generateImage persists a storage PATH, never a signed URL', () => {
  it('insertCampaignAsset is called with storage_path set to the raw bucket-relative path, not an http(s) URL', async () => {
    const generateImage = WORKSPACE_CAPABILITIES.find((t) => t.name === 'generateImage')!;
    await (generateImage.run as any)(ACCOUNT, { prompt: 'a red barn at sunset', campaignId: 'camp-1' });

    expect(insertCampaignAssetMock).toHaveBeenCalledTimes(1);
    const row = insertCampaignAssetMock.mock.calls[0][0];
    expect(row.storage_path).toBe(`${ACCOUNT}/generated-abc.png`);
    // The defect this guards against, stated as an assertion: what actually
    // landed in the column must NOT be a URL.
    expect(row.storage_path).not.toMatch(/^https?:\/\//);
  });
});

describe('resolveCampaignAssetUrl re-signs at read time', () => {
  it('re-signs a fresh URL from storage_path when present, ignoring url', async () => {
    const fresh = await resolveCampaignAssetUrl({
      url: 'https://storage.example/acct-1/generated-abc.png?sig=STALE',
      storage_path: `${ACCOUNT}/generated-abc.png`,
    });
    expect(signUrlMock).toHaveBeenCalledWith('generated-media', `${ACCOUNT}/generated-abc.png`, 60 * 60 * 24);
    expect(fresh).toBe(`https://storage.example/${ACCOUNT}/generated-abc.png?sig=fresh`);
    expect(fresh).not.toContain('STALE');
  });

  it('falls back to url when storage_path is absent (a genuinely external URL from importAsset)', async () => {
    const url = await resolveCampaignAssetUrl({
      url: 'https://cdn.example.com/brand-supplied-creative.jpg',
      storage_path: null,
    });
    expect(signUrlMock).not.toHaveBeenCalled();
    expect(url).toBe('https://cdn.example.com/brand-supplied-creative.jpg');
  });

  it('falls back to url when signing fails (e.g. the object was purged)', async () => {
    signUrlMock.mockResolvedValueOnce(null as any);
    const url = await resolveCampaignAssetUrl({
      url: 'https://storage.example/acct-1/generated-abc.png?sig=OLD-BUT-STILL-RETURNED-ON-FAILURE',
      storage_path: `${ACCOUNT}/generated-abc.png`,
    });
    expect(url).toBe('https://storage.example/acct-1/generated-abc.png?sig=OLD-BUT-STILL-RETURNED-ON-FAILURE');
  });
});
