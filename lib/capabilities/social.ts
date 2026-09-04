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
import { resolveTokensForRow } from '@/lib/social/connection-token';
import {
  publishToInstagramForAccount, publishToFacebookPage, getInstagramInsights, getMetaCreds,
} from '@/lib/integrations/meta';
import { listConversations,
  getComments, replyToComment, hideComment, deleteComment, sendMetaMessage,
} from '@/lib/social/meta-engagement';
import { getInsightsByLevel, updateStatus } from '@/lib/social/meta-ads';
import { listOwnPosts, getOwnProfile, type SocialContentType } from '@/lib/social/meta-read';
import { getIntegrations } from '@/lib/social/index';
import { createPost as bufferCreatePost, listPosts as bufferListPosts } from '@/lib/social/buffer';
import { requireSocialCredential } from '@/lib/social/credentials';
import { publishLinkedinPost } from '@/lib/social/linkedin-oauth';
import { publishTiktokDraft } from '@/lib/social/tiktok-oauth';
import { publishXPost, listXReplies } from '@/lib/social/x-oauth';
import { publishThreadsPost, listThreadsReplies, replyToThreadsPost, hideThreadsReply } from '@/lib/social/threads';
import { generateContentPost } from '@/lib/ai/generation';
import { LIVE_SOCIALS, SOCIAL_KEYS, type SocialKey } from '@/lib/social/providers';
import { markGenerationPublished, listGenerations } from '@/lib/generations/store';
import { obj, S, type Capability, rowsOf, plural, samples, tally, present, clip, digestLine } from './types';

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

/**
 * Resolve WHICH connected accounts a READ spans.
 *
 * resolveExternalId above throws on ambiguity, and that is right for anything
 * that publishes, DMs or moderates: posting to the wrong one of five Instagram
 * accounts is not recoverable. A read has no such cost, and the strict rule made
 * the obvious request impossible — "analyse my profiles", with five connected,
 * came back as "specify which one" instead of five profiles.
 *
 * So reads fan out: an explicit id still wins and is still validated, and with
 * none given every connected account on that platform is read, newest first,
 * bounded by MAX_FANOUT_ACCOUNTS so a large estate cannot turn one question into
 * fifty Graph calls.
 */
const MAX_FANOUT_ACCOUNTS = 5;

async function resolveExternalIdsForRead(
  accountId: string,
  platform: string,
  externalId?: string,
): Promise<string[]> {
  const conns = (await getConnections(accountId)).filter(
    (c: any) => c.provider === platform && c.status === 'connected',
  );
  if (externalId) {
    const hit = conns.find((c: any) => String(c.external_id) === externalId);
    if (!hit) throw new Error(`No connected ${platform} account with id ${externalId}.`);
    return [String(hit.external_id)];
  }
  if (!conns.length) throw new Error(`No ${platform} account is connected.`);
  return conns
    .filter((c: any) => c.external_id)
    .slice(0, MAX_FANOUT_ACCOUNTS)
    .map((c: any) => String(c.external_id));
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
  linkedin: async (accountId, a, externalId) => {
    const conn = await getConnection(accountId, 'linkedin', externalId);
    const memberId = conn?.meta?.member_id;
    const { accessToken: token } = conn ? await resolveTokensForRow(conn) : { accessToken: null };
    if (!token || !memberId) throw new Error('No LinkedIn account connected — connect LinkedIn in Settings first');
    return publishLinkedinPost(token, String(memberId), { text: a.message || '', link: a.link });
  },
  // Packet 7.1: TikTok's unaudited Content Posting API can only push a video
  // to the creator's TikTok inbox as a draft — see lib/social/tiktok-oauth.ts.
  // publishSocialPost's schema still requires a video for TikTok (below) so
  // this never silently "posts" a text-only message.
  tiktok: async (accountId, a, externalId) => {
    const conn = await getConnection(accountId, 'tiktok', externalId);
    const { accessToken: token } = conn ? await resolveTokensForRow(conn) : { accessToken: null };
    if (!token) throw new Error('No TikTok account connected — connect TikTok in Settings first');
    if (!a.videoUrl) throw new Error('TikTok posts require a video URL.');
    return publishTiktokDraft(token, { videoUrl: a.videoUrl, title: a.message });
  },
  x: async (accountId, a, externalId) => {
    const conn = await getConnection(accountId, 'x', externalId);
    const { accessToken: token } = conn ? await resolveTokensForRow(conn) : { accessToken: null };
    if (!token) throw new Error('No X account connected — connect X in Settings first');
    if (!a.message) throw new Error('X posts require text.');
    return publishXPost(token, a.message);
  },
  threads: async (accountId, a, externalId) => {
    const conn = await getConnection(accountId, 'threads', externalId);
    // The Threads callback stores the Threads user id as the connection's
    // external_id (and mirrors it at meta.threads_user_id) — see
    // app/api/social/threads/callback/route.ts.
    const userId = conn?.external_id;
    const { accessToken: token } = conn ? await resolveTokensForRow(conn) : { accessToken: null };
    if (!token || !userId) throw new Error('No Threads account connected — connect Threads in Settings first');
    if (!a.message && !a.imageUrl && !a.videoUrl) throw new Error('A Threads post needs text, an image, or a video.');
    return publishThreadsPost(token, String(userId), { text: a.message, imageUrl: a.imageUrl, videoUrl: a.videoUrl });
  },
};

const MESSENGERS: Partial<Record<SocialKey, Dispatch>> = {
  instagram: (accountId, a, externalId) =>
    sendMetaMessage(accountId, 'instagram', a.recipientId, a.text, externalId),
  // Facebook Page DMs. Reading them already worked (listSocialMessages accepts
  // 'facebook') and pages_messaging was already granted at connect time — the
  // send was simply never mapped, so a Page message could be read and not
  // answered.
  facebook: (accountId, a, externalId) =>
    sendMetaMessage(accountId, 'facebook', a.recipientId, a.text, externalId),
};

// ---------------------------------------------------------------------------
// Result readers for the outbound digests
// ---------------------------------------------------------------------------
//
// WHY THESE EXIST. Every outbound capability in this file hands back the
// PLATFORM's own response, unchanged, and each platform names its receipt
// differently: Meta's Graph edges return `{id}` (and `{id, post_id}` for a Page
// photo), the Send API returns `{message_id, recipient_id}`, LinkedIn returns
// `{id: "urn:li:share:…"}`, X returns `{data: {id}}`, TikTok returns
// `{data: {publish_id}}`. A digest is read by the model AS FACT, so it may
// speak only when one of those receipts is actually present — see the rule in
// lib/capabilities/video.ts. Every publisher and messenger THROWS on a non-2xx,
// so "resolved without a receipt" means a shape we do not recognise, and the
// honest response to that is silence, not a cheerful "Published".
//
// None of this ever reads `args`. The argument is the request; the receipt is
// what the platform says happened.

/** The platform's own id for the thing that was just created, or null. */
function platformReceiptId(result: any): string | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const r: any = result;
  const direct = ['id', 'post_id', 'message_id', 'publish_id'];
  for (const k of direct) if (present(r, k)) return String(r[k]);
  // X and TikTok nest theirs one level down under `data`.
  const d = r.data;
  if (d && typeof d === 'object' && !Array.isArray(d)) {
    for (const k of ['id', 'publish_id', 'post_id']) if (present(d, k)) return String(d[k]);
  }
  return null;
}

/**
 * A real, followable permalink built straight from the platform's own publish
 * receipt — NEVER a guess. Deliberately narrow: only X (`x.com/i/web/status/
 * {id}`, documented to resolve without a username) and LinkedIn
 * (`linkedin.com/feed/update/{urn}`, the URN IS the update identifier) are
 * constructible this way. Facebook and Instagram's publish responses carry
 * only an internal id — their real permalink_url is a SEPARATE field only a
 * follow-up Graph read returns (see listOwnPosts / syncPerformance,
 * lib/content/performance.ts, which does exactly that read, later). Threads
 * is the same shape. TikTok never actually publishes here at all — see the
 * digest above. Generations tied to those platforms are simply never marked
 * published by this path; they keep consuming quota until a human approves/
 * rejects them by hand. That gap is a real, currently-unclosed one — see this
 * packet's report.
 */
function constructChannelUrl(platform: string, result: any): string | null {
  const id = platformReceiptId(result);
  if (!id) return null;
  if (platform === 'x') return `https://x.com/i/web/status/${id}`;
  if (platform === 'linkedin') return `https://www.linkedin.com/feed/update/${id}`;
  return null;
}

/** True only for the `{success: true}` acknowledgement Meta returns on the
 *  edges that have no object to name (hiding a comment, setting a status). */
function acknowledged(result: any): boolean {
  return !!result && typeof result === 'object' && !Array.isArray(result) && (result as any).success === true;
}

// listSocialMessages / listSocialPosts / getSocialProfile are structurally
// Meta-only (Graph API Pages/IG concepts — DM threads, the Page/IG content
// shelf, the Page/IG profile object) and stay that way regardless of what
// engagement platforms exist. This narrow map is exactly that restriction —
// it is NOT the comment/reply/hide/delete dispatch, which is per-platform
// below.
const META_ONLY_PLATFORMS: Partial<Record<SocialKey, 'facebook' | 'instagram'>> = {
  facebook: 'facebook',
  instagram: 'instagram',
};

function metaOnlyPlatform(platform: string): 'facebook' | 'instagram' {
  const p = META_ONLY_PLATFORMS[platform as SocialKey];
  if (!p) throw new Error(`That isn't available for ${platform} yet.`);
  return p;
}

// ---------------------------------------------------------------------------
// Comment engagement dispatch — one map per action, each platform's own
// implementation, in the same "dispatch map is the only place a platform
// string appears" spirit as PUBLISHERS/MESSENGERS above. A platform missing
// from a map is an honest "not available" error, not a silent no-op — see the
// file header. Meta behaviour (facebook/instagram) is unchanged: same
// functions, same call shape, just reached through a map entry instead of an
// inline branch.
const REPLIES_UNSUPPORTED = (platform: string) => `Comments/replies aren't available for ${platform} yet.`;

const COMMENT_LISTERS: Partial<Record<SocialKey, Dispatch>> = {
  facebook: (accountId, a, externalId) => getComments(accountId, a.postId, 'facebook', a.limit ?? 25, externalId),
  instagram: (accountId, a, externalId) => getComments(accountId, a.postId, 'instagram', a.limit ?? 25, externalId),
  // Threads: threads_read_replies is a granted scope and the Reply Management
  // edge (GET /{id}/replies) is real — build it.
  threads: async (accountId, a, externalId) => {
    const conn = await getConnection(accountId, 'threads', externalId);
    const { accessToken: token } = conn ? await resolveTokensForRow(conn) : { accessToken: null };
    if (!token) throw new Error('No Threads account connected — connect Threads in Settings first');
    return listThreadsReplies(token, a.postId, a.limit ?? 25);
  },
  // X: reading replies needs recent-search, which sits above the pay-per-use
  // default tier — listXReplies throws a message naming that when X 403s/429s.
  x: async (accountId, a, externalId) => {
    const conn = await getConnection(accountId, 'x', externalId);
    const { accessToken: token } = conn ? await resolveTokensForRow(conn) : { accessToken: null };
    if (!token) throw new Error('No X account connected — connect X in Settings first');
    return listXReplies(token, a.postId, a.limit ?? 25);
  },
  // linkedin: deliberately absent. Reading comments on a share lives behind
  // LinkedIn's Community Management API, a SEPARATE product from the "Sign In
  // with LinkedIn" + "Share on LinkedIn" products this app's w_member_social
  // scope comes from, requiring its own partner-programme application and
  // approval. Shipping this against w_member_social alone would 403 on every
  // call, which is exactly the anti-pattern this task exists to avoid.
};

const COMMENT_REPLIERS: Partial<Record<SocialKey, Dispatch>> = {
  facebook: (accountId, a, externalId) => replyToComment(accountId, a.commentId, a.message, 'facebook', externalId),
  instagram: (accountId, a, externalId) => replyToComment(accountId, a.commentId, a.message, 'instagram', externalId),
  threads: async (accountId, a, externalId) => {
    const conn = await getConnection(accountId, 'threads', externalId);
    const userId = conn?.external_id;
    const { accessToken: token } = conn ? await resolveTokensForRow(conn) : { accessToken: null };
    if (!token || !userId) throw new Error('No Threads account connected — connect Threads in Settings first');
    return replyToThreadsPost(token, String(userId), a.commentId, a.message);
  },
  // X models a reply as a normal tweet with in_reply_to_tweet_id — same
  // paid-tier requirement as publishSocialPost's X path.
  x: async (accountId, a, externalId) => {
    const conn = await getConnection(accountId, 'x', externalId);
    const { accessToken: token } = conn ? await resolveTokensForRow(conn) : { accessToken: null };
    if (!token) throw new Error('No X account connected — connect X in Settings first');
    return publishXPost(token, a.message, a.commentId);
  },
  // linkedin: same partner-programme gate as COMMENT_LISTERS above.
};

const COMMENT_HIDERS: Partial<Record<SocialKey, Dispatch>> = {
  facebook: (accountId, a, externalId) => hideComment(accountId, a.commentId, a.hide ?? true, 'facebook', externalId),
  instagram: (accountId, a, externalId) => hideComment(accountId, a.commentId, a.hide ?? true, 'instagram', externalId),
  threads: async (accountId, a, externalId) => {
    const conn = await getConnection(accountId, 'threads', externalId);
    const { accessToken: token } = conn ? await resolveTokensForRow(conn) : { accessToken: null };
    if (!token) throw new Error('No Threads account connected — connect Threads in Settings first');
    return hideThreadsReply(token, a.commentId, a.hide ?? true);
  },
  // X: no scope requested (or generally available) grants hiding a reply —
  // there is no map entry, so hideSocialComment throws a clear "X does not
  // support hiding comments" rather than silently doing nothing.
  // linkedin: same partner-programme gate as above; also no hide concept in
  // the Community Management API's Comments surface even if it were reachable.
};

const COMMENT_DELETERS: Partial<Record<SocialKey, Dispatch>> = {
  facebook: (accountId, a, externalId) => deleteComment(accountId, a.commentId, 'facebook', externalId),
  instagram: (accountId, a, externalId) => deleteComment(accountId, a.commentId, 'instagram', externalId),
  // Threads: the public Graph API documents no delete endpoint for a post or
  // reply — not a scope gap, the operation does not exist. No entry, honest error.
  // X: DELETE /2/tweets/:id only deletes a tweet POSTED BY the authenticated
  // user — there is no API to delete someone else's reply, which is what
  // "delete a comment" means for moderation. Mapping this to deleteXTweet
  // would silently only work when commentId happens to be this account's own
  // tweet, which is not what the capability promises. No entry, honest error.
  // linkedin: same partner-programme gate as above.
};

// ---------------------------------------------------------------------------
// Buffer guard
// ---------------------------------------------------------------------------

/**
 * Buffer used to be single-tenant (global env credentials), so this guard
 * refused every account: exposing it unscoped would have leaked one account's
 * channels and scheduled posts to another. Packet 7.2 made per-account
 * credentials real, so the guard now PASSES for an account that has connected
 * its own Buffer token — and still refuses, unchanged, for one that has not.
 *
 * It got stricter rather than looser. A connection row alone is no longer
 * enough: `requireSocialCredential` also demands a usable credential for THIS
 * account, because POST /api/integrations lets a client create a bare
 * `provider: 'buffer'` row with no token. A row without a credential is not a
 * connection, and it must not open the capability.
 *
 * Both reads are account-scoped in-query and neither is silently caught — a
 * failed credential resolve refuses, it never falls through.
 */
async function requireBuffer(accountId: string) {
  const conn = await getConnection(accountId, 'buffer');
  if (!conn) throw new Error('Buffer is not connected for this account.');
  const cred = await requireSocialCredential(accountId, 'buffer');
  // Prefer the row's external_id (the Buffer organisation), falling back to the
  // credential's, so scheduling still targets the right organisation.
  return { ...conn, external_id: conn.external_id ?? cred.externalId };
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
    name: 'listSocialMessages',
    domain: 'social',
    title: 'List direct messages',
    description: 'Read recent DM conversations for a connected account, newest first. Returns who each thread is with, their recipient id, and the last message — use this BEFORE sendSocialMessage, which needs that recipient id.',
    gate: 'read',
    inputSchema: obj({ platform: S.string, limit: S.number, accountExternalId: S.string }, ['platform']),
    zod: z.object({
      platform: livePlatform,
      limit: z.number().int().min(1).max(100).optional(),
      accountExternalId: z.string().optional(),
    }),
    run: (accountId, a) => listConversations(accountId, metaOnlyPlatform(a.platform), a.limit ?? 25, a.accountExternalId),
    // The message text is the substance here and is what truncation eats first,
    // so quote a few verbatim alongside who they are from.
    digest: (_a, result) => {
      const rows = rowsOf(result);
      if (!rows) return '';
      if (!rows.length) return 'No direct messages.';
      const names = samples(rows, ['recipientName'], 4);
      const quoted = samples(rows, ['lastMessage'], 2);
      return digestLine(
        `${plural(rows.length, 'conversation')}.`,
        names.length ? `With: ${names.join(', ')}.` : null,
        quoted.length ? `Latest: ${quoted.map((q) => `"${q}"`).join(' · ')}` : null,
      );
    },
  },
  {
    name: 'listSocialComments',
    domain: 'social',
    title: 'List comments on a post',
    description: 'Read the comments on one published post so you can summarise them or decide what to reply to. Needs the post id and which platform it is on.',
    gate: 'read',
    inputSchema: obj({ postId: S.string, platform: S.string, limit: S.number, accountExternalId: S.string }, ['postId', 'platform']),
    zod: z.object({
      postId: z.string().min(1),
      platform: livePlatform,
      limit: z.number().int().min(1).max(100).optional(),
      accountExternalId: z.string().optional(),
    }),
    // accountExternalId pins WHICH connected page/profile the comments are read
    // with. Without it, an account with several connected pages reads through
    // whichever one resolves first — see the note on getComments.
    run: (accountId, a) => {
      const lister = COMMENT_LISTERS[a.platform as SocialKey];
      if (!lister) throw new Error(REPLIES_UNSUPPORTED(a.platform));
      return lister(accountId, a, a.accountExternalId);
    },
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
    name: 'listSocialPosts',
    domain: 'social',
    title: 'List posts on a connected page or profile',
    description: "Read the content a connected Facebook Page or Instagram account has — caption, when it went out, its link, and its like/comment counts. contentType picks the shelf: 'posts' (default, everything published), 'videos' (uploaded videos and reels), 'stories' (Instagram stories live right now), 'tagged' (other people's Instagram posts that @-tag this account). This is where post ids come from: use it before listSocialComments or getSocialInsights, and whenever the user asks how recent posts did or what has been posted lately. With several accounts connected and none named, it covers all of them, each row tagged with the account it came from. Instagram Saved posts and Collections (the bookmark icon) are not readable — Meta exposes no API for them at all — so say that plainly rather than substituting something else.",
    gate: 'read',
    inputSchema: obj({ platform: S.string, contentType: S.string, accountExternalId: S.string, limit: S.number }, ['platform']),
    zod: z.object({
      platform: livePlatform,
      contentType: z.enum(['posts', 'videos', 'stories', 'tagged']).optional(),
      accountExternalId: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    run: async (accountId, a) => {
      const platform = metaOnlyPlatform(a.platform); // facebook | instagram — same Meta-only surface
      const ids = await resolveExternalIdsForRead(accountId, a.platform, a.accountExternalId);
      const contentType: SocialContentType = a.contentType ?? 'posts';
      // One account: the plain list, exactly as a single-account estate expects.
      if (ids.length === 1) return listOwnPosts(accountId, platform, ids[0], a.limit ?? 10, contentType);
      // Several: every account's posts, each tagged with the account it came
      // from, and a per-account slice of the limit so the result stays a
      // readable comparison rather than one account's feed drowning the rest.
      const per = Math.max(1, Math.ceil((a.limit ?? 10) / ids.length));
      const batches = await Promise.all(ids.map(async (id) => {
        try {
          const posts = await listOwnPosts(accountId, platform, id, per, contentType);
          return posts.map((p) => ({ ...p, accountExternalId: id }));
        } catch (e: any) {
          // One unreadable account must not blank out the others — report it
          // as a row so the answer can say which one failed and why.
          return [{ accountExternalId: id, error: e?.message || 'could not read this account' } as any];
        }
      }));
      return batches.flat();
    },
    // The caption and the engagement numbers are the substance; the id is what
    // every follow-up call needs, so it is never dropped from the digest.
    digest: (_a, result) => {
      const rows = rowsOf(result);
      if (!rows) return '';
      if (!rows.length) return 'That account has no published posts.';
      const quoted = rows.slice(0, 3).map((r: any) => {
        const text = typeof r.text === 'string' && r.text.trim() ? r.text.trim().slice(0, 80) : '(no caption)';
        const eng = [
          typeof r.likes === 'number' ? `${r.likes} likes` : null,
          typeof r.comments === 'number' ? `${r.comments} comments` : null,
        ].filter(Boolean).join(', ');
        return `${r.id} — "${text}"${eng ? ` (${eng})` : ''}`;
      });
      return digestLine(`${plural(rows.length, 'published post')}.`, `Recent: ${quoted.join(' | ')}`);
    },
  },
  {
    name: 'getSocialProfile',
    domain: 'social',
    title: 'Read a connected page or profile',
    description: 'Read the profile of a connected Facebook Page or Instagram account — its name, handle, bio, follower count and public link. Use when the user asks about one of their own pages or profiles, or before writing content that has to match how a profile presents itself. With several accounts connected and none named, it returns all of them — so \"analyse my profiles\" works in one call.',
    gate: 'read',
    inputSchema: obj({ platform: S.string, accountExternalId: S.string }, ['platform']),
    zod: z.object({ platform: livePlatform, accountExternalId: z.string().optional() }),
    run: async (accountId, a) => {
      const platform = metaOnlyPlatform(a.platform);
      const ids = await resolveExternalIdsForRead(accountId, a.platform, a.accountExternalId);
      if (ids.length === 1) return getOwnProfile(accountId, platform, ids[0]);
      // "Analyse my profiles" is a normal request and it means all of them.
      return Promise.all(ids.map(async (id) => {
        try {
          return await getOwnProfile(accountId, platform, id);
        } catch (e: any) {
          return { platform, id, error: e?.message || 'could not read this profile' } as any;
        }
      }));
    },
    digest: (_a, result) => {
      const describe = (r: any) => {
        const who = r.username ? `@${r.username}` : (r.name || r.id);
        const bits = [
          typeof r.followers === 'number' ? `${r.followers} followers` : null,
          typeof r.postCount === 'number' ? `${r.postCount} posts` : null,
        ].filter(Boolean).join(', ');
        return r.error ? `${who}: ${r.error}` : `${who}${bits ? ` (${bits})` : ''}`;
      };
      if (Array.isArray(result)) {
        if (!result.length) return '';
        return digestLine(`${plural(result.length, 'profile')}.`, result.map(describe).join(' | '));
      }
      if (!result || typeof result !== 'object') return '';
      const r: any = result;
      return digestLine(
        `${r.platform === 'instagram' ? 'Instagram' : 'Facebook Page'} ${describe(r)}.`,
        r.bio ? `Bio: "${String(r.bio).slice(0, 160)}"` : null,
      );
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
    description: 'Publish a post to one of the connected social accounts, right now, visible to that account\'s real audience. Call listSocialAccounts first and pass the id of the account to post to. Instagram posts must include an image or video. Use draftSocialPost to write the copy first. Pass contentItemId when this post carries an approved generated image/video (from promoteGenerationToContent) — on platforms where the platform hands back a real permalink (currently X and LinkedIn), that generation is marked published so its stored copy can eventually be freed once the channel is the system of record.',
    gate: 'external_send',
    inputSchema: obj({
      platform: S.string, accountExternalId: S.string, message: S.string,
      imageUrl: S.string, videoUrl: S.string, link: S.string, contentItemId: S.string,
    }, ['platform']),
    zod: z.object({
      platform: livePlatform,
      accountExternalId: z.string().optional(),
      message: z.string().optional(),
      imageUrl: z.string().url().optional(),
      videoUrl: z.string().url().optional(),
      link: z.string().url().optional(),
      contentItemId: z.string().optional(),
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
      const result = await pub(accountId, a, externalId);
      // Best-effort, never fails the publish itself: link this publish back to
      // any generation queued for this content item so its stored bytes can
      // eventually be freed (purgeExpiredGenerations, after
      // GENERATION_PUBLISH_GRACE_DAYS) now that the channel — not us — is the
      // system of record. Only when constructChannelUrl actually produced a
      // real permalink; see its comment for which platforms that covers.
      if (a.contentItemId) {
        const channelUrl = constructChannelUrl(a.platform, result);
        if (channelUrl) {
          const linked = await listGenerations(accountId, {
            contentItemId: a.contentItemId, reviewState: 'APPROVED',
          }).catch(() => [] as any[]);
          for (const g of linked) {
            if (!g.published_at) await markGenerationPublished(accountId, g.id, channelUrl).catch(() => {});
          }
        }
      }
      return result;
    },
    summarize: (a) => `Publish this post to ${a.platform}${a.accountExternalId ? ` (${a.accountExternalId})` : ''}. It goes live immediately to that account's real audience.`,
    // THE TIKTOK CASE IS WHY THIS READS THE RESULT AND NOT THE ARGUMENTS.
    // `publishSocialPost` on TikTok does not publish anything: publishTiktokDraft
    // pushes the video to the creator's TikTok inbox as a DRAFT they must post
    // themselves (the DIRECT_POST scope needs an app audit this app has not
    // passed — see lib/social/tiktok-oauth.ts). A digest built from
    // `args.platform` and the capability's own title would have written
    // "Published to TikTok" for a post that is sitting unposted in someone's
    // drafts. The `publish_id` receipt TikTok returns — and only TikTok returns
    // — is what distinguishes the two, so the wording keys off THAT.
    digest: (_args, result) => {
      const id = platformReceiptId(result);
      if (!id) return '';
      const isTiktokDraft = !!(result as any)?.data && present((result as any).data, 'publish_id');
      return isTiktokDraft
        ? digestLine(
            `Sent to the creator's TikTok inbox as a DRAFT (${clip(id, 60)}).`,
            'It is NOT published — nobody can see it until the creator opens TikTok and posts it themselves.',
          )
        : digestLine(`Published. The platform returned post id ${clip(id, 60)}, so it is live to that account's real audience.`);
    },
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
    run: (accountId, a) => {
      const replier = COMMENT_REPLIERS[a.platform as SocialKey];
      if (!replier) throw new Error(REPLIES_UNSUPPORTED(a.platform));
      return replier(accountId, a, a.accountExternalId);
    },
    summarize: (a) => `Post a public reply to comment ${a.commentId} on ${a.platform}: "${String(a.message).slice(0, 120)}". Everyone who sees the post sees this reply.`,
    // replyToComment posts to the `${commentId}/comments` edge and returns
    // Meta's `{id}` for the reply it created; graphPost throws on any non-2xx.
    // The reply's OWN id is the receipt — the comment id in the args is the
    // thing replied TO, and echoing that back would prove nothing about whether
    // a reply now exists.
    digest: (_args, result) => {
      const id = platformReceiptId(result);
      if (!id) return '';
      return digestLine(`Posted a public reply; it exists on the platform as comment ${clip(id, 60)}.`);
    },
  },
  {
    name: 'hideSocialComment',
    domain: 'social',
    title: 'Hide a comment',
    description: 'Hide (or unhide) a comment on one of the account\'s posts so other people stop seeing it. Use for spam or abuse when the user asks. Pass hide:false to make it visible again.',
    // Hiding changes what a real audience sees on a live post, so it is held to
    // the same bar as a send rather than treated as an internal write.
    gate: 'external_send',
    inputSchema: obj({ commentId: S.string, hide: { type: 'boolean' }, platform: S.string, accountExternalId: S.string }, ['commentId']),
    zod: z.object({
      commentId: z.string().min(1),
      hide: z.boolean().optional(),
      platform: livePlatform.optional(),
      accountExternalId: z.string().optional(),
    }),
    // No platform given: keep the original Meta-only fallback (hideComment
    // resolves via getMetaCreds with no provider hint) byte-identical. A
    // platform given for a non-Meta account routes through its own hider —
    // and X has no entry there at all, because X grants no scope that hides a
    // reply, so hideSocialComment on X throws instead of no-op-ing.
    run: (accountId, a) => {
      if (!a.platform) return hideComment(accountId, a.commentId, a.hide ?? true, undefined, a.accountExternalId);
      const hider = COMMENT_HIDERS[a.platform as SocialKey];
      if (!hider) throw new Error(`${a.platform} does not support hiding comments.`);
      return hider(accountId, a, a.accountExternalId);
    },
    summarize: (a) => (a.hide === false
      ? `Unhide comment ${a.commentId} so the public can see it again.`
      : `Hide comment ${a.commentId} from everyone else viewing the post.`),
    // NAMED LIMITATION, not papered over: Meta's hide edge answers
    // `{success: true}` and nothing else — no comment id, no echoed hidden
    // state. So the ONLY thing the return proves is that the Graph call for
    // THIS invocation was accepted (graphPost throws otherwise). The direction
    // is therefore taken from `args.hide`, which is the one place it exists,
    // and the line says "Meta accepted" rather than asserting the comment's
    // current visibility as an independently observed fact. Without the
    // acknowledgement there is no digest at all.
    digest: (a, result) => {
      if (!acknowledged(result)) return '';
      const hiding = a?.hide !== false;
      return digestLine(
        `Meta accepted the request to ${hiding ? 'hide' : 'unhide'} that comment.`,
        'The response carries no comment id or visibility field, so this confirms the call was accepted, not a re-read of the comment.',
      );
    },
  },
  {
    name: 'deleteSocialComment',
    domain: 'social',
    title: 'Delete a comment',
    description: 'Permanently delete a comment on one of the account\'s posts. This cannot be undone — prefer hiding unless the user specifically asks to delete.',
    gate: 'destructive',
    inputSchema: obj({ commentId: S.string, platform: S.string, accountExternalId: S.string }, ['commentId']),
    zod: z.object({
      commentId: z.string().min(1),
      platform: livePlatform.optional(),
      accountExternalId: z.string().optional(),
    }),
    // Same no-platform Meta fallback as hideSocialComment above. Threads has
    // no delete endpoint at all in the public API and X can only delete its
    // own tweets (not moderate someone else's reply) — neither has a map
    // entry, so both throw a clear, honest error instead of pretending.
    run: (accountId, a) => {
      if (!a.platform) return deleteComment(accountId, a.commentId, undefined, a.accountExternalId);
      const deleter = COMMENT_DELETERS[a.platform as SocialKey];
      if (!deleter) throw new Error(`${a.platform} does not support deleting comments.`);
      return deleter(accountId, a, a.accountExternalId);
    },
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
    // sendMetaMessage posts to me/messages and returns the Send API's
    // `{recipient_id, message_id}`; it throws on any non-2xx. `message_id` is
    // the receipt, and `recipient_id` is the platform's OWN statement of who it
    // went to — preferred over `args.recipientId` for exactly the reason this
    // packet exists: one is what was asked for, the other is what happened.
    digest: (_args, result) => {
      const id = platformReceiptId(result);
      if (!id) return '';
      const to = present(result, 'recipient_id') ? String((result as any).recipient_id) : null;
      return digestLine(
        `Delivered a direct message${to ? ` to ${clip(to, 60)}` : ''}; the platform returned message id ${clip(id, 60)}.`,
      );
    },
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
      return bufferCreatePost(accountId, a.channelId, a.text, a.dueAt);
    },
    summarize: (a) => `Schedule a ${a.platform} post for ${a.dueAt}: "${String(a.text).slice(0, 120)}". It publishes automatically at that time.`,
    // Buffer's create_post comes back through the MCP envelope reader
    // (lib/social/buffer.ts `extractText`), which parses whatever JSON the tool
    // put in its text block — so the shape is the vendor's, not ours, and it can
    // legitimately be a bare string on an unexpected response. A queued post id
    // is the only thing that proves the post is in the queue, so that is the
    // only thing this speaks on.
    //
    // The scheduled TIME is read back from the result when Buffer states it, and
    // is otherwise left unsaid rather than restated from `args.dueAt` — Buffer
    // normalises and may reject or shift a due time, and a digest that recites
    // the requested slot would have the model telling the user a post goes out
    // at a time nothing confirmed.
    digest: (_args, result) => {
      if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
      const r: any = result;
      const id = present(r, 'id') ? String(r.id) : present(r, 'post_id') ? String(r.post_id) : null;
      if (!id) return '';
      const due = ['due_at', 'dueAt', 'scheduled_at'].map((k) => (present(r, k) ? String(r[k]) : null)).find(Boolean) || null;
      return digestLine(
        `Queued in Buffer as post ${clip(id, 60)}${due ? `, due ${clip(due, 40)}` : ''}.`,
        'It is scheduled, NOT published — nothing has reached the audience yet.',
      );
    },
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
      return bufferListPosts(accountId, String(conn.external_id), a?.status, a?.limit ?? 20);
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
    // NAMED LIMITATION. updateStatus (lib/social/meta-ads.ts) is typed
    // `Promise<{ success: true }>` and returns that literal — it never echoes
    // the object id or the resulting status, so the return carries no
    // independent evidence of WHAT the object now is, only that the Graph POST
    // for this call was accepted (graphPost throws otherwise). This is the
    // weakest evidence of the twelve gated capabilities and the wording says so
    // plainly instead of dressing an acknowledgement up as an observation. If
    // the true status is ever needed as fact, it has to be re-read — getInsights
    // and getAdBreakdown are the reads that do it.
    digest: (a, result) => {
      if (!acknowledged(result)) return '';
      const status = a?.status === 'ACTIVE' || a?.status === 'PAUSED' ? a.status : null;
      if (!status) return '';
      return digestLine(
        `Meta accepted the status change to ${status}${status === 'ACTIVE' ? ' — real ad spend restarts now' : ' — its ad spend stops'}.`,
        'The response is a bare acknowledgement with no object id or status field, so re-read the ad to confirm what it is now.',
      );
    },
  },
];
