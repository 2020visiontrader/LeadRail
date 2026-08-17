// Social capabilities (Packet 2.2-S) — the assistant operating the account's
// connected social accounts: reading, drafting, publishing, engaging, ads.
//
// Two properties matter more than anything else in this file:
//
//  1. TENANT SCOPE. Every run() passes the caller's authenticated accountId
//     straight into an account-scoped service function. Nothing here reads a
//     client-supplied account id, and nothing here talks to the Graph API
//     directly — all Meta traffic goes through lib/integrations/meta.ts and
//     lib/social/*, which resolve credentials from THIS account's
//     integration_connections rows.
//
//  2. PLATFORM COVERAGE IS REGISTRY-DRIVEN. lib/social/providers.ts is the only
//     place that knows which platforms exist and which are usable. Platform
//     arguments are validated against LIVE_SOCIALS at call time, and publishing
//     / DM sending dispatch through lookup maps. When Packet 7.1 flips
//     linkedin/tiktok/x to live:true, they become valid arguments here with
//     ZERO edits to this file; adding a publisher is adding one map entry. A
//     platform that is live but has no map entry produces an honest "not
//     available yet" error, which the model relays, rather than silently
//     doing nothing.
//
// GATES: anything that reaches a real audience is 'external_send' — publishing,
// replying, hiding, DMing, scheduling, and resuming ad spend. A *scheduled*
// post is still a real send; being deferred does not make it safer, so it is
// not downgraded. Approval enforcement itself lives in the gate (Packets 0.1 /
// 0.3) — capabilities only declare their class.

import { z } from 'zod';
import { getConnections, getConnection, getVentures, getVenture } from '@/lib/db';
import {
  publishToInstagramForAccount, publishToFacebookPage, getInstagramInsights, getMetaCreds,
} from '@/lib/integrations/meta';
import {
  getComments, replyToComment, hideComment, deleteComment, sendInstagramMessage,
} from '@/lib/social/meta-engagement';
import { getInsightsByLevel, updateStatus } from '@/lib/social/meta-ads';
import { getIntegrations } from '@/lib/social/index';
import { createPost as bufferCreatePost, listPosts as bufferListPosts } from '@/lib/social/buffer';
import { generateContentPost } from '@/lib/ai/generation';
import { LIVE_SOCIALS, SOCIAL_KEYS, type SocialKey } from '@/lib/social/providers';
import { obj, S, type Capability, rowsOf, plural, samples, tally, present, digestLine } from './types';

// ---------------------------------------------------------------------------
// Registry-driven platform validation
// ---------------------------------------------------------------------------

/** Read at CALL time, never frozen into an enum — see the header note. */
const livePlatforms = (): string[] => LIVE_SOCIALS.map((p) => p.key);

const livePlatform = z.string().refine((v) => livePlatforms().includes(v), {
  message: 'That platform is not connected yet.',
});

// Drafting copy publishes nothing, so it is allowed for any platform the
// registry knows about — including ones whose OAuth has not shipped. Writing a
// LinkedIn post before LinkedIn is connectable is useful and harmless.
const knownPlatform = z.string().refine((v) => (SOCIAL_KEYS as string[]).includes(v), {
  message: 'Unknown platform.',
});

// ---------------------------------------------------------------------------
// Multi-account resolution
// ---------------------------------------------------------------------------

/**
 * Resolve WHICH connected account an action targets. An account may have six
 * Instagram accounts connected; picking "the first one" would publish to the
 * wrong audience with no way for the user to notice beforehand. So: an explicit
 * external id wins, exactly one connection is used implicitly, and anything
 * ambiguous THROWS so the model asks the user instead of guessing.
 */
async function resolveExternalId(
  accountId: string,
  platform: string,
  externalId?: string,
): Promise<string | undefined> {
  const conns = (await getConnections(accountId)).filter(
    (c: any) => c.provider === platform && c.status === 'connected',
  );
  if (externalId) {
    const hit = conns.find((c: any) => String(c.external_id) === externalId);
    if (!hit) throw new Error(`No connected ${platform} account with id ${externalId}.`);
    return String(hit.external_id);
  }
  if (conns.length === 0) throw new Error(`No ${platform} account is connected.`);
  if (conns.length > 1) throw new Error(`Multiple ${platform} accounts are connected — specify which one.`);
  return conns[0].external_id ? String(conns[0].external_id) : undefined;
}

// ---------------------------------------------------------------------------
// Dispatch maps — the ONLY place a platform string appears
// ---------------------------------------------------------------------------

type Dispatch = (accountId: string, args: any, externalId?: string) => Promise<any>;

const PUBLISHERS: Partial<Record<SocialKey, Dispatch>> = {
  facebook: (accountId, a, externalId) =>
    publishToFacebookPage(accountId, { message: a.message || '', link: a.link, imageUrl: a.imageUrl }, externalId),
  instagram: (accountId, a, externalId) =>
    publishToInstagramForAccount(accountId, { caption: a.message || '', imageUrl: a.imageUrl, videoUrl: a.videoUrl }, externalId),
  // threads / linkedin / tiktok / x land here as their publishers are written.
};

const MESSENGERS: Partial<Record<SocialKey, Dispatch>> = {
  instagram: (accountId, a, externalId) =>
    sendInstagramMessage(accountId, a.recipientId, a.text, externalId),
};

// Comment reading/replying is Meta-only today; the map keeps that fact in one
// place rather than in an if/else inside each capability.
const COMMENT_PLATFORMS: Partial<Record<SocialKey, 'facebook' | 'instagram'>> = {
  facebook: 'facebook',
  instagram: 'instagram',
};

function commentPlatform(platform: string): 'facebook' | 'instagram' {
  const p = COMMENT_PLATFORMS[platform as SocialKey];
  if (!p) throw new Error(`Comments aren't available for ${platform} yet.`);
  return p;
}

// ---------------------------------------------------------------------------
// Buffer guard
// ---------------------------------------------------------------------------

/**
 * Buffer is single-tenant today (global env credentials — see lib/social/buffer.ts).
 * Exposing it to the agent unscoped would leak one account's channels and
 * scheduled posts to another, so a capability only runs when THIS account has
 * its own connection row. Per-account credential storage is Packet 7.2; until
 * then refusing is the correct behaviour, not a limitation to work around.
 */
async function requireBuffer(accountId: string) {
  const conn = await getConnection(accountId, 'buffer');
  if (!conn) throw new Error('Buffer is not connected for this account.');
  return conn;
}

export const SOCIAL_CAPABILITIES: Capability[] = [
  // ---------------------------------------------------------------- reading
  {
    name: 'listSocialAccounts',
    domain: 'social',
    title: 'List connected social accounts',
    description: 'List the social accounts this user has connected (which pages and profiles you can post to or read from), with the id to use when an action needs to target one of them. Use before publishing or messaging so you name the right account, and whenever the user asks what is connected.',
    gate: 'read',
    inputSchema: obj({ platform: S.string }),
    zod: z.object({ platform: livePlatform.optional() }),
    run: async (accountId, a) => {
      const live = livePlatforms();
      return (await getConnections(accountId))
        .filter((c: any) => c.status === 'connected' && live.includes(c.provider))
        .filter((c: any) => (a?.platform ? c.provider === a.platform : true))
        // Never surface secret_ref / meta: they carry access tokens.
        .map((c: any) => ({
          platform: c.provider,
          id: c.external_id,
          name: c.display_name || null,
          username: c.username || null,
        }));
    },
    // Which accounts are connected drives almost every follow-up on this
    // domain, and publish/DM disambiguation needs the external ids. `tally`
    // counts only rows that actually carry `platform`; `samples` prefers a
    // username, falls back to a display name, and skips rows with neither.
    digest: (_a, result) => {
      const rows = rowsOf(result);
      if (!rows) return '';
      if (!rows.length) return 'No social accounts are connected for this account.';
      return digestLine(
        `${plural(rows.length, 'connected social account')}.`,
        tally(rows, 'platform') ? `${tally(rows, 'platform')}.` : null,
        samples(rows, ['username', 'name'], 4).length
          ? `Accounts: ${samples(rows, ['username', 'name'], 4).join(', ')}`
          : null,
      );
    },
  },
  {
    name: 'getSocialStatus',
    domain: 'social',
    title: 'Check social integration status',
    description: 'Check which social and scheduling integrations are set up for this account and what each one can currently do. Use when a social action fails or when the user asks why something is unavailable.',
    gate: 'read',
    inputSchema: obj({}),
    zod: z.object({}),
    run: (accountId) => getIntegrations(accountId),
  },
  {
    name: 'listSocialComments',
    domain: 'social',
    title: 'List comments on a post',
    description: 'Read the comments on one published post so you can summarise them or decide what to reply to. Needs the post id and which platform it is on.',
    gate: 'read',
    inputSchema: obj({ postId: S.string, platform: S.string, limit: S.number }, ['postId', 'platform']),
    zod: z.object({ postId: z.string().min(1), platform: livePlatform, limit: z.number().int().min(1).max(100).optional() }),
    run: (accountId, a) => getComments(accountId, a.postId, commentPlatform(a.platform), a.limit ?? 25),
    // Comment text is the substance of this result and is exactly what gets
    // clipped by truncation, so quote a few verbatim. `hidden` is only reported
    // when at least one row actually carries the field — Meta omits it on some
    // edges, and reporting "0 hidden" from an absent field would be a guess.
    digest: (_a, result) => {
      const rows = rowsOf(result);
      if (!rows) return '';
      if (!rows.length) return 'No comments on that post.';
      const hasHidden = rows.some((r) => present(r, 'hidden'));
      const hidden = hasHidden ? rows.filter((r) => (r as any).hidden === true).length : null;
      const quoted = samples(rows, ['message'], 3);
      return digestLine(
        `${plural(rows.length, 'comment')}.`,
        hidden !== null ? `${hidden} hidden.` : null,
        quoted.length ? `Latest: ${quoted.map((q) => `"${q}"`).join(' | ')}` : null,
      );
    },
  },
  {
    name: 'getSocialInsights',
    domain: 'social',
    title: 'Get post performance',
    description: 'Get engagement, impressions and reach for one published Instagram post or reel. Needs the media id of that post.',
    gate: 'read',
    inputSchema: obj({ mediaId: S.string, accountExternalId: S.string }, ['mediaId']),
    zod: z.object({ mediaId: z.string().min(1), accountExternalId: z.string().optional() }),
    run: async (accountId, a) => {
      // Account creds, never the process-level env token: insights must be read
      // with the connection that owns the media.
      const { token } = await getMetaCreds(accountId, { provider: 'instagram', externalId: a.accountExternalId });
      return getInstagramInsights(a.mediaId, token);
    },
  },
  {
    name: 'draftSocialPost',
    domain: 'social',
    title: 'Draft a social post',
    description: 'Write post copy (hook, body, hashtags, image idea) for a platform and topic. This only produces text for the user to review — it never publishes anything. Use it whenever the user asks for a post, caption or content idea.',
    gate: 'read',
    inputSchema: obj({ platform: S.string, topic: S.string, brandId: S.string, hook: S.string, cta: S.string }, ['platform', 'topic']),
    zod: z.object({
      platform: knownPlatform,
      topic: z.string().min(1),
      brandId: z.string().optional(),
      hook: z.string().optional(),
      cta: z.string().optional(),
    }),
    run: async (accountId, a) => {
      const v: any = a.brandId ? await getVenture(a.brandId) : (await getVentures(accountId))[0];
      return generateContentPost({
        venture: { name: v?.name || 'our brand', niche: v?.niche },
        platform: a.platform, topic: a.topic, hook: a.hook, cta: a.cta,
      });
    },
  },

  // -------------------------------------------------------------- outbound
  {
    name: 'publishSocialPost',
    domain: 'social',
    title: 'Publish a social post',
    description: 'Publish a post to one of the connected social accounts, right now, visible to that account\'s real audience. Call listSocialAccounts first and pass the id of the account to post to. Instagram posts must include an image or video. Use draftSocialPost to write the copy first.',
    gate: 'external_send',
    inputSchema: obj({
      platform: S.string, accountExternalId: S.string, message: S.string,
      imageUrl: S.string, videoUrl: S.string, link: S.string,
    }, ['platform']),
    zod: z.object({
      platform: livePlatform,
      accountExternalId: z.string().optional(),
      message: z.string().optional(),
      imageUrl: z.string().url().optional(),
      videoUrl: z.string().url().optional(),
      link: z.string().url().optional(),
    })
      .refine((a) => !!(a.message || a.imageUrl || a.videoUrl), {
        message: 'A post needs a message, an image, or a video.',
      })
      // Same rule the publish route enforces (app/api/social/meta/publish/route.ts):
      // Instagram has no text-only post type.
      .refine((a) => a.platform !== 'instagram' || !!(a.imageUrl || a.videoUrl), {
        message: 'Instagram posts require an image or a video.',
      }),
    run: async (accountId, a) => {
      const pub = PUBLISHERS[a.platform as SocialKey];
      if (!pub) throw new Error(`Publishing to ${a.platform} isn't available yet.`);
      const externalId = await resolveExternalId(accountId, a.platform, a.accountExternalId);
      return pub(accountId, a, externalId);
    },
    summarize: (a) => `Publish this post to ${a.platform}${a.accountExternalId ? ` (${a.accountExternalId})` : ''}. It goes live immediately to that account's real audience.`,
  },
  {
    name: 'replyToSocialComment',
    domain: 'social',
    title: 'Reply to a comment',
    description: 'Post a public reply to a comment on one of the account\'s posts. The reply is visible to everyone who can see the post. Give the comment id, which platform it is on, and the reply text.',
    gate: 'external_send',
    inputSchema: obj({ commentId: S.string, message: S.string, platform: S.string, accountExternalId: S.string }, ['commentId', 'message', 'platform']),
    // `platform` is required here (not in the packet's arg table) because the
    // backing reply needs it to pick which connection's credentials to use —
    // guessing would post from the wrong account.
    zod: z.object({
      commentId: z.string().min(1),
      message: z.string().min(1),
      platform: livePlatform,
      accountExternalId: z.string().optional(),
    }),
    run: (accountId, a) =>
      replyToComment(accountId, a.commentId, a.message, commentPlatform(a.platform), a.accountExternalId),
    summarize: (a) => `Post a public reply to comment ${a.commentId} on ${a.platform}: "${String(a.message).slice(0, 120)}". Everyone who sees the post sees this reply.`,
  },
  {
    name: 'hideSocialComment',
    domain: 'social',
    title: 'Hide a comment',
    description: 'Hide (or unhide) a comment on one of the account\'s posts so other people stop seeing it. Use for spam or abuse when the user asks. Pass hide:false to make it visible again.',
    // Hiding changes what a real audience sees on a live post, so it is held to
    // the same bar as a send rather than treated as an internal write.
    gate: 'external_send',
    inputSchema: obj({ commentId: S.string, hide: { type: 'boolean' } }, ['commentId']),
    zod: z.object({ commentId: z.string().min(1), hide: z.boolean().optional() }),
    run: (accountId, a) => hideComment(accountId, a.commentId, a.hide ?? true),
    summarize: (a) => (a.hide === false
      ? `Unhide comment ${a.commentId} so the public can see it again.`
      : `Hide comment ${a.commentId} from everyone else viewing the post.`),
  },
  {
    name: 'deleteSocialComment',
    domain: 'social',
    title: 'Delete a comment',
    description: 'Permanently delete a comment on one of the account\'s posts. This cannot be undone — prefer hiding unless the user specifically asks to delete.',
    gate: 'destructive',
    inputSchema: obj({ commentId: S.string }, ['commentId']),
    zod: z.object({ commentId: z.string().min(1) }),
    run: (accountId, a) => deleteComment(accountId, a.commentId),
    summarize: (a) => `Permanently delete comment ${a.commentId}. This cannot be undone.`,
  },
  {
    name: 'sendSocialMessage',
    domain: 'social',
    title: 'Send a direct message',
    description: 'Send a direct message from one of the connected accounts to a real person. Give the platform, the recipient\'s id from the conversation, and the message text.',
    gate: 'external_send',
    inputSchema: obj({ platform: S.string, recipientId: S.string, text: S.string, accountExternalId: S.string }, ['platform', 'recipientId', 'text']),
    zod: z.object({
      platform: livePlatform,
      recipientId: z.string().min(1),
      text: z.string().min(1),
      accountExternalId: z.string().optional(),
    }),
    run: async (accountId, a) => {
      const send = MESSENGERS[a.platform as SocialKey];
      if (!send) throw new Error(`Direct messages on ${a.platform} aren't available yet.`);
      const externalId = await resolveExternalId(accountId, a.platform, a.accountExternalId);
      return send(accountId, a, externalId);
    },
    summarize: (a) => `Send a direct message on ${a.platform} to ${a.recipientId}: "${String(a.text).slice(0, 120)}". It reaches a real person immediately.`,
  },
  {
    name: 'scheduleSocialPost',
    domain: 'social',
    title: 'Schedule a social post',
    description: 'Queue a post to go out later through the account\'s scheduling tool. Needs the channel to post to, the text, and the date/time. The post publishes on its own at that time to a real audience.',
    // A scheduled post is still a real send — deferring it does not lower the
    // stakes, so it is external_send, not internal_write.
    gate: 'external_send',
    inputSchema: obj({ platform: S.string, text: S.string, dueAt: S.string, channelId: S.string }, ['platform', 'text', 'dueAt', 'channelId']),
    zod: z.object({
      platform: livePlatform,
      text: z.string().min(1),
      dueAt: z.string().min(1),
      channelId: z.string().min(1),
    }),
    run: async (accountId, a) => {
      await requireBuffer(accountId);
      return bufferCreatePost(a.channelId, a.text, a.dueAt);
    },
    summarize: (a) => `Schedule a ${a.platform} post for ${a.dueAt}: "${String(a.text).slice(0, 120)}". It publishes automatically at that time.`,
  },
  {
    name: 'listScheduledSocialPosts',
    domain: 'social',
    title: 'List scheduled posts',
    description: 'List posts already queued to go out later, optionally filtered by status. Use when the user asks what is scheduled or wants to check the content calendar.',
    gate: 'read',
    inputSchema: obj({ status: S.string, limit: S.number }),
    zod: z.object({ status: z.string().optional(), limit: z.number().int().min(1).max(100).optional() }),
    run: async (accountId, a) => {
      const conn = await requireBuffer(accountId);
      return bufferListPosts(String(conn.external_id), a?.status, a?.limit ?? 20);
    },
  },

  // ------------------------------------------------------------------- ads
  {
    name: 'getAdBreakdown',
    domain: 'social',
    title: 'Break down ad performance',
    description: 'Break one campaign\'s performance down into its individual ads or ad sets, with spend, clicks, CTR and conversions per row, so you can compare them. For whole-campaign totals use getInsights instead.',
    gate: 'read',
    inputSchema: obj({ metaObjectId: S.string, level: S.string }, ['metaObjectId', 'level']),
    // The backing breakdown reports per-ad and per-ad-set rows. Campaign-level
    // totals are already covered by the existing `getInsights` capability, so
    // they are deliberately not duplicated here.
    zod: z.object({ metaObjectId: z.string().min(1), level: z.enum(['adset', 'ad']) }),
    run: (accountId, a) => getInsightsByLevel(accountId, a.metaObjectId, a.level),
  },
  {
    name: 'setAdStatus',
    domain: 'social',
    title: 'Turn an ad on or off',
    description: 'Turn a campaign, ad set or ad ACTIVE or PAUSED. Setting it ACTIVE restarts real ad spend on the user\'s payment method; PAUSED stops it.',
    // ACTIVE resumes real money leaving the user's account — that reaches the
    // outside world, so external_send, never internal_write.
    gate: 'external_send',
    inputSchema: obj({ metaObjectId: S.string, status: S.string }, ['metaObjectId', 'status']),
    zod: z.object({ metaObjectId: z.string().min(1), status: z.enum(['ACTIVE', 'PAUSED']) }),
    run: (accountId, a) => updateStatus(accountId, a.metaObjectId, a.status),
    // Packet 1.4: ACTIVE restarts real ad spend, so it must clear the monthly
    // budget gate as well; PAUSED stops spend and must stay available even when
    // the account is over its limit — blocking the off-switch would be perverse.
    spendsMoney: (a) => a?.status === 'ACTIVE',
    summarize: (a) => (a.status === 'ACTIVE'
      ? `Set ${a.metaObjectId} to ACTIVE. This restarts real ad spend immediately.`
      : `Set ${a.metaObjectId} to PAUSED. This stops its ad spend.`),
  },
];
