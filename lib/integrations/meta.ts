import { withRetry } from '@/lib/integrations/retry';
import { getConnection, getConnectionByExternalId } from '@/lib/db';
import { recordConversationMessage } from '@/lib/conversations';
// Packet 7.3 — fires social_automations rules for inbound events. Dynamic
// dependency shape: this IS a static import (safe — automation-runner.ts
// only reaches back into meta-engagement.ts via a dynamic import at call
// time, never statically, so there is no import cycle back to this file).
import { runSocialAutomationsForEvent } from '@/lib/social/automation-runner';

// Instagram Content Publishing runs on the Facebook Graph host, NOT graph.instagram.com.
const META_API_URL = 'https://graph.facebook.com/v18.0';
const ENV_META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;

export interface MetaPost {
  caption: string;
  imageUrl?: string;
  videoUrl?: string;
}

export interface MetaCreds {
  token: string;
  igUserId?: string;
  pageId?: string;
  externalId?: string;
  displayName?: string;
}

/**
 * Resolve Meta credentials for an account. Multi-account aware: pass
 * opts.externalId to target a specific Page/IG when the user has several, and
 * opts.provider to pick the platform ('facebook' → page_id, 'instagram' → ig_user_id).
 * Falls back to the process-level env token for the demo/owner account.
 */
export async function getMetaCreds(
  accountId?: string,
  opts?: { externalId?: string; provider?: 'facebook' | 'instagram' }
): Promise<MetaCreds> {
  if (accountId) {
    try {
      const candidates = opts?.provider ? [opts.provider] : (['facebook', 'instagram', 'meta'] as const);
      for (const prov of candidates) {
        const conn = await getConnection(accountId, prov, opts?.externalId);
        const token = conn?.meta?.access_token;
        if (token) {
          return {
            token: String(token),
            igUserId: conn.meta?.ig_user_id ? String(conn.meta.ig_user_id) : undefined,
            pageId: conn.meta?.page_id ? String(conn.meta.page_id) : undefined,
            externalId: conn.external_id ? String(conn.external_id) : undefined,
            displayName: conn.display_name ? String(conn.display_name) : undefined,
          };
        }
      }
    } catch {
      // fall through to env
    }
  }
  if (!ENV_META_ACCESS_TOKEN) throw new Error('META_ACCESS_TOKEN not set — connect Meta in Settings → Integrations');
  return { token: ENV_META_ACCESS_TOKEN };
}

async function graph(path: string, body: Record<string, any>, token: string) {
  const res = await fetch(`${META_API_URL}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: token }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Meta error (${res.status}): ${json?.error?.message || res.statusText}`);
  return json;
}

async function waitForContainer(containerId: string, token: string, attempts = 10, delayMs = 3000) {
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(
      `${META_API_URL}/${containerId}?fields=status_code&access_token=${token}`
    );
    const json = await res.json();
    if (json.status_code === 'FINISHED') return;
    if (json.status_code === 'ERROR') throw new Error('Meta media processing failed');
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error('Meta media processing timed out');
}

/** Publish an image or reel to an Instagram Business account (igUserId), using an explicit token. */
export async function postToInstagram(igUserId: string, post: MetaPost, token?: string) {
  const accessToken = token || ENV_META_ACCESS_TOKEN;
  if (!accessToken) throw new Error('META_ACCESS_TOKEN not set');

  const createBody: Record<string, any> = { caption: post.caption };
  let isVideo = false;
  if (post.videoUrl) {
    createBody.media_type = 'REELS';
    createBody.video_url = post.videoUrl;
    isVideo = true;
  } else if (post.imageUrl) {
    createBody.image_url = post.imageUrl;
  } else {
    throw new Error('postToInstagram requires imageUrl or videoUrl');
  }

  const media = await withRetry(() => graph(`${igUserId}/media`, createBody, accessToken));
  if (isVideo) await waitForContainer(media.id, accessToken);

  return withRetry(() => graph(`${igUserId}/media_publish`, { creation_id: media.id }, accessToken));
}

/** Account-aware publish. Pass externalId (ig_user_id) to target a specific IG account. */
export async function publishToInstagramForAccount(accountId: string, post: MetaPost, externalId?: string) {
  const { token, igUserId } = await getMetaCreds(accountId, { provider: 'instagram', externalId });
  if (!igUserId) {
    throw new Error('No Instagram Business account connected — connect Instagram in Settings first');
  }
  return postToInstagram(igUserId, post, token);
}

export interface FacebookPagePost {
  message: string;
  link?: string;
  imageUrl?: string;
}

/** Publish to a Facebook Page. Pass externalId (page_id) to target a specific Page. */
export async function publishToFacebookPage(accountId: string, post: FacebookPagePost, externalId?: string) {
  const { token, pageId } = await getMetaCreds(accountId, { provider: 'facebook', externalId });
  if (!pageId) {
    throw new Error('No Facebook Page connected — connect Facebook in Settings first');
  }
  if (post.imageUrl) {
    return withRetry(() =>
      graph(`${pageId}/photos`, { url: post.imageUrl, caption: post.message }, token)
    );
  }
  const body: Record<string, any> = { message: post.message };
  if (post.link) body.link = post.link;
  return withRetry(() => graph(`${pageId}/feed`, body, token));
}

export async function getInstagramInsights(mediaId: string, token?: string) {
  const accessToken = token || ENV_META_ACCESS_TOKEN;
  if (!accessToken) throw new Error('META_ACCESS_TOKEN not set');
  const response = await fetch(
    `${META_API_URL}/${mediaId}/insights?metric=engagement,impressions,reach&access_token=${accessToken}`
  );
  const json = await response.json();
  if (!response.ok) throw new Error(`Failed to fetch Meta insights: ${json?.error?.message || response.statusText}`);
  return json;
}

export async function handleMetaWebhook(event: any) {
  const { object, entry } = event;
  if (object !== 'instagram' || !Array.isArray(entry)) return;

  for (const item of entry) {
    const connection = await getConnectionByExternalId('instagram', item.id).catch((e) => {
      console.warn('handleMetaWebhook: connection lookup failed', e);
      return null;
    });
    if (!connection) {
      console.warn('handleMetaWebhook: no connected LeadRail account for IG id', item.id);
      continue;
    }
    const accountId = connection.account_id;

    if (Array.isArray(item.messaging)) {
      for (const messaging of item.messaging) {
        if (messaging?.message?.is_echo) continue; // our own outbound send, not new inbound content
        const dmExternalId = messaging?.message?.mid || `${item.id}:${messaging?.timestamp}`;
        try {
          await recordConversationMessage({
            accountId,
            channel: 'instagram',
            direction: 'inbound',
            externalId: dmExternalId,
            fromAddr: messaging?.sender?.id ?? null,
            toAddr: messaging?.recipient?.id ?? null,
            body: messaging?.message?.text ?? null,
            threadKey: `ig:${messaging?.sender?.id}`,
            meta: { raw: messaging, igAccountId: item.id },
          });
        } catch (e) {
          console.warn('handleMetaWebhook: failed to record IG message', e);
        }
        // Packet 7.3: fire any enabled dm_received rules for this account.
        // Awaited (not fire-and-forget) so a serverless invocation cannot be
        // torn down before the send/cap/audit sequence completes; the runner
        // itself never throws, so this can't fail the webhook response.
        if (messaging?.sender?.id && messaging?.message?.text) {
          await runSocialAutomationsForEvent(accountId, {
            platform: 'instagram',
            trigger: 'dm_received',
            externalId: String(item.id),
            externalEventId: String(dmExternalId),
            authorId: String(messaging.sender.id),
            authorUsername: null,
            text: String(messaging.message.text),
          }).catch((e) => console.warn('handleMetaWebhook: automation runner failed for DM', e));
        }
      }
    }

    if (Array.isArray(item.changes)) {
      for (const change of item.changes) {
        if (change?.field !== 'comments') continue;
        try {
          await recordConversationMessage({
            accountId,
            channel: 'instagram',
            direction: 'inbound',
            externalId: change.value?.id ?? null,
            fromAddr: change.value?.from?.username ?? change.value?.from?.id ?? null,
            body: change.value?.text ?? null,
            threadKey: `ig-comment:${change.value?.media?.id ?? change.value?.id}`,
            meta: { raw: change, kind: 'comment', igAccountId: item.id },
          });
        } catch (e) {
          console.warn('handleMetaWebhook: failed to record IG comment', e);
        }
        // Packet 7.3: fire any enabled comment_received rules for this account.
        if (change.value?.id && change.value?.from?.id) {
          await runSocialAutomationsForEvent(accountId, {
            platform: 'instagram',
            trigger: 'comment_received',
            externalId: String(item.id),
            externalEventId: String(change.value.id),
            authorId: String(change.value.from.id),
            authorUsername: change.value.from.username ?? null,
            text: String(change.value?.text || ''),
          }).catch((e) => console.warn('handleMetaWebhook: automation runner failed for comment', e));
        }
      }
    }
  }
}
