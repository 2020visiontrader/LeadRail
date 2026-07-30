// GoHighLevel Social Media API wrapper.
// Uses the GOHIGHLEVEL_ACCESS_TOKEN env var (from OAuth connection).
// GHL API v2 docs: https://highlevel.stoplight.io/docs/integrations/

const GHL_API = 'https://services.leadconnectorhq.com';

/**
 * Resolve the GHL location id server-side (Phase D #15). Our token is a
 * location-scoped Private Integration Token, so the location id belongs on the
 * server, not the client. Order: the account's stored connection meta →
 * GHL_LOCATION_ID env → null. Routes accept a client override for flexibility
 * but should default to this so the integration works without the frontend
 * knowing the id.
 */
export async function resolveGhlLocationId(accountId?: string): Promise<string | null> {
  if (accountId) {
    try {
      const { getConnections } = await import('@/lib/db');
      const conns = await getConnections(accountId);
      const ghl = conns.find((c: any) => c.provider === 'ghl' || c.provider === 'gohighlevel');
      const stored = ghl?.meta?.locationId || ghl?.meta?.location_id;
      if (stored) return String(stored);
    } catch {
      // connection table/row absent — fall through to env
    }
  }
  return process.env.GHL_LOCATION_ID || null;
}

function headers() {
  const token = process.env.GOHIGHLEVEL_ACCESS_TOKEN;
  if (!token) throw new Error('GOHIGHLEVEL_ACCESS_TOKEN not set — connect GoHighLevel in Settings → Integrations');
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Version: '2023-02-21',
    Accept: 'application/json',
  };
}

export async function getLocations() {
  const res = await fetch(`${GHL_API}/locations/search`, {
    method: 'POST',
    headers: headers(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GHL locations error: ${res.status} — ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.locations || data;
}

/** List social media accounts connected to a GHL location. */
export async function getSocialAccounts(locationId: string) {
  const res = await fetch(`${GHL_API}/social-media-posting/${locationId}/accounts`, {
    headers: headers(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GHL accounts error: ${res.status} — ${text.slice(0, 300)}`);
  }
  return res.json();
}

/** Create a social media post via GHL. */
export async function createPost(
  locationId: string,
  text: string,
  accountIds?: string[],
  scheduleDate?: string,
  mediaUrls?: string[],
) {
  const body: Record<string, unknown> = {
    text,
    type: 'now',
    ...(accountIds?.length ? { accountIds } : {}),
    ...(mediaUrls?.length ? { attachments: mediaUrls.map(url => ({ url, type: 'image' })) } : {}),
  };
  if (scheduleDate) {
    body.type = 'schedule';
    body.scheduleDate = scheduleDate;
  }
  const res = await fetch(`${GHL_API}/social-media-posting/${locationId}/posts`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GHL create post error (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

/** Get social posts for a location, optionally filtered by account. */
export async function listPosts(locationId: string, accountId?: string, limit = 20) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (accountId) params.set('accountId', accountId);

  const res = await fetch(`${GHL_API}/social-media-posting/${locationId}/posts?${params}`, {
    headers: headers(),
  });
  if (!res.ok) throw new Error(`GHL posts error: ${res.status}`);
  return res.json();
}

/** Delete a scheduled social post from GHL. */
export async function deletePost(locationId: string, postId: string) {
  const res = await fetch(`${GHL_API}/social-media-posting/${locationId}/posts/${postId}`, {
    method: 'DELETE',
    headers: headers(),
  });
  if (!res.ok) throw new Error(`GHL delete post error: ${res.status}`);
  return { deleted: true, postId };
}

/** Get social post analytics. */
export async function getPostAnalytics(locationId: string, postId: string) {
  const res = await fetch(`${GHL_API}/social-media-posting/${locationId}/posts/${postId}/analytics`, {
    headers: headers(),
  });
  if (!res.ok) throw new Error(`GHL analytics error: ${res.status}`);
  return res.json();
}
