import { withRetry } from '@/lib/integrations/retry';

const POSTIZ_API_URL = 'https://api.postiz.com/public/v1';
let _POSTIZ_API_KEY = process.env.POSTIZ_API_KEY;

import { getConnections } from '@/lib/db';
import { resolveTokensForRow } from '@/lib/social/connection-token';

async function getPostizApiKey(accountId?: string): Promise<string> {
  if (accountId) {
    const conns = await getConnections(accountId);
    const postizConn = conns.find(c => c.provider === 'postiz' && c.status === 'connected');
    if (postizConn) {
      const { accessToken } = await resolveTokensForRow(postizConn);
      if (accessToken) return accessToken;
    }
  }
  if (!_POSTIZ_API_KEY) throw new Error('POSTIZ_API_KEY not set — connect Postiz in Settings → Integrations');
  return _POSTIZ_API_KEY;
}

export type Platform = 'instagram' | 'tiktok' | 'linkedin' | 'twitter' | 'facebook' | 'threads' | 'reddit' | 'youtube';

export interface PostizPost {
  content: string;
  platforms: Platform[];
  mediaUrl?: string;
  scheduledAt?: Date;
  hashtags?: string[];
}

export async function schedulePostizPost(post: PostizPost, accountId?: string) {
  const apiKey = await getPostizApiKey(accountId);
  return withRetry(() =>
    fetch(`${POSTIZ_API_URL}/posts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
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

export async function getPostizMetrics(postId: string, accountId?: string) {
  const apiKey = await getPostizApiKey(accountId);
  const response = await fetch(`${POSTIZ_API_URL}/posts/${postId}/analytics`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) throw new Error('Failed to fetch Postiz metrics');
  return response.json();
}

export async function handlePostizWebhook(event: any) {
  const { postId, event: eventType, data } = event;
  if (eventType === 'published') console.log(`Post ${postId} published to ${data?.platforms?.join(', ')}`);
  if (eventType === 'analytics') console.log(`Post ${postId} analytics:`, data?.metrics);
}
