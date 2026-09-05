// tests/publish-marks-generation.test.ts — publishSocialPost's seam into the
// generations ledger (owner correction: "once approved and published, we no
// longer have to hold them ... publishing is the point at which we stop
// storing the bytes").
//
// Covers: (1) a real, platform-returned/constructible permalink (X, LinkedIn)
// marks the linked generation published, with zero extra API calls; (2) a
// Meta-family platform (Facebook, Instagram, Threads) whose publish response
// carries only an internal id gets a follow-up Graph read for the real
// permalink (constructChannelUrl / PERMALINK_RESOLVERS in
// lib/capabilities/social.ts), and a SUCCESSFUL read marks the generation
// published; (3) a FAILED or slow permalink read never fails the publish and
// leaves the generation unpublished/stored — the safe side; (4) TikTok never
// marks a generation published, because publishTiktokDraft never actually
// publishes; (5) content_items.external_post_id is written with the
// platform's raw id (the same shape syncPerformance matches on) for every
// platform except TikTok.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  getConnections: vi.fn(async () => [
    { external_id: 'ext-x', provider: 'x', status: 'connected' },
    { external_id: 'ext-li', provider: 'linkedin', status: 'connected' },
    { external_id: 'ext-fb', provider: 'facebook', status: 'connected' },
    { external_id: 'ext-ig', provider: 'instagram', status: 'connected' },
    { external_id: 'ext-th', provider: 'threads', status: 'connected' },
    { external_id: 'ext-tt', provider: 'tiktok', status: 'connected' },
  ]),
  getConnection: vi.fn(async (_accountId: string, provider: string) => ({
    id: `row-${provider}`,
    external_id: provider === 'linkedin' ? 'ext-li'
      : provider === 'facebook' ? 'ext-fb'
      : provider === 'instagram' ? 'ext-ig'
      : provider === 'threads' ? 'ext-th'
      : provider === 'tiktok' ? 'ext-tt'
      : 'ext-x',
    provider, meta: { member_id: 'member-1' },
  })),
  getVentures: vi.fn(async () => []),
  getVenture: vi.fn(async () => null),
}));
vi.mock('@/lib/social/connection-token', () => ({ resolveTokensForRow: vi.fn(async () => ({ accessToken: 'tok' })) }));
vi.mock('@/lib/integrations/meta', () => ({
  publishToInstagramForAccount: vi.fn(async () => ({ id: 'ig-media-1' })),
  publishToFacebookPage: vi.fn(async () => ({ id: 'page_123456' })),
  getInstagramInsights: vi.fn(), getMetaCreds: vi.fn(async () => ({ token: 'meta-tok' })),
}));
vi.mock('@/lib/social/meta-engagement', () => ({
  listConversations: vi.fn(), getComments: vi.fn(), replyToComment: vi.fn(), hideComment: vi.fn(),
  deleteComment: vi.fn(), sendMetaMessage: vi.fn(),
}));
vi.mock('@/lib/social/meta-ads', () => ({ getInsightsByLevel: vi.fn(), updateStatus: vi.fn() }));
const getFacebookPostPermalinkMock = vi.fn(async (..._a: any[]) => 'https://www.facebook.com/page_123456');
const getInstagramMediaPermalinkMock = vi.fn(async (..._a: any[]) => 'https://www.instagram.com/p/ig-media-1/');
vi.mock('@/lib/social/meta-read', () => ({
  listOwnPosts: vi.fn(), getOwnProfile: vi.fn(),
  getFacebookPostPermalink: (...a: any[]) => getFacebookPostPermalinkMock(...a),
  getInstagramMediaPermalink: (...a: any[]) => getInstagramMediaPermalinkMock(...a),
}));
vi.mock('@/lib/social/index', () => ({ getIntegrations: vi.fn() }));
vi.mock('@/lib/social/buffer', () => ({ createPost: vi.fn(), listPosts: vi.fn() }));
vi.mock('@/lib/social/credentials', () => ({ requireSocialCredential: vi.fn() }));
vi.mock('@/lib/ai/generation', () => ({ generateContentPost: vi.fn() }));
vi.mock('@/lib/social/linkedin-oauth', () => ({ publishLinkedinPost: vi.fn(async () => ({ id: 'urn:li:share:999' })) }));
vi.mock('@/lib/social/tiktok-oauth', () => ({ publishTiktokDraft: vi.fn(async () => ({ data: { publish_id: 'tt-draft-1' } })) }));
const xPublish = vi.fn(async (..._a: any[]) => ({ data: { id: '9876543210' } }));
vi.mock('@/lib/social/x-oauth', () => ({ publishXPost: (...a: any[]) => xPublish(...a), listXReplies: vi.fn() }));
const getThreadsMediaPermalinkMock = vi.fn(async (..._a: any[]) => 'https://www.threads.net/@user/post/threads-post-1');
vi.mock('@/lib/social/threads', () => ({
  publishThreadsPost: vi.fn(async () => ({ id: 'threads-post-1' })),
  listThreadsReplies: vi.fn(), replyToThreadsPost: vi.fn(), hideThreadsReply: vi.fn(),
  getThreadsMediaPermalink: (...a: any[]) => getThreadsMediaPermalinkMock(...a),
}));

const markGenerationPublishedMock = vi.fn(async (..._a: any[]) => ({}));
const listGenerationsMock = vi.fn(async (..._a: any[]) => [{ id: 'gen-1', published_at: null as string | null }]);
vi.mock('@/lib/generations/store', () => ({
  markGenerationPublished: (...a: any[]) => markGenerationPublishedMock(...a),
  listGenerations: (...a: any[]) => listGenerationsMock(...a),
}));

const updateContentItemMock = vi.fn(async (..._a: any[]) => ({}));
vi.mock('@/lib/content/store', () => ({
  updateContentItem: (...a: any[]) => updateContentItemMock(...a),
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
  updateContentItemMock.mockClear();
  getFacebookPostPermalinkMock.mockClear();
  getFacebookPostPermalinkMock.mockResolvedValue('https://www.facebook.com/page_123456');
  getInstagramMediaPermalinkMock.mockClear();
  getInstagramMediaPermalinkMock.mockResolvedValue('https://www.instagram.com/p/ig-media-1/');
  getThreadsMediaPermalinkMock.mockClear();
  getThreadsMediaPermalinkMock.mockResolvedValue('https://www.threads.net/@user/post/threads-post-1');
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
    expect(updateContentItemMock).not.toHaveBeenCalled();
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

  it('writes external_post_id with the raw platform id', async () => {
    await (cap('publishSocialPost').run as any)(ACCOUNT, {
      platform: 'x', message: 'hi', contentItemId: 'ci-1',
    });
    expect(updateContentItemMock).toHaveBeenCalledWith(ACCOUNT, 'ci-1', { external_post_id: '9876543210' });
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
    expect(updateContentItemMock).toHaveBeenCalledWith(ACCOUNT, 'ci-1', { external_post_id: 'urn:li:share:999' });
  });
});

describe('publishSocialPost — Facebook now resolves a real permalink via a follow-up Graph read', () => {
  it('reads permalink_url for the just-created post id and marks the generation published', async () => {
    await (cap('publishSocialPost').run as any)(ACCOUNT, {
      platform: 'facebook', message: 'hello', contentItemId: 'ci-1',
    });
    expect(getFacebookPostPermalinkMock).toHaveBeenCalledWith(ACCOUNT, 'page_123456', 'ext-fb');
    expect(markGenerationPublishedMock).toHaveBeenCalledWith(
      ACCOUNT, 'gen-1', 'https://www.facebook.com/page_123456',
    );
    expect(updateContentItemMock).toHaveBeenCalledWith(ACCOUNT, 'ci-1', { external_post_id: 'page_123456' });
  });

  it('a failed permalink read never fails the publish, and leaves the generation unpublished', async () => {
    getFacebookPostPermalinkMock.mockRejectedValueOnce(new Error('Meta error (500): timeout'));
    const result = await (cap('publishSocialPost').run as any)(ACCOUNT, {
      platform: 'facebook', message: 'hello', contentItemId: 'ci-1',
    });
    expect(result.id).toBe('page_123456'); // publish itself still succeeded
    expect(markGenerationPublishedMock).not.toHaveBeenCalled();
    // The raw id is known regardless of whether the permalink read worked, so
    // it is still recorded — this is what lets a LATER syncPerformance pass
    // find this post even though publish-time marking failed.
    expect(updateContentItemMock).toHaveBeenCalledWith(ACCOUNT, 'ci-1', { external_post_id: 'page_123456' });
  });
});

describe('publishSocialPost — Instagram now resolves a real permalink via a follow-up Graph read', () => {
  it('reads permalink for the just-created media id and marks the generation published', async () => {
    await (cap('publishSocialPost').run as any)(ACCOUNT, {
      platform: 'instagram', imageUrl: 'https://example.com/pic.png', contentItemId: 'ci-1',
    });
    expect(getInstagramMediaPermalinkMock).toHaveBeenCalledWith(ACCOUNT, 'ig-media-1', 'ext-ig');
    expect(markGenerationPublishedMock).toHaveBeenCalledWith(
      ACCOUNT, 'gen-1', 'https://www.instagram.com/p/ig-media-1/',
    );
  });

  it('a failed permalink read never fails the publish, and leaves the generation unpublished', async () => {
    getInstagramMediaPermalinkMock.mockRejectedValueOnce(new Error('Meta error (401): expired token'));
    const result = await (cap('publishSocialPost').run as any)(ACCOUNT, {
      platform: 'instagram', imageUrl: 'https://example.com/pic.png', contentItemId: 'ci-1',
    });
    expect(result.id).toBe('ig-media-1');
    expect(markGenerationPublishedMock).not.toHaveBeenCalled();
  });
});

describe('publishSocialPost — Threads now resolves a real permalink via a follow-up Graph read', () => {
  it('reads permalink for the just-created media id and marks the generation published', async () => {
    await (cap('publishSocialPost').run as any)(ACCOUNT, {
      platform: 'threads', message: 'hello threads', contentItemId: 'ci-1',
    });
    expect(getThreadsMediaPermalinkMock).toHaveBeenCalledWith('tok', 'threads-post-1');
    expect(markGenerationPublishedMock).toHaveBeenCalledWith(
      ACCOUNT, 'gen-1', 'https://www.threads.net/@user/post/threads-post-1',
    );
  });

  it('a failed permalink read never fails the publish, and leaves the generation unpublished', async () => {
    getThreadsMediaPermalinkMock.mockRejectedValueOnce(new Error('Threads error (500): timeout'));
    const result = await (cap('publishSocialPost').run as any)(ACCOUNT, {
      platform: 'threads', message: 'hello threads', contentItemId: 'ci-1',
    });
    expect(result.id).toBe('threads-post-1');
    expect(markGenerationPublishedMock).not.toHaveBeenCalled();
  });
});

describe('publishSocialPost — TikTok never marks a generation published', () => {
  it('never actually publishes (draft to inbox), so no permalink is ever produced and nothing is marked', async () => {
    const result = await (cap('publishSocialPost').run as any)(ACCOUNT, {
      platform: 'tiktok', videoUrl: 'https://example.com/v.mp4', message: 'hi', contentItemId: 'ci-1',
    });
    expect(result.data.publish_id).toBe('tt-draft-1');
    expect(markGenerationPublishedMock).not.toHaveBeenCalled();
    // TikTok's publish_id names a draft, not a live post — recording it as
    // external_post_id would make a later syncPerformance-style pass look for
    // a post that does not exist, so it is deliberately never written.
    expect(updateContentItemMock).not.toHaveBeenCalled();
  });
});
