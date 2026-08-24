// Meta (Facebook Page + Instagram Business) READ access — the profile itself
// and the posts it has published.
//
// Why this file exists: the assistant could publish to a Page/IG, read the
// comments on a post, and pull insights for a media id — but nothing could
// list a connected page or profile's OWN published posts, and nothing could
// read the profile. So `listSocialComments(postId)` and
// `getSocialInsights(mediaId)` were unreachable in practice: there was no
// capability anywhere that produced a post id. "How did my last Instagram post
// do?" had no path through the toolset at all.
//
// Everything here is account-scoped through getMetaCreds() and takes an
// optional externalId so a user with several Pages/IGs reads the RIGHT one
// rather than whichever connected most recently.

import { getMetaCreds } from '@/lib/integrations/meta';

const GRAPH = 'https://graph.facebook.com/v18.0';

async function graphGet(path: string, params: Record<string, string>, token: string) {
  const qs = new URLSearchParams({ ...params, access_token: token }).toString();
  const res = await fetch(`${GRAPH}/${path}?${qs}`);
  const json = await res.json();
  if (!res.ok) throw new Error(`Meta error (${res.status}): ${json?.error?.message || res.statusText}`);
  return json;
}

export interface SocialPostSummary {
  /** The id to hand to listSocialComments / getSocialInsights. */
  id: string;
  platform: 'facebook' | 'instagram';
  text: string | null;
  publishedAt: string | null;
  permalink: string | null;
  mediaType: string | null;
  mediaUrl: string | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
}

export interface SocialProfile {
  platform: 'facebook' | 'instagram';
  id: string;
  name: string | null;
  username: string | null;
  bio: string | null;
  category: string | null;
  followers: number | null;
  following: number | null;
  postCount: number | null;
  profileUrl: string | null;
  website: string | null;
  pictureUrl: string | null;
}

const FB_POST_FIELDS =
  'id,message,story,created_time,permalink_url,full_picture,shares,' +
  'likes.summary(true).limit(0),comments.summary(true).limit(0)';

const IG_MEDIA_FIELDS =
  'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count';

/** Recent posts published BY a connected Facebook Page. */
export async function listFacebookPagePosts(
  accountId: string,
  externalId?: string,
  limit = 10,
): Promise<SocialPostSummary[]> {
  const { token, pageId, externalId: connId } = await getMetaCreds(accountId, {
    provider: 'facebook',
    externalId,
  });
  const target = externalId || pageId || connId;
  if (!target) throw new Error('No Facebook Page is connected for this account.');
  const json = await graphGet(`${target}/posts`, { fields: FB_POST_FIELDS, limit: String(limit) }, token);
  return (json.data || []).map((p: any): SocialPostSummary => ({
    id: String(p.id),
    platform: 'facebook',
    text: p.message ?? p.story ?? null,
    publishedAt: p.created_time ?? null,
    permalink: p.permalink_url ?? null,
    mediaType: p.full_picture ? 'photo' : null,
    mediaUrl: p.full_picture ?? null,
    likes: p.likes?.summary?.total_count ?? null,
    comments: p.comments?.summary?.total_count ?? null,
    shares: p.shares?.count ?? null,
  }));
}

/** Recent media published BY a connected Instagram Business account. */
export async function listInstagramMedia(
  accountId: string,
  externalId?: string,
  limit = 10,
): Promise<SocialPostSummary[]> {
  const { token, igUserId, externalId: connId } = await getMetaCreds(accountId, {
    provider: 'instagram',
    externalId,
  });
  const target = externalId || igUserId || connId;
  if (!target) throw new Error('No Instagram Business account is connected for this account.');
  const json = await graphGet(`${target}/media`, { fields: IG_MEDIA_FIELDS, limit: String(limit) }, token);
  return (json.data || []).map((m: any): SocialPostSummary => ({
    id: String(m.id),
    platform: 'instagram',
    text: m.caption ?? null,
    publishedAt: m.timestamp ?? null,
    permalink: m.permalink ?? null,
    mediaType: m.media_type ?? null,
    mediaUrl: m.media_url ?? m.thumbnail_url ?? null,
    likes: m.like_count ?? null,
    comments: m.comments_count ?? null,
    shares: null,
  }));
}

/** The connected Facebook Page itself — who it is and how big its audience is. */
export async function getFacebookPageProfile(
  accountId: string,
  externalId?: string,
): Promise<SocialProfile> {
  const { token, pageId, externalId: connId } = await getMetaCreds(accountId, {
    provider: 'facebook',
    externalId,
  });
  const target = externalId || pageId || connId;
  if (!target) throw new Error('No Facebook Page is connected for this account.');
  const p = await graphGet(
    target,
    { fields: 'id,name,username,about,category,link,website,fan_count,followers_count,picture{url}' },
    token,
  );
  return {
    platform: 'facebook',
    id: String(p.id),
    name: p.name ?? null,
    username: p.username ?? null,
    bio: p.about ?? null,
    category: p.category ?? null,
    followers: p.followers_count ?? p.fan_count ?? null,
    following: null,
    postCount: null,
    profileUrl: p.link ?? null,
    website: p.website ?? null,
    pictureUrl: p.picture?.data?.url ?? null,
  };
}

/** The connected Instagram Business profile — bio, audience size, post count. */
export async function getInstagramProfile(
  accountId: string,
  externalId?: string,
): Promise<SocialProfile> {
  const { token, igUserId, externalId: connId } = await getMetaCreds(accountId, {
    provider: 'instagram',
    externalId,
  });
  const target = externalId || igUserId || connId;
  if (!target) throw new Error('No Instagram Business account is connected for this account.');
  const p = await graphGet(
    target,
    { fields: 'id,username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url' },
    token,
  );
  return {
    platform: 'instagram',
    id: String(p.id),
    name: p.name ?? null,
    username: p.username ?? null,
    bio: p.biography ?? null,
    category: null,
    followers: p.followers_count ?? null,
    following: p.follows_count ?? null,
    postCount: p.media_count ?? null,
    profileUrl: p.username ? `https://instagram.com/${p.username}` : null,
    website: p.website ?? null,
    pictureUrl: p.profile_picture_url ?? null,
  };
}

/** Which shelf of an account's own content to read.
 *
 *  A note on what is NOT here, because it is asked for constantly: Instagram
 *  SAVED posts and Collections — the bookmark icon — are not exposed by any
 *  Meta API, on any permission, for any account type. There is no endpoint to
 *  call. The same is true of Facebook's "Saved items", whose API was retired.
 *  This is a platform limit, not a gap in this file, and no amount of app
 *  review unlocks it. What IS reachable is everything the account itself
 *  published or was tagged in, which is what the shelves below cover.
 */
export type SocialContentType = 'posts' | 'videos' | 'stories' | 'tagged';

/** Videos and reels the account uploaded — the "my saved videos" shelf.
 *  On Instagram this is /media filtered to video types; a Page has a dedicated
 *  /videos edge that also surfaces uploads not attached to a feed post. */
export async function listVideos(
  accountId: string,
  platform: 'facebook' | 'instagram',
  externalId?: string,
  limit = 10,
): Promise<SocialPostSummary[]> {
  if (platform === 'instagram') {
    // IG has no video-only edge; over-fetch and filter so `limit` still means
    // "this many videos" rather than "this many of whatever came back".
    const media = await listInstagramMedia(accountId, externalId, Math.min(50, limit * 4));
    return media.filter((m) => m.mediaType === 'VIDEO' || m.mediaType === 'REELS').slice(0, limit);
  }
  const { token, pageId, externalId: connId } = await getMetaCreds(accountId, {
    provider: 'facebook',
    externalId,
  });
  const target = externalId || pageId || connId;
  if (!target) throw new Error('No Facebook Page is connected for this account.');
  const json = await graphGet(
    `${target}/videos`,
    { fields: 'id,title,description,created_time,permalink_url,picture,likes.summary(true).limit(0),comments.summary(true).limit(0)', limit: String(limit) },
    token,
  );
  return (json.data || []).map((v: any): SocialPostSummary => ({
    id: String(v.id),
    platform: 'facebook',
    text: v.title || v.description || null,
    publishedAt: v.created_time ?? null,
    permalink: v.permalink_url ?? null,
    mediaType: 'video',
    mediaUrl: v.picture ?? null,
    likes: v.likes?.summary?.total_count ?? null,
    comments: v.comments?.summary?.total_count ?? null,
    shares: null,
  }));
}

/** Stories currently live on a connected Instagram account (24h window). */
export async function listInstagramStories(
  accountId: string,
  externalId?: string,
  limit = 25,
): Promise<SocialPostSummary[]> {
  const { token, igUserId, externalId: connId } = await getMetaCreds(accountId, {
    provider: 'instagram',
    externalId,
  });
  const target = externalId || igUserId || connId;
  if (!target) throw new Error('No Instagram Business account is connected for this account.');
  const json = await graphGet(`${target}/stories`, { fields: IG_MEDIA_FIELDS, limit: String(limit) }, token);
  return (json.data || []).map((m: any): SocialPostSummary => ({
    id: String(m.id),
    platform: 'instagram',
    text: m.caption ?? null,
    publishedAt: m.timestamp ?? null,
    permalink: m.permalink ?? null,
    mediaType: m.media_type ? `STORY_${m.media_type}` : 'STORY',
    mediaUrl: m.media_url ?? m.thumbnail_url ?? null,
    likes: null,
    comments: null,
    shares: null,
  }));
}

/** Other people's media that @-tags the connected Instagram account. The
 *  closest thing to a "saved by others" shelf, and the raw material for
 *  engagement work — someone tagging you is a lead you did not have to find. */
export async function listInstagramTagged(
  accountId: string,
  externalId?: string,
  limit = 25,
): Promise<SocialPostSummary[]> {
  const { token, igUserId, externalId: connId } = await getMetaCreds(accountId, {
    provider: 'instagram',
    externalId,
  });
  const target = externalId || igUserId || connId;
  if (!target) throw new Error('No Instagram Business account is connected for this account.');
  const json = await graphGet(
    `${target}/tags`,
    { fields: `${IG_MEDIA_FIELDS},username`, limit: String(limit) },
    token,
  );
  return (json.data || []).map((m: any): SocialPostSummary => ({
    id: String(m.id),
    platform: 'instagram',
    text: m.caption ?? null,
    publishedAt: m.timestamp ?? null,
    permalink: m.permalink ?? null,
    mediaType: m.media_type ?? null,
    mediaUrl: m.media_url ?? m.thumbnail_url ?? null,
    likes: m.like_count ?? null,
    comments: m.comments_count ?? null,
    shares: null,
    ...(m.username ? { taggedBy: m.username } : {}),
  } as SocialPostSummary));
}

/** Platform-dispatching entry points used by the capabilities layer. */
export function listOwnPosts(
  accountId: string,
  platform: 'facebook' | 'instagram',
  externalId?: string,
  limit = 10,
  contentType: SocialContentType = 'posts',
): Promise<SocialPostSummary[]> {
  if (contentType === 'videos') return listVideos(accountId, platform, externalId, limit);
  if (contentType === 'stories') {
    if (platform !== 'instagram') throw new Error('Stories are only available for Instagram accounts.');
    return listInstagramStories(accountId, externalId, limit);
  }
  if (contentType === 'tagged') {
    if (platform !== 'instagram') throw new Error('Tagged media is only available for Instagram accounts.');
    return listInstagramTagged(accountId, externalId, limit);
  }
  return platform === 'instagram'
    ? listInstagramMedia(accountId, externalId, limit)
    : listFacebookPagePosts(accountId, externalId, limit);
}

export function getOwnProfile(
  accountId: string,
  platform: 'facebook' | 'instagram',
  externalId?: string,
): Promise<SocialProfile> {
  return platform === 'instagram'
    ? getInstagramProfile(accountId, externalId)
    : getFacebookPageProfile(accountId, externalId);
}
