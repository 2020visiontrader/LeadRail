// GoHighLevel Social Media API wrapper.
// GHL API v2 docs: https://highlevel.stoplight.io/docs/integrations/
//
// PACKET 7.2. Every function takes the caller's authenticated accountId FIRST
// and authenticates with THAT account's own Private Integration Token, resolved
// from its integration_connections row (lib/social/credentials.ts). Previously
// this file read GOHIGHLEVEL_ACCESS_TOKEN from process.env, so
// `getSocialAccounts(locationId)` returned the operator's connected profiles to
// every tenant on the deployment.
//
// A GHL PIT is location-scoped, which is a second, independent guard: even the
// `locationId` a route still accepts from the client can only address locations
// the calling account's own token is authorised for. The token itself is used
// for one outbound header and is never logged or returned.

import { getConnection } from '@/lib/db';
import { requireSocialCredential } from './credentials';

const GHL_API = 'https://services.leadconnectorhq.com';

/**
 * Resolve the GHL location id server-side (Phase D #15). The token is a
 * location-scoped Private Integration Token, so the location id belongs on the
 * server, not the client. Order: THIS account's stored connection meta → the
 * env value, but only for the one account the env credential belongs to → null.
 *
 * Two changes from the previous version, both deliberate:
 *
 *  - The DB read no longer sits inside `catch {}`. A silent catch here fell
 *    through to the shared env location id whenever the query failed, which is
 *    the failure mode this packet exists to remove; a resolve that cannot read
 *    the account's row must fail loudly, not guess.
 *  - The env fallback is gated on SOCIAL_ENV_FALLBACK_ACCOUNT_ID matching the
 *    caller, the same single-account rule the token fallback uses. Handing
 *    tenant B the operator's location id is a smaller leak than handing over
 *    the token, but it is still a cross-tenant default.
 */
export async function resolveGhlLocationId(accountId?: string): Promise<string | null> {
  if (accountId) {
    // Account-scoped in-query: getConnection applies .eq('account_id', accountId).
    for (const provider of ['ghl', 'gohighlevel']) {
      const conn = await getConnection(accountId, provider);
      const stored = conn?.meta?.locationId || conn?.meta?.location_id;
      if (stored) return String(stored);
    }
    if (process.env.SOCIAL_ENV_FALLBACK_ACCOUNT_ID === accountId) {
      return process.env.GHL_LOCATION_ID || null;
    }
  }
  return null;
}

async function ghlHeaders(accountId: string): Promise<Record<string, string>> {
  const { token } = await requireSocialCredential(accountId, 'ghl');
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Version: '2023-02-21',
    Accept: 'application/json',
  };
}

export async function getLocations(accountId: string) {
  const res = await fetch(`${GHL_API}/locations/search`, {
    method: 'POST',
    headers: await ghlHeaders(accountId),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GHL locations error: ${res.status} — ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.locations || data;
}

/** List social media accounts connected to a GHL location. */
export async function getSocialAccounts(accountId: string, locationId: string) {
  const res = await fetch(`${GHL_API}/social-media-posting/${locationId}/accounts`, {
    headers: await ghlHeaders(accountId),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GHL accounts error: ${res.status} — ${text.slice(0, 300)}`);
  }
  return res.json();
}

/** Create a social media post via GHL. */
export async function createPost(
  accountId: string,
  locationId: string,
  text: string,
  socialAccountIds?: string[],
  scheduleDate?: string,
  mediaUrls?: string[],
) {
  const body: Record<string, unknown> = {
    text,
    type: 'now',
    ...(socialAccountIds?.length ? { accountIds: socialAccountIds } : {}),
    ...(mediaUrls?.length ? { attachments: mediaUrls.map(url => ({ url, type: 'image' })) } : {}),
  };
  if (scheduleDate) {
    body.type = 'schedule';
    body.scheduleDate = scheduleDate;
  }
  const res = await fetch(`${GHL_API}/social-media-posting/${locationId}/posts`, {
    method: 'POST',
    headers: await ghlHeaders(accountId),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GHL create post error (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Get social posts for a location, optionally filtered by a GHL social account.
 * `socialAccountId` is GoHighLevel's id for one connected profile — it is NOT a
 * LeadRail account id; `accountId` is.
 */
export async function listPosts(
  accountId: string,
  locationId: string,
  socialAccountId?: string,
  limit = 20,
) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (socialAccountId) params.set('accountId', socialAccountId);

  const res = await fetch(`${GHL_API}/social-media-posting/${locationId}/posts?${params}`, {
    headers: await ghlHeaders(accountId),
  });
  if (!res.ok) throw new Error(`GHL posts error: ${res.status}`);
  return res.json();
}

/** Delete a scheduled social post from GHL. */
export async function deletePost(accountId: string, locationId: string, postId: string) {
  const res = await fetch(`${GHL_API}/social-media-posting/${locationId}/posts/${postId}`, {
    method: 'DELETE',
    headers: await ghlHeaders(accountId),
  });
  if (!res.ok) throw new Error(`GHL delete post error: ${res.status}`);
  return { deleted: true, postId };
}

/** Get social post analytics. */
export async function getPostAnalytics(accountId: string, locationId: string, postId: string) {
  const res = await fetch(`${GHL_API}/social-media-posting/${locationId}/posts/${postId}/analytics`, {
    headers: await ghlHeaders(accountId),
  });
  if (!res.ok) throw new Error(`GHL analytics error: ${res.status}`);
  return res.json();
}
