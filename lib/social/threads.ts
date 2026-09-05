// Threads publishing + reply management. Mirrors the shape of x-oauth.ts's
// publisher functions: thin fetch wrappers over the Threads Graph API, with
// zero DB/account knowledge — lib/capabilities/social.ts resolves the
// connection and token, and calls these with a plain access token + user id.
//
// Publishing is a two-step container flow (same pattern Instagram uses):
//   1. POST /{userId}/threads         -> creates a media container, returns creation_id
//   2. POST /{userId}/threads_publish -> publishes that container, returns {id}
// A reply is the SAME flow with `reply_to_id` added to step 1 — Threads has no
// separate "reply" endpoint. Verified against Meta's published Threads API
// reference (developers.facebook.com/docs/threads/{posts,reference/reply-management})
// via web search — direct WebFetch to developers.facebook.com is blocked by this
// environment's egress proxy, so this was cross-checked against multiple
// independent third-party implementations (Postman's official Meta-published
// Threads collection, a Ruby client, and an MCP server) rather than the raw
// doc page itself.

const TH_GRAPH = 'https://graph.threads.net/v1.0';

async function threadsPost(path: string, body: Record<string, any>, token: string) {
  const p = new URLSearchParams({ ...body, access_token: token });
  const res = await fetch(`${TH_GRAPH}/${path}?${p.toString()}`, { method: 'POST' });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Threads error (${res.status}): ${json?.error?.message || res.statusText}`);
  return json;
}

async function threadsGet(path: string, params: Record<string, string>, token: string) {
  const p = new URLSearchParams({ ...params, access_token: token });
  const res = await fetch(`${TH_GRAPH}/${path}?${p.toString()}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Threads error (${res.status}): ${json?.error?.message || res.statusText}`);
  return json;
}

export interface ThreadsPost {
  text?: string;
  imageUrl?: string;
  videoUrl?: string;
  /** Set to reply to an existing Threads post or reply instead of starting a new thread. */
  replyToId?: string;
}

/** Create a media container, then publish it. Returns the publish edge's
 *  `{id}` — the id of the live Threads post/reply. */
export async function publishThreadsPost(token: string, userId: string, post: ThreadsPost) {
  const mediaType = post.videoUrl ? 'VIDEO' : post.imageUrl ? 'IMAGE' : 'TEXT';
  const containerBody: Record<string, any> = { media_type: mediaType };
  if (post.text) containerBody.text = post.text;
  if (post.imageUrl) containerBody.image_url = post.imageUrl;
  if (post.videoUrl) containerBody.video_url = post.videoUrl;
  if (post.replyToId) containerBody.reply_to_id = post.replyToId;

  const container = await threadsPost(`${userId}/threads`, containerBody, token);
  if (!container?.id) throw new Error('Threads container creation returned no creation_id.');

  return threadsPost(`${userId}/threads_publish`, { creation_id: container.id }, token);
}

/** Reply to a Threads post or reply — same publish flow, with reply_to_id set. */
export function replyToThreadsPost(token: string, userId: string, replyToId: string, text: string) {
  return publishThreadsPost(token, userId, { text, replyToId });
}

/** List replies to a Threads post (or a reply, for nested threads). */
export async function listThreadsReplies(token: string, threadId: string, limit = 25) {
  const fields = 'id,text,username,permalink,timestamp,media_type,has_replies,root_post,replied_to,is_reply,hide_status';
  const json = await threadsGet(`${threadId}/replies`, { fields, limit: String(limit) }, token);
  return json.data || [];
}

/**
 * A just-published Threads post/reply's own permalink. Same shape as the
 * Meta (Facebook/Instagram) follow-up reads in lib/social/meta-read.ts: the
 * publish response (threads_publish edge) carries only the media's internal
 * id, and `permalink` is a separate field only a follow-up GET returns.
 * Verified via web search of third-party Threads API docs/clients — same
 * corroboration approach documented at the top of this file — and it matches
 * the `permalink` field this file already requests in listThreadsReplies
 * above, which has been live against real Threads accounts.
 */
export async function getThreadsMediaPermalink(token: string, mediaId: string): Promise<string | null> {
  const json = await threadsGet(String(mediaId), { fields: 'permalink' }, token);
  return json?.permalink ?? null;
}

/** Hide/unhide a reply. POST /{reply-id}/manage_reply {hide: boolean} — Meta's
 *  Reply Management edge. Threads has no delete endpoint in the public API, so
 *  there is deliberately no deleteThreadsReply here — see the honest error
 *  thrown in lib/capabilities/social.ts instead of pretending this exists. */
export async function hideThreadsReply(token: string, replyId: string, hide = true) {
  return threadsPost(`${replyId}/manage_reply`, { hide: String(hide) }, token);
}
