// Social platform registry — single source of truth for the client Connections UI
// AND backend routing. Multi-account by design: a user may connect several
// accounts per platform (e.g. 6 Instagram accounts). A new platform is added
// scaffolded (live:false) until its OAuth + PUBLISHERS entry (see
// lib/capabilities/social.ts) actually ship — flip live:true only then.

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
  { key: 'linkedin',  label: 'LinkedIn',    desc: 'Publish to your profile or company pages',                      brand: '#0A66C2', live: true,  connectPath: '/api/social/linkedin/connect', multi: true },
  { key: 'tiktok',    label: 'TikTok',      desc: 'Push video drafts to your TikTok inbox for review and posting', brand: '#111111', live: true,  connectPath: '/api/social/tiktok/connect',   multi: true },
  { key: 'x',         label: 'X (Twitter)', desc: 'Post and engage on X (requires a paid X API tier)',             brand: '#111111', live: true,  connectPath: '/api/social/x/connect',        multi: true },
];

export const LIVE_SOCIALS = SOCIAL_PROVIDERS.filter((p) => p.live);
export const SOCIAL_KEYS = SOCIAL_PROVIDERS.map((p) => p.key);

// Token-based providers — Buffer and GoHighLevel (Packet 7.2's backend, minus
// the entry point until this registry). Unlike SOCIAL_PROVIDERS above these
// aren't OAuth destinations: the user pastes one long-lived token (see the
// Notion flow this is modeled on), it's validated server-side by
// app/api/integrations/validate/route.ts, and it's stored through
// lib/social/credentials.ts's encrypted vault column rather than `meta`.
//
// `key` is typed as TokenProvider — the same union storeSocialCredential and
// the validate route's VAULTED map use — so a provider can't be added here
// without also being a member of that union, and vice versa. See
// tests/token-providers.test.ts for the both-directions check this buys.
import type { TokenProvider } from '@/lib/social/credentials';

export interface TokenProviderSpec {
  key: TokenProvider;
  label: string;
  desc: string;
  brand: string; // accent colour for the card badge
  helpText: string; // where to get the token (and any other required field)
  /** An extra required field beyond the token itself, e.g. GHL's locationId. */
  extraField?: { key: string; label: string; placeholder: string };
}

export const TOKEN_PROVIDERS: TokenProviderSpec[] = [
  {
    key: 'buffer',
    label: 'Buffer',
    // An alternate ROUTE to the same social accounts the OAuth cards above
    // connect, not a different job — see lib/social/index.ts's getIntegrations,
    // whose Buffer capabilities are ['publish','schedule','analytics','LinkedIn',
    // 'Twitter/X','Facebook','Instagram'] once connected: publish, schedule, and
    // analytics for whatever channels the user already set up in Buffer, without
    // reconnecting them here. Deliberately narrower than the direct cards in one
    // respect — comment management and per-post insights aren't in that
    // capability list, so this desc doesn't claim them.
    desc: 'Publish, schedule, and see analytics for the Facebook, Instagram, LinkedIn, and X channels already connected in your Buffer account — no need to connect them again below. (Comment management and per-post insights stay with the direct cards.)',
    brand: '#168EEA',
    helpText: 'Create an access token in Buffer under Settings → API access, then paste it below.',
  },
  {
    key: 'ghl',
    label: 'GoHighLevel',
    desc: "Post through your GoHighLevel location's social planner",
    brand: '#1A9E5C',
    helpText: 'Create a Private Integration Token for the location in GoHighLevel (Settings → Private Integrations), then paste it and the location ID below.',
    extraField: { key: 'locationId', label: 'Location ID', placeholder: 'e.g. ve9EPM428h8vShlRW1KT' },
  },
];

export const TOKEN_PROVIDER_KEYS = TOKEN_PROVIDERS.map((p) => p.key);

/**
 * The predicate the Connections UI uses everywhere to derive "is this
 * provider connected": a row for this key with status 'connected' — a
 * 'revoked' (or any other status) row does not count. Pulled out as its own
 * pure function so it has one definition and one test, instead of the
 * `.filter((c) => c.provider === key && c.status === 'connected')` inline
 * that recurs across app/settings/page.tsx's sections.
 */
export function connectedAccountsFor<T extends { provider: string; status: string }>(
  connections: T[],
  key: string,
): T[] {
  return connections.filter((c) => c.provider === key && c.status === 'connected');
}
