const META_API_URL = 'https://graph.instagram.com/v18.0';
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;

export interface MetaPost {
  caption: string;
  imageUrl?: string;
  videoUrl?: string;
}

export async function postToInstagram(pageId: string, post: MetaPost) {
  if (!META_ACCESS_TOKEN) throw new Error('META_ACCESS_TOKEN not set');

  // Step 1: Create media object
  const mediaResponse = await fetch(`${META_API_URL}/${pageId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_url: post.imageUrl,
      video_url: post.videoUrl,
      caption: post.caption,
      access_token: META_ACCESS_TOKEN,
    }),
  });

  if (!mediaResponse.ok) {
    throw new Error(`Meta media error: ${mediaResponse.statusText}`);
  }

  const media = await mediaResponse.json();

  // Step 2: Publish media
  const publishResponse = await fetch(`${META_API_URL}/${pageId}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      creation_id: media.id,
      access_token: META_ACCESS_TOKEN,
    }),
  });

  if (!publishResponse.ok) {
    throw new Error(`Meta publish error: ${publishResponse.statusText}`);
  }

  return publishResponse.json();
}

export async function getInstagramInsights(mediaId: string) {
  if (!META_ACCESS_TOKEN) throw new Error('META_ACCESS_TOKEN not set');

  const response = await fetch(
    `${META_API_URL}/${mediaId}/insights?metric=engagement,impressions,reach&access_token=${META_ACCESS_TOKEN}`
  );

  if (!response.ok) throw new Error('Failed to fetch Meta insights');
  return response.json();
}

export async function handleMetaWebhook(event: any) {
  const { object, entry } = event;

  if (object === 'instagram') {
    for (const item of entry) {
      if (item.messaging) {
        // Handle direct messages, comments, etc.
        console.log('Instagram message:', item.messaging);
      }
    }
  }
}