import { withRetry } from '@/lib/integrations/retry';
import { getConnections } from '@/lib/db';

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
}

/**
 * Resolve Meta credentials for an account: prefer the account-scoped token
 * stored in integration_connections (meta.access_token / meta.ig_user_id),
 * fall back to the process-level env token for the demo/owner account.
 */
export async function getMetaCreds(accountId?: string): Promise<MetaCreds> {
  if (accountId) {
    try {
      const conns = await getConnections(accountId);
      const metaConn = conns.find((c) => c.provider === 'meta' && c.status === 'connected');
      const token = metaConn?.meta?.access_token;
      if (token) {
        return {
          token: String(token),
          igUserId: metaConn?.meta?.ig_user_id ? String(metaConn.meta.ig_user_id) : undefined,
          pageId: metaConn?.meta?.page_id ? String(metaConn.meta.page_id) : undefined,
        };
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

/** Account-aware publish: resolves the stored token + IG user id from the DB. */
export async function publishToInstagramForAccount(accountId: string, post: MetaPost) {
  const { token, igUserId } = await getMetaCreds(accountId);
  if (!igUserId) {
    throw new Error('No Instagram Business account linked — reconnect Meta in Settings so we can resolve your ig_user_id');
  }
  return postToInstagram(igUserId, post, token);
}

export interface FacebookPagePost {
  message: string;
  link?: string;
  imageUrl?: string;
}

/** Publish to a Facebook Page using the account-scoped Page token + page_id from the DB. */
export async function publishToFacebookPage(accountId: string, post: FacebookPagePost) {
  const { token, pageId } = await getMetaCreds(accountId);
  if (!pageId) {
    throw new Error('No Facebook Page linked — connect Facebook in Settings so we can resolve your page_id');
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
  if (object === 'instagram' && Array.isArray(entry)) {
    for (const item of entry) {
      if (item.messaging) console.log('Instagram message:', item.messaging);
      if (item.changes) console.log('Instagram change:', item.changes);
    }
  }
}
