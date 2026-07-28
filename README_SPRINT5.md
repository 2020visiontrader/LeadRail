# Sprint 5: MCP Integration Guide

## Integration Status

Check which integrations are connected:

```bash
curl http://localhost:3000/api/integrations/status
```

Response:
```json
{
  "timestamp": "2026-07-28T07:45:00Z",
  "integrations": {
    "supabase": true,
    "brevo": true,
    "postiz": true,
    "meta": false,
    "nim": false
  },
  "ready": true
}
```

## Setup Instructions

### 1. Brevo Email Integration

```bash
# 1. Get API key from https://www.brevo.com/
# 2. Set environment variable
export BREVO_API_KEY="your_brevo_api_key"

# 3. Test connection
curl -H "api-key: your_brevo_api_key" https://api.brevo.com/v3/account
```

Usage in code:
```typescript
import { sendBrevoEmail } from '@/lib/integrations/brevo';

await sendBrevoEmail({
  to: [{ email: 'contact@example.com' }],
  subject: 'Hello',
  htmlContent: '<p>Welcome!</p>',
  sender: { name: 'Your Brand', email: 'hello@yoursite.com' },
});
```

### 2. Postiz Social Integration

```bash
# 1. Get API key from https://postiz.com/
# 2. Set environment variable
export POSTIZ_API_KEY="your_postiz_api_key"

# 3. Connect platforms (Instagram, TikTok, LinkedIn, Twitter, etc.)
# Done via Postiz dashboard
```

Usage in code:
```typescript
import { schedulePostizPost } from '@/lib/integrations/postiz';

await schedulePostizPost({
  content: 'Check this out!',
  platforms: ['instagram', 'linkedin', 'twitter'],
  mediaUrl: 'https://example.com/image.jpg',
  scheduledAt: new Date(Date.now() + 3600000),
  hashtags: ['#marketing', '#socialmedia'],
});
```

### 3. Meta (Facebook/Instagram) Integration

```bash
# 1. Create Facebook App at https://developers.facebook.com/
# 2. Get Instagram Business Account connected
# 3. Generate access token with these permissions:
#    - instagram_basic
#    - instagram_content_publish
#    - pages_read_engagement
# 4. Set environment variable
export META_ACCESS_TOKEN="your_meta_access_token"
```

Usage in code:
```typescript
import { postToInstagram } from '@/lib/integrations/meta';

await postToInstagram('YOUR_PAGE_ID', {
  caption: 'New product launch!',
  imageUrl: 'https://example.com/product.jpg',
});
```

## Error Handling & Retry Logic

All integrations support automatic retry with exponential backoff:

```typescript
import { withRetry } from '@/lib/integrations/retry';

const result = await withRetry(
  () => sendBrevoEmail(emailData),
  { maxAttempts: 3, delayMs: 1000, backoff: true }
);
```

Fallback pattern:
```typescript
import { withFallback } from '@/lib/integrations/retry';

const result = await withFallback(
  () => schedulePostizPost(post),
  () => fallbackEmailNotification(post),
  () => console.log('Using fallback channel')
);
```

## Webhook Handlers

### Brevo Webhooks
Set webhook URL in Brevo dashboard:
```
https://yourdomain.com/api/integrations/brevo/webhook
```

Handles:
- `opened` — Email opened
- `click` — Link clicked
- `bounce` — Email bounced
- `complaint` — Spam complaint

### Postiz Webhooks
Set webhook URL in Postiz dashboard:
```
https://yourdomain.com/api/integrations/postiz/webhook
```

Handles:
- `published` — Post went live
- `analytics` — Engagement metrics updated

### Meta Webhooks
Set webhook URL in Meta App Settings:
```
https://yourdomain.com/api/integrations/meta/webhook
```

Handles:
- `messaging` — Direct messages
- `comments` — Comment engagement
- `likes` — Like notifications

## Testing

Run the full E2E workflow test:

```bash
npx playwright test tests/e2e/workflow.spec.ts
```

This test validates:
1. Create a new lead in CRM
2. Send email via Brevo to that lead
3. Schedule social post via Postiz
4. Verify both actions completed successfully

## Production Checklist

Before deploying to production:

- [ ] All API keys set in environment
- [ ] Webhooks configured in each provider
- [ ] E2E tests passing (`npm run test:e2e`)
- [ ] Integration status endpoint returning all `true`
- [ ] Rate limits configured (100 req/min recommended)
- [ ] Error logging to monitoring service
- [ ] Fallback channels configured
- [ ] Load test completed (1000+ concurrent requests)

## Next Steps (Sprint 6+)

- Advanced scheduling (recurring sequences)
- AI-powered copy generation per platform
- A/B testing framework
- Advanced analytics dashboard
- Custom webhook routing
- Rate limiting & queue management
