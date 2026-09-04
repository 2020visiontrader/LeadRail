// tests/publish-marks-generation.test.ts — publishSocialPost's seam into the
// generations ledger (owner correction: "once approved and published, we no
// longer have to hold them ... publishing is the point at which we stop
// storing the bytes").
//
// Covers: (1) a real, platform-returned/constructible permalink (X, LinkedIn)
// marks the linked generation published; (2) a platform whose publish
// response carries no derivable permalink (Facebook — see constructChannelUrl
// in lib/capabilities/social.ts) leaves the generation NOT published, rather
// than guessing a URL; (3) a failure marking the generation never fails the
// publish itself.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  getConnections: vi.fn(async () => [
    { external_id: 'ext-x', provider: 'x', status: 'connected' },
    { external_id: 'ext-li', provider: 'linkedin', status: 'connected' },
    { external_id: 'ext-fb', provider: 'facebook', status: 'connected' },
  ]),
  getConnection: vi.fn(async (_accountId: string, provider: string) => ({
    id: `row-${provider}`, external_id: `ext-${provider === 'linkedin' ? 'li' : provider === 'facebook' ? 'fb' : provider}`,
    provider, meta: { member_id: 'member-1' },
  })),
  getVentures: vi.fn(async () => []),
  getVenture: vi.fn(async () => null),
}));
vi.mock('@/lib/social/connection-token', () => ({ resolveTokensForRow: vi.fn(async () => ({ accessToken: 'tok' })) }));
vi.mock('@/lib/integrations/meta', () => ({
  publishToInstagramForAccount: vi.fn(async () => ({ id: 'fb-post-1' })),
  publishToFacebookPage: vi.fn(async () => ({ id: 'page_123456' })),
  getInstagramInsights: vi.fn(), getMetaCreds: vi.fn(async () => ({ token: 'meta-tok' })),
}));
vi.mock('@/lib/social/meta-engagement', () => ({
  listConversations: vi.fn(), getComments: vi.fn(), replyToComment: vi.fn(), hideComment: vi.fn(),
  deleteComment: vi.fn(), sendMetaMessage: vi.fn(),
}));
vi.mock('@/lib/social/meta-ads', () => ({ getInsightsByLevel: vi.fn(), updateStatus: vi.fn() }));
vi.mock('@/lib/social/meta-read', () => ({ listOwnPosts: vi.fn(), getOwnProfile: vi.fn() }));
vi.mock('@/lib/social/index', () => ({ getIntegrations: vi.fn() }));
vi.mock('@/lib/social/buffer', () => ({ createPost: vi.fn(), listPosts: vi.fn() }));
vi.mock('@/lib/social/credentials', () => ({ requireSocialCredential: vi.fn() }));
vi.mock('@/lib/ai/generation', () => ({ generateContentPost: vi.fn() }));
vi.mock('@/lib/social/linkedin-oauth', () => ({ publishLinkedinPost: vi.fn(async () => ({ id: 'urn:li:share:999' })) }));
vi.mock('@/lib/social/tiktok-oauth', () => ({ publishTiktokDraft: vi.fn() }));
const xPublish = vi.fn(async (..._a: any[]) => ({ data: { id: '9876543210' } }));
vi.mock('@/lib/social/x-oauth', () => ({ publishXPost: (...a: any[]) => xPublish(...a), listXReplies: vi.fn() }));
vi.mock('@/lib/social/threads', () => ({
  publishThreadsPost: vi.fn(), listThreadsReplies: vi.fn(), replyToThreadsPost: vi.fn(), hideThreadsReply: vi.fn(),
}));

const markGenerationPublishedMock = vi.fn(async (..._a: any[]) => ({}));
const listGenerationsMock = vi.fn(async (..._a: any[]) => [{ id: 'gen-1', published_at: null as string | null }]);
vi.mock('@/lib/generations/store', () => ({
  markGenerationPublished: (...a: any[]) => markGenerationPublishedMock(...a),
  listGenerations: (...a: any[]) => listGenerationsMock(...a),
}));

const { SOCIAL_CAPABILITIES } = await import('@/lib/capabilities/social');
function cap(name: string) {
  return SOCIAL_CAPABILITIES.find((c) => c.name === name)!;
}
const ACCOUNT = 'acct-1';

beforeEach(() => {
  markGenerationPublishedMock.mockClear();
  listGenerationsMock.mockClear();
  listGenerationsMock.mockResolvedValue([{ id: 'gen-1', published_at: null }]);
});

describe('publishSocialPost marks a linked generation published — X (constructible permalink)', () => {
  it('marks the generation with a constructed x.com permalink', async () => {
    const result = await (cap('publishSocialPost').run as any)(ACCOUNT, {
      platform: 'x', message: 'hello world', contentItemId: 'ci-1',
    });
    expect(result.data.id).toBe('9876543210');
    expect(listGenerationsMock).toHaveBeenCalledWith(ACCOUNT, { contentItemId: 'ci-1', reviewState: 'APPROVED' });
    expect(markGenerationPublishedMock).toHaveBeenCalledWith(ACCOUNT, 'gen-1', 'https://x.com/i/web/status/9876543210');
  });

  it('does nothing to the ledger when no contentItemId is given', async () => {
    await (cap('publishSocialPost').run as any)(ACCOUNT, { platform: 'x', message: 'hi' });
    expect(listGenerationsMock).not.toHaveBeenCalled();
    expect(markGenerationPublishedMock).not.toHaveBeenCalled();
  });

  it('a linked generation already published is not re-marked', async () => {
    listGenerationsMock.mockResolvedValue([{ id: 'gen-1', published_at: '2026-01-01T00:00:00Z' }]);
    await (cap('publishSocialPost').run as any)(ACCOUNT, { platform: 'x', message: 'hi', contentItemId: 'ci-1' });
    expect(markGenerationPublishedMock).not.toHaveBeenCalled();
  });

  it('a failure marking the generation does not fail the publish itself', async () => {
    markGenerationPublishedMock.mockRejectedValueOnce(new Error('db down'));
    const result = await (cap('publishSocialPost').run as any)(ACCOUNT, {
      platform: 'x', message: 'hi', contentItemId: 'ci-1',
    });
    expect(result.data.id).toBe('9876543210'); // publish still succeeded
  });
});

describe('publishSocialPost marks a linked generation published — LinkedIn (constructible permalink)', () => {
  it('marks the generation with a constructed linkedin.com permalink', async () => {
    await (cap('publishSocialPost').run as any)(ACCOUNT, {
      platform: 'linkedin', message: 'hello', contentItemId: 'ci-1',
    });
    expect(markGenerationPublishedMock).toHaveBeenCalledWith(
      ACCOUNT, 'gen-1', 'https://www.linkedin.com/feed/update/urn:li:share:999',
    );
  });
});

describe('publishSocialPost does NOT mark a generation published on Facebook — no derivable permalink', () => {
  it('leaves the ledger untouched even with a contentItemId, because the publish response carries no permalink', async () => {
    await (cap('publishSocialPost').run as any)(ACCOUNT, {
      platform: 'facebook', message: 'hello', contentItemId: 'ci-1',
    });
    // listGenerations may or may not be called depending on implementation
    // detail, but marking must never happen without a real permalink.
    expect(markGenerationPublishedMock).not.toHaveBeenCalled();
  });
});
