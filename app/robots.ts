import type { MetadataRoute } from 'next';

// robots.txt (Packet 11.2).
//
// Allow the four public pages; disallow the authenticated application surface
// and every API route. Those paths are gated by middleware.ts and would only
// serve a crawler a redirect to /login, so there is nothing there to index.
//
// This is a crawl directive, not an access control. The auth boundary is
// middleware.ts; nothing here is load-bearing for security.

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || 'https://app.leadrail.xyz').replace(/\/$/, '');

// Every authenticated top-level route in app/. Kept explicit rather than
// "Disallow: /" + allow-list, so adding a public page later cannot silently
// de-index it.
const PRIVATE_PATHS = [
  '/api/',
  '/activities',
  '/admin',
  '/analytics',
  '/assistant',
  '/campaigns',
  '/companies',
  '/content',
  '/conversations',
  '/deals',
  '/enrichment',
  '/forms',
  '/inbox',
  '/journeys',
  '/leads',
  '/login',
  '/logs',
  '/outreach',
  '/pipeline',
  '/r/',
  '/referrals',
  '/segments',
  '/sequences',
  '/settings',
  '/templates',
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/welcome', '/privacy', '/terms', '/data-deletion', '/llms.txt'],
        disallow: PRIVATE_PATHS,
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
