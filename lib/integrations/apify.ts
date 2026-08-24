// Apify connector — PUBLIC social research.
//
// SCOPE, and why it is drawn here.
//
// Apify runs "actors" (hosted scrapers) and returns clean JSON. Every Instagram
// actor worth using is explicitly public-data-only: no login, no cookies, and
// private accounts are unreachable. That is the correct surface for us, and it
// is the only surface this file touches.
//
// There ARE Apify actors that take an Instagram `sessionid` cookie and reach
// login-gated data (your own saved posts and collections among it). This file
// deliberately does not use them, and no capability should. Supplying a session
// cookie does not remove Instagram's prohibition on automated access — it
// relocates the breach to a third party's infrastructure while leaving the
// account risk entirely with the account owner. Apify's own actor docs say to
// use a secondary account rather than a primary one, which is a fair warning
// and also a disqualifying one: the accounts this platform connects are
// business accounts carrying Pages, ad accounts and Business Manager access.
// For a multi-tenant product it is worse still — it would mean collecting and
// storing a live session cookie for every user's Instagram account.
//
// Saved posts and collections have a sanctioned route: Instagram's own data
// export (Accounts Center -> Export your information -> JSON), whose `saved.json`
// carries collection names and their contents. That is a user exporting their
// own data and choosing to bring it in. See lib/social/meta-read.ts for the
// matching note on why no API path exists.

const APIFY_API = 'https://api.apify.com/v2';

// The maintained first-party actor. Public profiles, posts and reels.
const INSTAGRAM_ACTOR = process.env.APIFY_INSTAGRAM_ACTOR || 'apify~instagram-scraper';

/** Same multi-casing tolerance the other connectors use for their keys. */
export function apifyToken(): string | undefined {
  return process.env.APIFY_API_TOKEN || process.env.APIFY_TOKEN || process.env.Apify_Api_Token;
}

export function apifyConfigured(): boolean {
  return Boolean(apifyToken());
}

export interface PublicSocialProfile {
  platform: 'instagram';
  handle: string;
  url: string;
  fullName: string | null;
  bio: string | null;
  website: string | null;
  followers: number | null;
  following: number | null;
  postCount: number | null;
  isVerified: boolean | null;
  isBusiness: boolean | null;
  category: string | null;
  recentPosts: {
    url: string | null;
    caption: string | null;
    postedAt: string | null;
    likes: number | null;
    comments: number | null;
    type: string | null;
  }[];
}

/** Normalise a handle or profile URL to the bare handle. */
export function normalizeHandle(input: string): string {
  const trimmed = input.trim();
  const fromUrl = trimmed.match(/instagram\.com\/([^/?#]+)/i);
  return (fromUrl ? fromUrl[1] : trimmed).replace(/^@/, '').toLowerCase();
}

/**
 * Run an actor and wait for its dataset. `run-sync-get-dataset-items` blocks
 * until the run finishes and returns the rows directly, which is what we want
 * for an interactive research call — the alternative is a run id plus polling,
 * and the assistant has no way to come back later within one turn.
 *
 * A slow actor must not hold a turn open indefinitely, so the call carries its
 * own timeout and surfaces a plain reason on abort. Never throws a raw provider
 * error at the model: the same honest-status pattern as websearch.ts, so the
 * assistant can say what it could not reach instead of failing the turn.
 */
async function runActor(actor: string, input: Record<string, any>, timeoutMs = 90_000): Promise<any[]> {
  const token = apifyToken();
  if (!token) {
    const err: any = new Error('Apify is not connected — set APIFY_API_TOKEN to enable public profile research.');
    err.code = 'not_configured';
    throw err;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${APIFY_API}/acts/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`Apify actor failed (${res.status}): ${detail || res.statusText}`);
    }
    const json = await res.json();
    return Array.isArray(json) ? json : [];
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error(`Apify actor timed out after ${timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Research ONE public Instagram profile: who they are, how big, and what they
 * have been posting. This is the "learn everything on what they do, how they
 * operate and what they have done before" input the assistant needs before it
 * can tailor outreach — and it works on any public account, not just connected
 * ones, which is the whole point for prospect research.
 *
 * A private or non-existent account yields a result with `error` set rather
 * than a throw: "this account is private" is a real research finding the model
 * should report, not a failed turn.
 */
export async function researchInstagramProfile(
  handleOrUrl: string,
  postLimit = 12,
): Promise<PublicSocialProfile | { platform: 'instagram'; handle: string; error: string }> {
  const handle = normalizeHandle(handleOrUrl);
  if (!handle) return { platform: 'instagram', handle: '', error: 'No Instagram handle was given.' };

  const rows = await runActor(INSTAGRAM_ACTOR, {
    directUrls: [`https://www.instagram.com/${handle}/`],
    resultsType: 'details',
    resultsLimit: Math.min(Math.max(postLimit, 1), 50),
    addParentData: false,
  });

  const p = rows[0];
  if (!p) {
    return { platform: 'instagram', handle, error: 'No public data came back for that account — it may be private, renamed, or removed.' };
  }
  if (p.error || p.private === true) {
    return { platform: 'instagram', handle, error: p.private === true ? 'That account is private, so nothing is publicly readable.' : String(p.error) };
  }

  const posts = Array.isArray(p.latestPosts) ? p.latestPosts : [];
  return {
    platform: 'instagram',
    handle: p.username || handle,
    url: p.url || `https://www.instagram.com/${handle}/`,
    fullName: p.fullName ?? null,
    bio: p.biography ?? null,
    website: p.externalUrl ?? null,
    followers: num(p.followersCount),
    following: num(p.followsCount),
    postCount: num(p.postsCount),
    isVerified: typeof p.verified === 'boolean' ? p.verified : null,
    isBusiness: typeof p.isBusinessAccount === 'boolean' ? p.isBusinessAccount : null,
    category: p.businessCategoryName ?? null,
    recentPosts: posts.slice(0, postLimit).map((m: any) => ({
      url: m.url ?? null,
      caption: typeof m.caption === 'string' ? m.caption.slice(0, 500) : null,
      postedAt: m.timestamp ?? null,
      likes: num(m.likesCount),
      comments: num(m.commentsCount),
      type: m.type ?? null,
    })),
  };
}
