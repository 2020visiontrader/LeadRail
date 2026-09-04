// tests/social-engagement-parity.test.ts — COMMENT_PLATFORMS in
// lib/capabilities/social.ts mapped only facebook/instagram, so
// listSocialComments / replyToSocialComment / hideSocialComment /
// deleteSocialComment did nothing for LinkedIn, X or Threads even though
// scopes for engagement were already granted at connect time
// (threads_manage_replies/threads_read_replies, w_member_social,
// tweet.write). This file covers the per-platform dispatch that replaces the
// single Meta-only map:
//   - Threads: list + reply + hide are real, dispatch to the right token/user id
//   - X: list + reply are real (paid-tier caveat lives in x-oauth.ts itself);
//     hide and delete are NOT built and must say so, not silently no-op
//   - LinkedIn: NOTHING is built (Community Management API partner gate) —
//     every one of the four actions must say so, not attempt a call that
//     would always 403
//   - Meta (facebook/instagram) behaviour is untouched — same function, same
//     call shape, still reachable with no platform argument at all (the
//     original hideSocialComment/deleteSocialComment fallback)
//
// lib/capabilities/social.ts itself is never mocked — only what it calls.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- lib/db --------------------------------------------------------------
const getConnections = vi.fn();
const getConnection = vi.fn();
const getVentures = vi.fn(async () => []);
const getVenture = vi.fn(async () => null);
vi.mock('@/lib/db', () => ({
  getConnections: (...a: any[]) => (getConnections as any)(...a),
  getConnection: (...a: any[]) => (getConnection as any)(...a),
  getVentures: (...a: any[]) => (getVentures as any)(...a),
  getVenture: (...a: any[]) => (getVenture as any)(...a),
}));

// ---- lib/social/connection-token -----------------------------------------
const resolveTokensForRow = vi.fn();
vi.mock('@/lib/social/connection-token', () => ({
  resolveTokensForRow: (...a: any[]) => (resolveTokensForRow as any)(...a),
}));

// ---- lib/integrations/meta -------------------------------------------------
vi.mock('@/lib/integrations/meta', () => ({
  publishToInstagramForAccount: vi.fn(),
  publishToFacebookPage: vi.fn(),
  getInstagramInsights: vi.fn(),
  getMetaCreds: vi.fn(async () => ({ token: 'meta-tok' })),
}));

// ---- lib/social/meta-engagement -------------------------------------------
const metaGetComments = vi.fn(async () => [{ id: 'meta-comment' }]);
const metaReplyToComment = vi.fn(async () => ({ id: 'meta-reply' }));
const metaHideComment = vi.fn(async () => ({ success: true }));
const metaDeleteComment = vi.fn(async () => ({ deleted: true }));
vi.mock('@/lib/social/meta-engagement', () => ({
  listConversations: vi.fn(),
  getComments: (...a: any[]) => (metaGetComments as any)(...a),
  replyToComment: (...a: any[]) => (metaReplyToComment as any)(...a),
  hideComment: (...a: any[]) => (metaHideComment as any)(...a),
  deleteComment: (...a: any[]) => (metaDeleteComment as any)(...a),
  sendMetaMessage: vi.fn(),
}));

// ---- lib/social/meta-ads / meta-read / index / buffer / credentials -------
vi.mock('@/lib/social/meta-ads', () => ({ getInsightsByLevel: vi.fn(), updateStatus: vi.fn() }));
vi.mock('@/lib/social/meta-read', () => ({ listOwnPosts: vi.fn(), getOwnProfile: vi.fn() }));
vi.mock('@/lib/social/index', () => ({ getIntegrations: vi.fn() }));
vi.mock('@/lib/social/buffer', () => ({ createPost: vi.fn(), listPosts: vi.fn() }));
vi.mock('@/lib/social/credentials', () => ({ requireSocialCredential: vi.fn() }));
vi.mock('@/lib/ai/generation', () => ({ generateContentPost: vi.fn() }));

// ---- lib/social/linkedin-oauth / tiktok-oauth ------------------------------
vi.mock('@/lib/social/linkedin-oauth', () => ({ publishLinkedinPost: vi.fn() }));
vi.mock('@/lib/social/tiktok-oauth', () => ({ publishTiktokDraft: vi.fn() }));

// ---- lib/social/x-oauth ----------------------------------------------------
const publishXPost = vi.fn(async () => ({ data: { id: 'x-tweet' } }));
const listXReplies = vi.fn(async () => [{ id: 'x-reply' }]);
vi.mock('@/lib/social/x-oauth', () => ({
  publishXPost: (...a: any[]) => (publishXPost as any)(...a),
  listXReplies: (...a: any[]) => (listXReplies as any)(...a),
}));

// ---- lib/social/threads ----------------------------------------------------
const publishThreadsPost = vi.fn(async () => ({ id: 'threads-post' }));
const listThreadsReplies = vi.fn(async () => [{ id: 'threads-reply' }]);
const replyToThreadsPost = vi.fn(async () => ({ id: 'threads-reply-created' }));
const hideThreadsReply = vi.fn(async () => ({ success: true }));
vi.mock('@/lib/social/threads', () => ({
  publishThreadsPost: (...a: any[]) => (publishThreadsPost as any)(...a),
  listThreadsReplies: (...a: any[]) => (listThreadsReplies as any)(...a),
  replyToThreadsPost: (...a: any[]) => (replyToThreadsPost as any)(...a),
  hideThreadsReply: (...a: any[]) => (hideThreadsReply as any)(...a),
}));

import { SOCIAL_CAPABILITIES } from '@/lib/capabilities/social';

function cap(name: string) {
  const c = SOCIAL_CAPABILITIES.find((x) => x.name === name);
  expect(c, `capability ${name} not registered`).toBeTruthy();
  return c!;
}

const ACCOUNT = 'acct-1';

const THREADS_CONN = { id: 'row-th', external_id: 'threads-user-9', provider: 'threads' };
const X_CONN = { id: 'row-x', external_id: 'x-user-9', provider: 'x' };

beforeEach(() => {
  vi.clearAllMocks();
  getConnection.mockImplementation(async (_accountId: string, provider: string) => {
    if (provider === 'threads') return THREADS_CONN;
    if (provider === 'x') return X_CONN;
    return null;
  });
  // publishSocialPost resolves the target account via resolveExternalId,
  // which reads getConnections (plural) rather than getConnection.
  getConnections.mockResolvedValue([
    { ...THREADS_CONN, status: 'connected' },
    { ...X_CONN, status: 'connected' },
  ]);
  resolveTokensForRow.mockResolvedValue({ accessToken: 'tok-live' });
});

describe('listSocialComments dispatch', () => {
  it('Threads: reads replies using the connected user\'s token', async () => {
    const result = await cap('listSocialComments').run(ACCOUNT, { platform: 'threads', postId: 'POST_1', limit: 5 });
    expect(listThreadsReplies).toHaveBeenCalledWith('tok-live', 'POST_1', 5);
    expect(result).toEqual([{ id: 'threads-reply' }]);
  });

  it('X: reads replies via listXReplies with the connected token', async () => {
    const result = await cap('listSocialComments').run(ACCOUNT, { platform: 'x', postId: 'TWEET_1' });
    expect(listXReplies).toHaveBeenCalledWith('tok-live', 'TWEET_1', 25);
    expect(result).toEqual([{ id: 'x-reply' }]);
  });

  it('LinkedIn: throws a readable "not available" message rather than attempting a call', () => {
    expect(() => cap('listSocialComments').run(ACCOUNT, { platform: 'linkedin', postId: 'P1' }))
      .toThrow(/aren't available for linkedin/);
  });

  it('Meta (facebook) is unchanged: still calls getComments', async () => {
    const result = await cap('listSocialComments').run(ACCOUNT, { platform: 'facebook', postId: 'P1' });
    expect(metaGetComments).toHaveBeenCalledWith(ACCOUNT, 'P1', 'facebook', 25, undefined);
    expect(result).toEqual([{ id: 'meta-comment' }]);
  });
});

describe('replyToSocialComment dispatch', () => {
  it('Threads: replies through the two-step publish flow with the connected user id', async () => {
    await cap('replyToSocialComment').run(ACCOUNT, { platform: 'threads', commentId: 'THREAD_9', message: 'nice' });
    expect(replyToThreadsPost).toHaveBeenCalledWith('tok-live', 'threads-user-9', 'THREAD_9', 'nice');
  });

  it('X: replies as a normal tweet with the comment id as in_reply_to_tweet_id target', async () => {
    await cap('replyToSocialComment').run(ACCOUNT, { platform: 'x', commentId: 'TWEET_9', message: 'nice' });
    expect(publishXPost).toHaveBeenCalledWith('tok-live', 'nice', 'TWEET_9');
  });

  it('LinkedIn: throws rather than posting a comment that would 403', () => {
    expect(() => cap('replyToSocialComment').run(ACCOUNT, { platform: 'linkedin', commentId: 'C1', message: 'hi' }))
      .toThrow(/aren't available for linkedin/);
  });
});

describe('hideSocialComment dispatch', () => {
  it('Threads: hides via manage_reply with the connected token', async () => {
    await cap('hideSocialComment').run(ACCOUNT, { platform: 'threads', commentId: 'REPLY_1', hide: true });
    expect(hideThreadsReply).toHaveBeenCalledWith('tok-live', 'REPLY_1', true);
  });

  it('X: has no hider — throws a platform-named message instead of a silent no-op', () => {
    expect(() => cap('hideSocialComment').run(ACCOUNT, { platform: 'x', commentId: 'T1', hide: true }))
      .toThrow(/x does not support hiding comments/);
  });

  it('LinkedIn: also throws rather than no-op', () => {
    expect(() => cap('hideSocialComment').run(ACCOUNT, { platform: 'linkedin', commentId: 'C1' }))
      .toThrow(/linkedin does not support hiding comments/);
  });

  it('no platform given: falls back to the original Meta-only path unchanged', async () => {
    await cap('hideSocialComment').run(ACCOUNT, { commentId: 'M1', hide: false });
    expect(metaHideComment).toHaveBeenCalledWith(ACCOUNT, 'M1', false, undefined, undefined);
  });
});

describe('deleteSocialComment dispatch', () => {
  it('Threads: has no deleter — the API offers no delete endpoint', () => {
    expect(() => cap('deleteSocialComment').run(ACCOUNT, { platform: 'threads', commentId: 'R1' }))
      .toThrow(/threads does not support deleting comments/);
  });

  it('X: has no deleter for moderating someone else\'s reply', () => {
    expect(() => cap('deleteSocialComment').run(ACCOUNT, { platform: 'x', commentId: 'T1' }))
      .toThrow(/x does not support deleting comments/);
  });

  it('LinkedIn: has no deleter', () => {
    expect(() => cap('deleteSocialComment').run(ACCOUNT, { platform: 'linkedin', commentId: 'C1' }))
      .toThrow(/linkedin does not support deleting comments/);
  });

  it('no platform given: falls back to the original Meta-only path unchanged', async () => {
    await cap('deleteSocialComment').run(ACCOUNT, { commentId: 'M1' });
    expect(metaDeleteComment).toHaveBeenCalledWith(ACCOUNT, 'M1', undefined, undefined);
  });

  it('Meta (instagram) named explicitly still works', async () => {
    await cap('deleteSocialComment').run(ACCOUNT, { platform: 'instagram', commentId: 'M2' });
    expect(metaDeleteComment).toHaveBeenCalledWith(ACCOUNT, 'M2', 'instagram', undefined);
  });
});

describe('publishSocialPost — threads publisher', () => {
  it('publishes through the connected Threads user id and token', async () => {
    await cap('publishSocialPost').run(ACCOUNT, { platform: 'threads', message: 'hello' });
    expect(publishThreadsPost).toHaveBeenCalledWith('tok-live', 'threads-user-9', {
      text: 'hello', imageUrl: undefined, videoUrl: undefined,
    });
  });

  it('throws a clear "not connected" error when no Threads connection exists', async () => {
    getConnection.mockResolvedValueOnce(null);
    await expect(cap('publishSocialPost').run(ACCOUNT, { platform: 'threads', message: 'hi' }))
      .rejects.toThrow(/No Threads account connected/);
  });
});
