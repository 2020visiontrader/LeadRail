import type { MetadataRoute } from 'next';

// Sitemap for the PUBLIC surface only (Packet 11.2).
//
// The authenticated app — dashboard, leads, campaigns, settings, everything
// behind middleware.ts — is deliberately absent. Those URLs redirect a crawler
// to /login, so listing them would advertise a wall of dead ends. Keep this
// list to pages a logged-out visitor can actually read.

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || 'https://app.leadrail.xyz').replace(/\/$/, '');

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return [
    { url: `${SITE_URL}/welcome`, lastModified, changeFrequency: 'monthly', priority: 1 },
    { url: `${SITE_URL}/privacy`, lastModified, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${SITE_URL}/terms`, lastModified, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${SITE_URL}/data-deletion`, lastModified, changeFrequency: 'yearly', priority: 0.3 },
  ];
}
