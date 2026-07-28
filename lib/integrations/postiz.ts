import { withRetry } from '@/lib/integrations/retry';

const POSTIZ_API_URL = 'https://api.postiz.io/v1';
const POSTIZ_API_KEY = process.env.POSTIZ_API_KEY;

export type Platform = 'instagram' | 'tiktok' | 'linkedin' | 'twitter' | 'facebook' | 'threads' | 'reddit' | 'youtube';

export interface PostizPost {
  content: string;
  platforms: Platform[];
  mediaUrl?: string;
  scheduledAt?: Date;
  hashtags?: string[];
}

export async function schedulePostizPost(post: PostizPost) {
  if (!POSTIZ_API_KEY) throw new Error('POSTIZ_API_KEY not set');
  return withRetry(() =>
    fetch(`${POSTIZ_API_URL}/posts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${POSTIZ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: post.content,
        platforms: post.platforms,
        media: post.mediaUrl ? [{ url: post.mediaUrl }] : undefined,
        publishAt: post.scheduledAt?.toISOString(),
        tags: post.hashtags,
      }),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`Postiz error: ${r.status} ${r.statusText}`);
      return r.json();
    })
  );
}

export async function getPostizMetrics(postId: string) {
  if (!POSTIZ_API_KEY) throw new Error('POSTIZ_API_KEY not set');
  const response = await fetch(`${POSTIZ_API_URL}/posts/${postId}/analytics`, {
    headers: { Authorization: `Bearer ${POSTIZ_API_KEY}` },
  });
  if (!response.ok) throw new Error('Failed to fetch Postiz metrics');
  return response.json();
}

export async function handlePostizWebhook(event: any) {
  const { postId, event: eventType, data } = event;
  if (eventType === 'published') console.log(`Post ${postId} published to ${data?.platforms?.join(', ')}`);
  if (eventType === 'analytics') console.log(`Post ${postId} analytics:`, data?.metrics);
}
