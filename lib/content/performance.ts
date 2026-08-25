// Closing the loop — what actually happened to the things we published.
//
// THE SEAM THIS CLOSES. content_items has carried a `performance` column since
// migration 050 and nothing has ever written to it. So the engine generated,
// scored and published, and then the trail went cold: every piece was judged on
// whether it looked right at the moment it was written, and nothing ever
// checked whether that judgement was any good. An engine that cannot see its
// own results is a very confident guesser.
//
// WHAT THIS DOES NOT DO, deliberately. It does not change the canon, retune the
// generator, or "learn". It ingests numbers and reports patterns. Every
// adjustment stays a proposal a human accepts, for the same reason skill
// repairs are proposals: a system that rewrites its own brand rules from
// engagement data optimises for engagement, and the thing that reliably wins on
// engagement is not the thing a brand wants to be known for. Drift with a
// feedback loop behind it is still drift, and it is harder to notice because it
// arrives with evidence attached.
//
// HONEST ABOUT SMALL NUMBERS. Four posts is not a finding. Where the sample is
// too thin to support a claim, this says so rather than ranking three items and
// presenting the order as a result — see MIN_SAMPLE.

import { supabase, dbReady } from '@/lib/db';
import { listInstagramMedia, listFacebookPagePosts } from '@/lib/social/meta-read';

/** Below this, a comparison is arithmetic rather than evidence. Stated as a
 *  constant so the threshold is arguable rather than buried in a condition. */
const MIN_SAMPLE = 5;

export interface PerformanceSnapshot {
  likes: number | null;
  comments: number | null;
  shares: number | null;
  /** likes + comments + shares. A crude total, and named crudely so nobody
   *  mistakes it for reach or for a rate. */
  engagement: number;
  permalink: string | null;
  capturedAt: string;
}

export interface SyncResult {
  matched: number;
  updated: number;
  /** Published items we could not find a live post for, with the reason.
   *  Reported rather than skipped: a board that silently shows metrics for
   *  three of twenty published items looks like twenty items performing badly. */
  unmatched: { id: string; title: string; reason: string }[];
}

/**
 * Pull live metrics for published items and write them back.
 *
 * Matching is by external_post_id ONLY. Matching on caption text was the
 * obvious alternative and is rejected: captions get edited after posting, two
 * pieces in a series legitimately share an opening, and a wrong match writes
 * one post's numbers onto another piece — which then teaches the wrong lesson
 * to everything downstream. An unmatched item is reported; a mismatched one is
 * invisible and worse.
 */
export async function syncPerformance(input: {
  accountId: string;
  brandId?: string | null;
  limit?: number;
}): Promise<SyncResult> {
  if (!dbReady()) return { matched: 0, updated: 0, unmatched: [] };

  let q = supabase
    .from('content_items')
    .select('id, title, platforms, external_post_id, published_at')
    .eq('account_id', input.accountId)
    .eq('status', 'PUBLISHED')
    .order('published_at', { ascending: false })
    .limit(input.limit ?? 50);
  if (input.brandId) q = q.eq('brand_id', input.brandId);

  const { data: items, error } = await q;
  if (error) throw error;
  if (!items?.length) return { matched: 0, updated: 0, unmatched: [] };

  // One read per platform, not one per item. Twenty published pieces would
  // otherwise be twenty Graph calls against a rate limit that is shared with
  // everything else this account does.
  const platforms = new Set<string>();
  for (const it of items) for (const p of it.platforms || []) platforms.add(String(p).toLowerCase());

  const live = new Map<string, { likes: number | null; comments: number | null; shares: number | null; permalink: string | null }>();
  const platformErrors: string[] = [];

  await Promise.all(
    Array.from(platforms).map(async (p) => {
      try {
        const posts =
          p === 'instagram' ? await listInstagramMedia(input.accountId, undefined, 50)
          : p === 'facebook' ? await listFacebookPagePosts(input.accountId, undefined, 50)
          : [];
        for (const post of posts) {
          live.set(post.id, {
            likes: post.likes, comments: post.comments, shares: post.shares, permalink: post.permalink,
          });
        }
      } catch (e: any) {
        // One unreachable platform must not fail the sync for the others.
        platformErrors.push(`${p}: ${String(e?.message || e).slice(0, 120)}`);
      }
    }),
  );

  const unmatched: SyncResult['unmatched'] = [];
  let matched = 0;
  let updated = 0;

  for (const it of items) {
    if (!it.external_post_id) {
      unmatched.push({ id: it.id, title: it.title, reason: 'no external post id — it was marked published without recording where' });
      continue;
    }
    const m = live.get(String(it.external_post_id));
    if (!m) {
      unmatched.push({
        id: it.id,
        title: it.title,
        reason: platformErrors.length
          ? `the platform could not be read (${platformErrors.join('; ')})`
          : 'not in the most recent posts on the connected account',
      });
      continue;
    }
    matched++;
    const snapshot: PerformanceSnapshot = {
      likes: m.likes,
      comments: m.comments,
      shares: m.shares,
      engagement: (m.likes || 0) + (m.comments || 0) + (m.shares || 0),
      permalink: m.permalink,
      capturedAt: new Date().toISOString(),
    };
    const { error: upErr } = await supabase
      .from('content_items')
      .update({ performance: snapshot, updated_at: new Date().toISOString() })
      .eq('id', it.id)
      .eq('account_id', input.accountId);
    if (!upErr) updated++;
  }

  return { matched, updated, unmatched };
}

// ---------------------------------------------------------------------------

export interface PatternObservation {
  dimension: 'pillar' | 'format' | 'platform';
  value: string;
  sample: number;
  medianEngagement: number;
}

export interface PerformanceReport {
  scored: number;
  observations: PatternObservation[];
  /** Why a dimension was left out — thin sample, no data. Always populated
   *  where it applies, because an absent row and a row that was never checked
   *  read identically once they are both missing from a list. */
  caveats: string[];
}

/** Median, not mean. One post that got picked up by a large account otherwise
 *  drags the average for its whole pillar and turns a fluke into a strategy. */
function median(ns: number[]): number {
  if (!ns.length) return 0;
  const s = [...ns].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * What the numbers on file suggest — as observations, never as instructions.
 *
 * The wording throughout is comparative and hedged on purpose. "Pillar X has a
 * higher median" is a fact about five posts; "make more X" is a strategy, and
 * the difference between them is the entire reason this returns a report
 * instead of writing to the canon.
 */
export async function performanceReport(input: {
  accountId: string;
  brandId?: string | null;
}): Promise<PerformanceReport> {
  if (!dbReady()) return { scored: 0, observations: [], caveats: ['database not configured'] };

  let q = supabase
    .from('content_items')
    .select('pillar, platforms, performance')
    .eq('account_id', input.accountId)
    .eq('status', 'PUBLISHED')
    .not('performance', 'is', null)
    .limit(500);
  if (input.brandId) q = q.eq('brand_id', input.brandId);

  const { data, error } = await q;
  if (error) throw error;

  const rows = (data || []).filter((r: any) => typeof r?.performance?.engagement === 'number');
  const caveats: string[] = [];
  if (rows.length < MIN_SAMPLE) {
    return {
      scored: rows.length,
      observations: [],
      caveats: [
        `Only ${rows.length} published ${rows.length === 1 ? 'piece has' : 'pieces have'} metrics on file. That is too few to compare anything — any ranking off this would be noise wearing a number.`,
      ],
    };
  }

  const byPillar = new Map<string, number[]>();
  const byPlatform = new Map<string, number[]>();
  for (const r of rows as any[]) {
    const e = r.performance.engagement as number;
    if (r.pillar) {
      if (!byPillar.has(r.pillar)) byPillar.set(r.pillar, []);
      byPillar.get(r.pillar)!.push(e);
    }
    for (const p of r.platforms || []) {
      const k = String(p);
      if (!byPlatform.has(k)) byPlatform.set(k, []);
      byPlatform.get(k)!.push(e);
    }
  }

  const observations: PatternObservation[] = [];
  const collect = (dim: PatternObservation['dimension'], m: Map<string, number[]>) => {
    let thin = 0;
    for (const [value, ns] of m) {
      if (ns.length < MIN_SAMPLE) { thin++; continue; }
      observations.push({ dimension: dim, value, sample: ns.length, medianEngagement: median(ns) });
    }
    if (thin) caveats.push(`${thin} ${dim}${thin === 1 ? '' : 's'} left out — fewer than ${MIN_SAMPLE} pieces each, which is not enough to say anything.`);
  };
  collect('pillar', byPillar);
  collect('platform', byPlatform);

  observations.sort((a, b) => b.medianEngagement - a.medianEngagement);
  return { scored: rows.length, observations, caveats };
}
