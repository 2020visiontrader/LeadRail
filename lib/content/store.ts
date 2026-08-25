// Content engine store — pillars, platform specs, character refs, content items.
//
// Every function is account-scoped in the query, never filtered after fetching.
// brand_id is optional throughout: the engine has to work before a venture
// exists, and a piece of content belonging to no particular brand is a
// legitimate thing to plan.

import { supabase } from '@/lib/db';

export type ContentStatus =
  | 'IDEATION' | 'OUTLINE' | 'DRAFT' | 'APPROVED' | 'QUEUED' | 'PUBLISHED' | 'ARCHIVED';

export const CONTENT_STATUSES: ContentStatus[] = [
  'IDEATION', 'OUTLINE', 'DRAFT', 'APPROVED', 'QUEUED', 'PUBLISHED', 'ARCHIVED',
];

export const FUNNEL_STAGES = ['Awareness', 'Consideration', 'Decision'] as const;

export interface PlatformSpec {
  platform: string;
  char_limit: number | null;
  image_specs: string | null;
  hashtag_strategy: string | null;
  cta_format: string | null;
  copy_tone: string | null;
  optimal_time: string | null;
}

// ---------------------------------------------------------------- platform specs

/**
 * Resolve the spec for one platform: the account's own row when it has one,
 * otherwise the shared default (account_id IS NULL, seeded by migration 050).
 *
 * Returns null only when the platform is unknown to both — callers must treat
 * that as "no constraints known" and say so, never as "no constraints exist".
 */
export async function getPlatformSpec(accountId: string, platform: string): Promise<PlatformSpec | null> {
  const key = platform.toLowerCase();
  const { data, error } = await supabase
    .from('platform_specs')
    .select('*')
    .eq('platform', key)
    .or(`account_id.eq.${accountId},account_id.is.null`);
  if (error) throw error;
  if (!data?.length) return null;
  // An account override wins over the default. Ordering in SQL would put NULLs
  // wherever the planner likes, so the preference is expressed here instead.
  const own = data.find((r: any) => r.account_id === accountId);
  return (own ?? data[0]) as PlatformSpec;
}

export async function listPlatformSpecs(accountId: string): Promise<PlatformSpec[]> {
  const { data, error } = await supabase
    .from('platform_specs')
    .select('*')
    .or(`account_id.eq.${accountId},account_id.is.null`);
  if (error) throw error;
  const byPlatform = new Map<string, any>();
  for (const row of data || []) {
    const existing = byPlatform.get(row.platform);
    // Same override rule as above: keep the account's row when both exist.
    if (!existing || row.account_id === accountId) byPlatform.set(row.platform, row);
  }
  return Array.from(byPlatform.values()) as PlatformSpec[];
}

/** Create or replace this account's override for one platform. */
export async function upsertPlatformSpec(
  accountId: string,
  platform: string,
  patch: Partial<Omit<PlatformSpec, 'platform'>>,
): Promise<PlatformSpec> {
  const key = platform.toLowerCase();
  const { data, error } = await supabase
    .from('platform_specs')
    .upsert(
      { account_id: accountId, platform: key, ...patch, updated_at: new Date().toISOString() },
      { onConflict: 'account_id,platform' },
    )
    .select()
    .single();
  if (error) throw error;
  return data as PlatformSpec;
}

/** Render a spec as the prompt block a generator should obey. Empty string when
 *  nothing is known, so callers can splice it in unconditionally. */
export function platformSpecBlock(spec: PlatformSpec | null): string {
  if (!spec) return '';
  const lines = [`PLATFORM CONSTRAINTS — ${spec.platform} (obey these, they are facts not preferences):`];
  if (spec.char_limit) lines.push(`- Hard character limit: ${spec.char_limit}. Do not exceed it.`);
  if (spec.copy_tone) lines.push(`- Voice on this surface: ${spec.copy_tone}`);
  if (spec.hashtag_strategy) lines.push(`- Hashtags: ${spec.hashtag_strategy}`);
  if (spec.cta_format) lines.push(`- CTA: ${spec.cta_format}`);
  if (spec.image_specs) lines.push(`- Image/video spec: ${spec.image_specs}`);
  return lines.join('\n');
}

// --------------------------------------------------------------------- pillars

export async function listPillars(accountId: string, brandId?: string | null) {
  let q = supabase.from('content_pillars').select('*').eq('account_id', accountId);
  // A brand inherits account-level (brand_id IS NULL) pillars as well as its own.
  if (brandId) q = q.or(`brand_id.eq.${brandId},brand_id.is.null`);
  const { data, error } = await q.order('sort_order', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function createPillar(accountId: string, input: {
  name: string; pain?: string; promise?: string; brandId?: string | null; sortOrder?: number;
}) {
  const { data, error } = await supabase.from('content_pillars').insert([{
    account_id: accountId,
    brand_id: input.brandId ?? null,
    name: input.name,
    pain: input.pain ?? null,
    promise: input.promise ?? null,
    sort_order: input.sortOrder ?? 0,
  }]).select().single();
  if (error) throw error;
  return data;
}

export async function deletePillar(accountId: string, id: string) {
  const { error } = await supabase.from('content_pillars').delete().eq('id', id).eq('account_id', accountId);
  if (error) throw error;
  return { id, deleted: true };
}

/**
 * Pick the pillar this piece should serve, rotating rather than repeating.
 *
 * A feed that hammers one pillar reads as one idea restated. Rotation is what
 * makes three pillars feel like a programme instead of a loop, so the default
 * is "whichever pillar is least recently used", computed from what is already
 * on the board — not random, and not always the first row.
 */
export async function nextPillar(accountId: string, brandId?: string | null) {
  const pillars = await listPillars(accountId, brandId);
  if (!pillars.length) return null;
  let q = supabase
    .from('content_items')
    .select('pillar_id, created_at')
    .eq('account_id', accountId)
    .not('pillar_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(50);
  if (brandId) q = q.eq('brand_id', brandId);
  const { data: recent } = await q;
  const lastUsedAt = new Map<string, number>();
  (recent || []).forEach((r: any, i: number) => {
    if (r.pillar_id && !lastUsedAt.has(r.pillar_id)) lastUsedAt.set(r.pillar_id, i);
  });
  // Never used sorts first (Infinity), then least-recently used.
  return [...pillars].sort(
    (a: any, b: any) => (lastUsedAt.has(b.id) ? lastUsedAt.get(b.id)! : Infinity) - (lastUsedAt.has(a.id) ? lastUsedAt.get(a.id)! : Infinity),
  )[0];
}

// ----------------------------------------------------------- character refs

export async function listCharacterRefs(accountId: string, brandId?: string | null) {
  let q = supabase.from('character_refs').select('*').eq('account_id', accountId);
  if (brandId) q = q.or(`brand_id.eq.${brandId},brand_id.is.null`);
  const { data, error } = await q.order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getCharacterRef(accountId: string, id: string) {
  const { data, error } = await supabase
    .from('character_refs').select('*').eq('id', id).eq('account_id', accountId).maybeSingle();
  if (error) throw error;
  return data;
}

export async function createCharacterRef(accountId: string, input: {
  name: string; imageUrl: string; description: string; styleLock?: string; brandId?: string | null;
}) {
  const { data, error } = await supabase.from('character_refs').insert([{
    account_id: accountId,
    brand_id: input.brandId ?? null,
    name: input.name,
    image_url: input.imageUrl,
    description: input.description,
    style_lock: input.styleLock ?? null,
  }]).select().single();
  if (error) throw error;
  return data;
}

// --------------------------------------------------------------- content items

export interface ContentItemInput {
  title: string;
  brandId?: string | null;
  status?: ContentStatus;
  contentType?: string | null;
  platforms?: string[];
  pillarId?: string | null;
  pillar?: string | null;
  funnelStage?: string | null;
  keyAngle?: string | null;
  targetAudience?: string | null;
  hook?: string | null;
  body?: string | null;
  cta?: string | null;
  hashtags?: string[];
  imagePrompt?: string | null;
  mediaUrl?: string | null;
  pipelineRunId?: string | null;
  scheduledFor?: string | null;
  /** 'organic' or 'paid' (migration 054). Different objective, different
   *  brief — see the note on the column. */
  intent?: 'organic' | 'paid';
  /** Ties siblings in a hook × body × cta test into one experiment. */
  variantGroup?: string | null;
  variantLabel?: string | null;
  linearityScore?: number | null;
  linearityReport?: unknown;
}

function toRow(accountId: string, i: ContentItemInput) {
  return {
    account_id: accountId,
    brand_id: i.brandId ?? null,
    title: i.title,
    status: i.status ?? 'IDEATION',
    content_type: i.contentType ?? null,
    platforms: i.platforms ?? [],
    pillar_id: i.pillarId ?? null,
    pillar: i.pillar ?? null,
    funnel_stage: i.funnelStage ?? null,
    key_angle: i.keyAngle ?? null,
    target_audience: i.targetAudience ?? null,
    hook: i.hook ?? null,
    body: i.body ?? null,
    cta: i.cta ?? null,
    hashtags: i.hashtags ?? [],
    image_prompt: i.imagePrompt ?? null,
    media_url: i.mediaUrl ?? null,
    pipeline_run_id: i.pipelineRunId ?? null,
    scheduled_for: i.scheduledFor ?? null,
    intent: i.intent ?? 'organic',
    variant_group: i.variantGroup ?? null,
    variant_label: i.variantLabel ?? null,
    linearity_score: i.linearityScore ?? null,
    linearity_report: i.linearityReport ?? null,
  };
}

export async function createContentItem(accountId: string, input: ContentItemInput) {
  const { data, error } = await supabase.from('content_items').insert([toRow(accountId, input)]).select().single();
  if (error) throw error;
  return data;
}

export async function listContentItems(accountId: string, opts?: {
  status?: ContentStatus; brandId?: string | null; platform?: string; limit?: number;
  intent?: 'organic' | 'paid';
}) {
  let q = supabase.from('content_items').select('*').eq('account_id', accountId);
  if (opts?.status) q = q.eq('status', opts.status);
  if (opts?.brandId) q = q.eq('brand_id', opts.brandId);
  if (opts?.platform) q = q.contains('platforms', [opts.platform.toLowerCase()]);
  if (opts?.intent) q = q.eq('intent', opts.intent);
  const { data, error } = await q
    .order('updated_at', { ascending: false })
    .limit(Math.min(opts?.limit ?? 50, 200));
  if (error) throw error;
  return data || [];
}

export async function getContentItem(accountId: string, id: string) {
  const { data, error } = await supabase
    .from('content_items').select('*').eq('id', id).eq('account_id', accountId).maybeSingle();
  if (error) throw error;
  return data;
}

export async function updateContentItem(accountId: string, id: string, patch: Record<string, any>) {
  const { data, error } = await supabase
    .from('content_items')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id).eq('account_id', accountId)
    .select().single();
  if (error) throw error;
  return data;
}

/** Move an item along the board. Kept separate from updateContentItem so the
 *  transition is one auditable call rather than a field poke, and so PUBLISHED
 *  can stamp published_at without every caller remembering to. */
export async function setContentStatus(accountId: string, id: string, status: ContentStatus) {
  const patch: Record<string, any> = { status };
  if (status === 'PUBLISHED') patch.published_at = new Date().toISOString();
  return updateContentItem(accountId, id, patch);
}

export async function deleteContentItem(accountId: string, id: string) {
  const { error } = await supabase.from('content_items').delete().eq('id', id).eq('account_id', accountId);
  if (error) throw error;
  return { id, deleted: true };
}

/** Counts per status — the board summary the assistant answers "where does
 *  content stand?" with, without pulling every row into context. */
export async function contentBoardSummary(accountId: string, brandId?: string | null) {
  let q = supabase.from('content_items').select('status').eq('account_id', accountId);
  if (brandId) q = q.eq('brand_id', brandId);
  const { data, error } = await q;
  if (error) throw error;
  const counts: Record<string, number> = {};
  for (const r of data || []) counts[r.status] = (counts[r.status] || 0) + 1;
  return { total: (data || []).length, byStatus: counts };
}
