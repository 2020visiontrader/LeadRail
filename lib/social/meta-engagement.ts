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

/** Get comments on a post (Facebook post or Instagram media).
 *
 *  `platform` used to be accepted and then ignored when resolving credentials:
 *  getMetaCreds(accountId) with no options tries facebook first, so comments on
 *  an Instagram media id were read with whichever Facebook Page connected most
 *  recently. On an account with one page that is harmless; on one with several
 *  pages and several Instagram accounts — which is the normal case here — it
 *  reads the wrong connection and Meta answers with a permissions error the
 *  user sees as "comments are broken". Pass externalId to pin the exact
 *  connected page/profile. */
export async function getComments(
  accountId: string,
  postId: string,
  platform: 'facebook' | 'instagram',
  limit = 25,
  externalId?: string,
) {
  const { token } = await getMetaCreds(accountId, { provider: platform, externalId });
  const fields = 'from{id,name},message,created_time,like_count,comment_count,hidden,can_hide,can_comment,user_likes';
  const url = `${GRAPH}/${postId}/comments?fields=${fields}&limit=${limit}&access_token=${token}`;
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok) throw new Error(`Meta comments error: ${json?.error?.message || res.statusText}`);
  return json.data || [];
}

/** Reply to a comment. Pass externalId (the specific connected IG/Page id) to
 *  target the right connection when an account has more than one connected —
 *  omit to fall back to the most-recently-connected one. */
export async function replyToComment(
  accountId: string,
  commentId: string,
  message: string,
  platform: 'facebook' | 'instagram',
  externalId?: string,
) {
  const { token } = await getMetaCreds(accountId, { provider: platform, externalId });
  return graphPost(`${commentId}/comments`, { message }, token);
}

/** Delete a comment (only works for comments on the owned page/media). Same
 *  multi-connection caveat as getComments above — pass the platform and, when
 *  several are connected, the external id of the one that owns the media. */
export async function deleteComment(
  accountId: string,
  commentId: string,
  platform?: 'facebook' | 'instagram',
  externalId?: string,
) {
  const { token } = await getMetaCreds(accountId, platform ? { provider: platform, externalId } : undefined);
  const res = await fetch(`${GRAPH}/${commentId}?access_token=${token}`, { method: 'DELETE' });
  const json = await res.json();
  if (!res.ok) throw new Error(`Meta delete error: ${json?.error?.message || res.statusText}`);
  return { deleted: true, commentId };
}

/** Hide/unhide a comment on a Facebook post. Same multi-connection caveat as
 *  getComments above. */
export async function hideComment(
  accountId: string,
  commentId: string,
  hide = true,
  platform?: 'facebook' | 'instagram',
  externalId?: string,
) {
  const { token } = await getMetaCreds(accountId, platform ? { provider: platform, externalId } : undefined);
  return graphPost(commentId, { is_hidden: hide }, token);
}

/** Send an Instagram DM reply via the Send API. Pass externalId (the specific
 *  connected IG business account id) to target the right connection when an
 *  account has more than one connected — omit to fall back to the
 *  most-recently-connected one. */
export async function sendInstagramMessage(accountId: string, recipientId: string, text: string, externalId?: string) {
  const { token } = await getMetaCreds(accountId, { provider: 'instagram', externalId });
  return graphPost('me/messages', { recipient: { id: recipientId }, message: { text } }, token);
}

/** List recent DM conversations for a connected account, newest first.
 *
 *  The `instagram_manage_messages` scope was already granted and
 *  sendInstagramMessage() could already reply — but nothing could READ the
 *  inbox, and a reply needs a recipient id that only a conversation carries. So
 *  the assistant could answer a DM handed to it and never go find one. This
 *  closes that.
 *
 *  Returns the conversation id, the other participant, and the last message, so
 *  the caller has everything needed to reply without a second round-trip. */
export async function listConversations(
  accountId: string,
  platform: 'facebook' | 'instagram',
  limit = 25,
  externalId?: string,
) {
  // Same fix as getComments: resolve against the platform being read, not
  // whichever Meta connection happens to come back first.
  const { token } = await getMetaCreds(accountId, { provider: platform, externalId });
  const fields = 'participants,updated_time,message_count,messages.limit(1){message,from,created_time}';
  const path = platform === 'instagram' ? 'me/conversations?platform=instagram' : 'me/conversations';
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${GRAPH}/${path}${sep}fields=${fields}&limit=${limit}&access_token=${token}`);
  const json = await res.json();
  if (!res.ok) throw new Error(`Meta conversations error: ${json?.error?.message || res.statusText}`);
  return (json.data || []).map((c: any) => {
    const last = c.messages?.data?.[0];
    // The connected account is itself a participant; the OTHER one is who the
    // assistant would be replying to, and whose id sendSocialMessage needs.
    const other = (c.participants?.data || []).find((p: any) => p?.id && p.id !== last?.from?.id) || c.participants?.data?.[0];
    return {
      conversationId: c.id,
      recipientId: other?.id ?? null,
      recipientName: other?.name || other?.username || null,
      updatedTime: c.updated_time ?? null,
      messageCount: c.message_count ?? null,
      lastMessage: last?.message ?? null,
      lastFrom: last?.from?.name || last?.from?.username || null,
    };
  });
}
