// Meta (Facebook + Instagram) engagement — comments, replies, delete, hide.
// Uses account-scoped tokens from integration_connections (same as meta.ts publish).

import { getMetaCreds } from '@/lib/integrations/meta';

const GRAPH = 'https://graph.facebook.com/v18.0';

async function graphGet(path: string, token: string) {
  const res = await fetch(`${GRAPH}/${path}?access_token=${token}`);
  const json = await res.json();
  if (!res.ok) throw new Error(`Meta error (${res.status}): ${json?.error?.message || res.statusText}`);
  return json;
}

async function graphPost(path: string, body: Record<string, any>, token: string) {
  const res = await fetch(`${GRAPH}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: token }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Meta error (${res.status}): ${json?.error?.message || res.statusText}`);
  return json;
}

/** Get comments on a post (Facebook post or Instagram media). */
export async function getComments(
  accountId: string,
  postId: string,
  platform: 'facebook' | 'instagram',
  limit = 25,
) {
  const { token } = await getMetaCreds(accountId);
  const fields = 'from{id,name},message,created_time,like_count,comment_count,hidden,can_hide,can_comment,user_likes';
  const url = `${GRAPH}/${postId}/comments?fields=${fields}&limit=${limit}&access_token=${token}`;
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok) throw new Error(`Meta comments error: ${json?.error?.message || res.statusText}`);
  return json.data || [];
}

/** Reply to a comment. */
export async function replyToComment(
  accountId: string,
  commentId: string,
  message: string,
  platform: 'facebook' | 'instagram',
) {
  const { token } = await getMetaCreds(accountId);
  return graphPost(`${commentId}/comments`, { message }, token);
}

/** Delete a comment (only works for comments on the owned page/media). */
export async function deleteComment(accountId: string, commentId: string) {
  const { token } = await getMetaCreds(accountId);
  const res = await fetch(`${GRAPH}/${commentId}?access_token=${token}`, { method: 'DELETE' });
  const json = await res.json();
  if (!res.ok) throw new Error(`Meta delete error: ${json?.error?.message || res.statusText}`);
  return { deleted: true, commentId };
}

/** Hide/unhide a comment on a Facebook post. */
export async function hideComment(accountId: string, commentId: string, hide = true) {
  const { token } = await getMetaCreds(accountId);
  return graphPost(commentId, { is_hidden: hide }, token);
}
