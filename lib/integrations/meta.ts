import { withRetry } from '@/lib/integrations/retry';

// Instagram Content Publishing runs on the Facebook Graph host, NOT graph.instagram.com.
const META_API_URL = 'https://graph.facebook.com/v18.0';
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;

export interface MetaPost {
  caption: string;
  imageUrl?: string;
  videoUrl?: string;
}

async function graph(path: string, body: Record<string, any>) {
  const res = await fetch(`${META_API_URL}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: META_ACCESS_TOKEN }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Meta error (${res.status}): ${json?.error?.message || res.statusText}`);
  return json;
}

async function waitForContainer(containerId: string, attempts = 10, delayMs = 3000) {
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(
      `${META_API_URL}/${containerId}?fields=status_code&access_token=${META_ACCESS_TOKEN}`
    );
    const json = await res.json();
    if (json.status_code === 'FINISHED') return;
    if (json.status_code === 'ERROR') throw new Error('Meta media processing failed');
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error('Meta media processing timed out');
}

/** Publish an image or reel to an Instagram Business account (igUserId). */
export async function postToInstagram(igUserId: string, post: MetaPost) {
  if (!META_ACCESS_TOKEN) throw new Error('META_ACCESS_TOKEN not set');

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

  const media = await withRetry(() => graph(`${igUserId}/media`, createBody));
  if (isVideo) await waitForContainer(media.id);

  return withRetry(() => graph(`${igUserId}/media_publish`, { creation_id: media.id }));
}

export async function getInstagramInsights(mediaId: string) {
  if (!META_ACCESS_TOKEN) throw new Error('META_ACCESS_TOKEN not set');
  const response = await fetch(
    `${META_API_URL}/${mediaId}/insights?metric=engagement,impressions,reach&access_token=${META_ACCESS_TOKEN}`
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
