// Social platform registry — single source of truth for the client Connections UI
// AND backend routing. Multi-account by design: a user may connect several
// accounts per platform (e.g. 6 Instagram accounts). Platforms marked live:false
// are scaffolded in the backend now; their OAuth + UI ship later (future reference).

export type SocialKey = 'facebook' | 'instagram' | 'threads' | 'linkedin' | 'tiktok' | 'x';

export interface SocialProvider {
  key: SocialKey;
  label: string;
  desc: string;
  brand: string; // accent colour for the card badge
  live: boolean; // false = backend scaffolded, UI/integration later
  connectPath?: string; // OAuth start route (present when live)
  multi: boolean; // supports multiple connected accounts
}

export const SOCIAL_PROVIDERS: SocialProvider[] = [
  { key: 'facebook',  label: 'Facebook',    desc: 'Connect Facebook Pages to publish and manage posts',            brand: '#1877F2', live: true,  connectPath: '/api/social/meta/connect',      multi: true },
  { key: 'instagram', label: 'Instagram',   desc: 'Connect Instagram Business accounts — add as many as you manage', brand: '#E4405F', live: true,  connectPath: '/api/social/instagram/connect', multi: true },
  { key: 'threads',   label: 'Threads',     desc: 'Post and reply on Threads',                                     brand: '#111111', live: true,  connectPath: '/api/social/threads/connect', multi: true },
  { key: 'linkedin',  label: 'LinkedIn',    desc: 'Publish to your profile or company pages',                      brand: '#0A66C2', live: false, multi: true },
  { key: 'tiktok',    label: 'TikTok',      desc: 'Publish video content and read analytics',                      brand: '#111111', live: false, multi: true },
  { key: 'x',         label: 'X (Twitter)', desc: 'Post and engage on X',                                          brand: '#111111', live: false, multi: true },
];

export const LIVE_SOCIALS = SOCIAL_PROVIDERS.filter((p) => p.live);
export const SOCIAL_KEYS = SOCIAL_PROVIDERS.map((p) => p.key);
