# Marketing Agency OS

Multi-tenant CRM + Email Outreach + Social Content + Campaign Management platform for marketing agencies.

## Features

- **Lead Management**: Import, segment, score, and manage contacts
- **Email Outreach**: Template-based campaigns with Brevo integration
- **Social Content**: Multi-platform scheduling with Postiz
- **Ad Campaigns**: Budget tracking and ROAS/CTR metrics
- **Automation**: Hermes Agent for autonomous sequences
- **Responsive Design**: Mobile-first UI with Tailwind CSS

## Tech Stack

- **Frontend**: Next.js 14, React 18, TypeScript, Tailwind CSS
- **Backend**: Next.js API routes, Supabase PostgreSQL
- **Integrations**: Brevo (email), Postiz (social), Meta (optional)
- **Testing**: Playwright E2E
- **Deployment**: Vercel

## Getting Started

### Prerequisites
- Node.js 18+
- npm or yarn
- Supabase account
- Brevo API key (optional)
- Postiz API key (optional)

### Installation

```bash
git clone https://github.com/2020visiontrader/marketing-agency-os.git
cd marketing-agency-os
npm install
```

### Environment Setup

Copy `.env.local.example` to `.env.local` and fill in your keys:

```bash
cp .env.local.example .env.local
```

Required:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

Optional:
- `BREVO_API_KEY` (for email sending)
- `POSTIZ_API_KEY` (for social scheduling)
- `META_ACCESS_TOKEN` (for Facebook/Instagram)

### Development

```bash
npm run dev
# Open http://localhost:3000
```

### Testing

Run Playwright E2E tests:

```bash
npx playwright test
# View results:
npx playwright show-report
```

### Production Build

```bash
npm run build
npm run start
```

## API Reference

### Leads
- `GET /api/leads?brandId=X&page=0&limit=30` - List contacts
- `POST /api/leads` - Create contact
- `PATCH /api/leads/:id` - Update contact
- `DELETE /api/leads/:id` - Delete contact

### Outreach
- `GET /api/outreach/campaigns` - List campaigns
- `POST /api/outreach/send` - Send email via Brevo
- `GET /api/outreach/templates` - Get 90 email templates

### Content
- `GET /api/content/calendar` - List scheduled posts
- `POST /api/content/calendar` - Schedule post
- `POST /api/content/upload-media` - Upload image/video

### Campaigns
- `GET /api/campaigns` - List ad campaigns
- `POST /api/campaigns` - Create campaign
- `GET /api/campaigns/:id/performance` - Campaign metrics

### Integrations
- `GET /api/integrations/status` - Check connection status
- `POST /api/integrations/:service/webhook` - Webhook handlers

## Deployment

### Deploy to Vercel

```bash
# Link your repo to Vercel
vercel link

# Set environment variables
vercel env add NEXT_PUBLIC_SUPABASE_URL
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY
# ... add other keys

# Deploy
vercel deploy --prod
```

## Hermes Automation

Autonomous email sequences triggered by conditions:

```typescript
import { createSequence, executeSequence } from '@/lib/hermes/agent';

// Create a sequence
await createSequence({
  brandId: 'rentahub',
  name: 'VIP Onboarding',
  trigger: 'high_score', // Triggers when contact score >= 80
  steps: [
    { order: 1, action: 'send_email', config: { templateId: 1, subject: 'Welcome!' } },
    { order: 2, action: 'add_tag', config: { tag: 'vip' }, delay: 2 },
    { order: 3, action: 'update_score', config: { scoreIncrease: 10 }, delay: 7 },
  ],
  isActive: true,
});

// Execute manually or on trigger
await executeSequence(sequenceId, contactId);
```

## Architecture

```
/app
  /api                 # API routes (leads, outreach, content, campaigns, integrations)
  /leads               # Lead dashboard page
  /outreach            # Email campaigns page
  /content             # Social content calendar page
  /campaigns           # Ad campaigns page
  /settings            # Integration settings page

/src
  /components          # Reusable React components (DataTable, Modal, Drawer, etc.)
  /lib
    /hermes            # Automation agent
    /integrations      # Brevo, Postiz, Meta connectors
    db.ts              # Supabase helpers
    types.ts           # TypeScript interfaces

/tests
  /e2e                 # Playwright E2E tests

/migrations            # Supabase SQL migrations
```

## Next Steps

### Sprint 5: Integration & MCP Wiring
- Connect API keys securely
- Set up MCP servers for Brevo, Postiz, Meta
- Test production workflows
- Monitor performance metrics

## Contributing

1. Create a feature branch
2. Make changes
3. Run tests: `npm test`
4. Create PR to main

## License

MIT

## Support

For issues, open a GitHub issue or contact: hello@marketingagency.os
