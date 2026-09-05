// Generations ledger — the record that a media generation happened.
//
// Migrations 086/087 gave every generated image/video a private, tenant-
// prefixed home in Supabase Storage. Nothing recorded that the generation
// itself happened: no listing, no review, no quota, no retention. This module
// is that record. Scope is deliberately MEDIA ONLY (image/video) — text
// content already has a review surface (content_items, lib/content/store.ts)
// and building a second one here would duplicate it, not close a gap.
//
// account_id is always the caller-supplied, session-derived scope — never
// trusted from anywhere else — same discipline as every other store module.

import { supabase } from '@/lib/db';
import { GENERATED_BUCKET, GENERATED_URL_TTL, signUrl, uploadGenerated, removeObjects } from '@/lib/storage';

export type GenerationKind = 'image' | 'video';
export type ReviewState = 'PENDING' | 'APPROVED' | 'REJECTED';

// --- business policy, not physical limits. Chosen by the owner: room for real
// use without an unbounded bill, and a review window long enough for someone
// to actually look before the asset is swept. Change these to change the
// policy, not to fix a bug. ---
export const GENERATION_QUOTA_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB per account
export const GENERATION_RETENTION_DAYS = 90;
// Owner's actual retention policy (corrected during review — see
// purgeExpiredGenerations below): once a generation is confirmed live on a
// channel, the channel becomes the system of record and we no longer need to
// hold the bytes ourselves — the user retrieves it from there if they need
// it. GRACE is deliberately not zero: a post pulled or a publish that fails
// right after going live must still leave a recoverable copy for a few days,
// not vanish the instant published_at is set. Owner-adjustable business
// policy, same as the two constants above.
export const GENERATION_PUBLISH_GRACE_DAYS = 7;

export interface GenerationRow {
  id: string;
  account_id: string;
  brand_id: string | null;
  kind: GenerationKind;
  source_tool: string;
  prompt: string | null;
  model: string | null;
  storage_path: string | null;
  external_url: string | null;
  mime_type: string | null;
  bytes: number;
  review_state: ReviewState;
  review_note: string | null;
  reviewed_at: string | null;
  content_item_id: string | null;
  expires_at: string | null;
  published_at: string | null;
  purged_at: string | null;
  channel_url: string | null;
  created_at: string;
}

export interface RecordGenerationInput {
  brandId?: string | null;
  kind: GenerationKind;
  sourceTool: string;
  prompt?: string | null;
  model?: string | null;
  storagePath?: string | null;
  externalUrl?: string | null;
  mimeType?: string | null;
  bytes?: number;
}

/** Insert one generation row. New rows start PENDING with expires_at set
 *  GENERATION_RETENTION_DAYS out — reviewGeneration is what changes that. */
export async function recordGeneration(accountId: string, input: RecordGenerationInput): Promise<GenerationRow> {
  const expiresAt = new Date(Date.now() + GENERATION_RETENTION_DAYS * 864e5).toISOString();
  const { data, error } = await supabase
    .from('generations')
    .insert([{
      account_id: accountId,
      brand_id: input.brandId ?? null,
      kind: input.kind,
      source_tool: input.sourceTool,
      prompt: input.prompt ?? null,
      model: input.model ?? null,
      storage_path: input.storagePath ?? null,
      external_url: input.externalUrl ?? null,
      mime_type: input.mimeType ?? null,
      bytes: input.bytes ?? 0,
      review_state: 'PENDING',
      expires_at: expiresAt,
    }])
    .select()
    .single();
  if (error) throw error;
  return data as GenerationRow;
}

export async function listGenerations(accountId: string, opts?: {
  brandId?: string | null; reviewState?: ReviewState; kind?: GenerationKind; limit?: number;
  contentItemId?: string | null;
}): Promise<GenerationRow[]> {
  let q = supabase.from('generations').select('*').eq('account_id', accountId);
  if (opts?.brandId) q = q.eq('brand_id', opts.brandId);
  if (opts?.reviewState) q = q.eq('review_state', opts.reviewState);
  if (opts?.kind) q = q.eq('kind', opts.kind);
  if (opts?.contentItemId) q = q.eq('content_item_id', opts.contentItemId);
  const { data, error } = await q
    .order('created_at', { ascending: false })
    .limit(Math.min(opts?.limit ?? 50, 200));
  if (error) throw error;
  return (data || []) as GenerationRow[];
}

export async function getGeneration(accountId: string, id: string): Promise<GenerationRow | null> {
  const { data, error } = await supabase
    .from('generations').select('*').eq('id', id).eq('account_id', accountId).maybeSingle();
  if (error) throw error;
  return (data as GenerationRow) ?? null;
}

/**
 * Approve or reject a generation. APPROVED clears expires_at — an approved
 * asset is held indefinitely (it still has to go out) and the ROW's
 * expiry-based delete path never touches it again. REJECTED leaves
 * expires_at as-is, so a rejected asset still ages out on the original
 * retention schedule rather than lingering forever.
 *
 * This governs the ROW's expiry only. A separately-governed OBJECT lifetime
 * kicks in once an approved generation is actually published — see
 * markGenerationPublished and purgeExpiredGenerations below.
 */
export async function reviewGeneration(
  accountId: string,
  id: string,
  state: 'APPROVED' | 'REJECTED',
  note?: string | null,
): Promise<GenerationRow> {
  const patch: Record<string, any> = {
    review_state: state,
    review_note: note ?? null,
    reviewed_at: new Date().toISOString(),
  };
  if (state === 'APPROVED') patch.expires_at = null;
  const { data, error } = await supabase
    .from('generations')
    .update(patch)
    .eq('id', id)
    .eq('account_id', accountId)
    .select()
    .single();
  if (error) throw error;
  return data as GenerationRow;
}

/**
 * Mark a generation as confirmed live on a channel. Requires a real
 * `channelUrl` — this is the ONLY place published_at is ever set, and it is
 * set together with channel_url, atomically, so a row can never end up
 * published with no permalink to point a user at once its bytes are purged.
 * Only meaningful for an APPROVED generation whose bytes we still hold
 * (storage_path set) — a Higgsfield-hosted video already lives on Higgsfield,
 * not in our bucket, so publishing it purges nothing new; callers should not
 * bother calling this for one, though it is harmless (purgeExpiredGenerations
 * simply finds no storage_path to drop).
 */
export async function markGenerationPublished(accountId: string, id: string, channelUrl: string): Promise<GenerationRow> {
  if (!channelUrl) throw new Error('markGenerationPublished requires a channel URL — without one a purged copy would have nowhere to point the user.');
  const { data, error } = await supabase
    .from('generations')
    .update({ published_at: new Date().toISOString(), channel_url: channelUrl })
    .eq('id', id)
    .eq('account_id', accountId)
    .select()
    .single();
  if (error) throw error;
  return data as GenerationRow;
}

/** Link an approved generation to a content_items row (set by
 *  promoteGenerationToContent, lib/capabilities/generations.ts). This module
 *  never writes content_items itself — createContentItem/updateContentItem
 *  (lib/capabilities/content.ts) own that write. */
export async function linkGenerationToContentItem(accountId: string, id: string, contentItemId: string): Promise<GenerationRow> {
  const { data, error } = await supabase
    .from('generations')
    .update({ content_item_id: contentItemId })
    .eq('id', id)
    .eq('account_id', accountId)
    .select()
    .single();
  if (error) throw error;
  return data as GenerationRow;
}

/**
 * Resolve the URL to actually display/use a generation, at READ time — never
 * persisted. Same invariant as resolveCharacterRefUrl (lib/content/store.ts)
 * and resolveCampaignAssetUrl (lib/crm.ts): a signed URL expires
 * (GENERATED_URL_TTL), so it is minted fresh on every read, not stored.
 * Falls back to external_url for a Higgsfield-hosted video with no
 * storage_path.
 */
export async function resolveGenerationUrl(row: { storage_path?: string | null; external_url?: string | null }): Promise<string | null> {
  if (row.storage_path) {
    const fresh = await signUrl(GENERATED_BUCKET, row.storage_path, GENERATED_URL_TTL);
    if (fresh) return fresh;
  }
  return row.external_url ?? null;
}

/**
 * Sum of bytes for this account's generations whose OBJECT still physically
 * exists in our bucket right now: storage_path IS NOT NULL (something was
 * actually uploaded — a Higgsfield-hosted video has none) AND purged_at IS
 * NULL (we have not already dropped our copy). This is deliberately NOT
 * keyed off expires_at/review_state — a published generation stops
 * consuming quota the moment purgeExpiredGenerations drops its bytes,
 * regardless of how "expired" the row concept even applies to it (it
 * doesn't: published rows have no expires_at).
 */
export async function accountStorageBytes(accountId: string): Promise<number> {
  const { data, error } = await supabase
    .from('generations')
    .select('bytes')
    .eq('account_id', accountId)
    .not('storage_path', 'is', null)
    .is('purged_at', null);
  if (error) throw error;
  return (data || []).reduce((sum: number, r: any) => sum + (r.bytes || 0), 0);
}

/** Throws a readable error naming the limit and current usage when adding
 *  `incomingBytes` would put the account over GENERATION_QUOTA_BYTES. A
 *  Higgsfield-hosted video (bytes=0, no upload of ours) never calls this —
 *  it consumes none of the account's Supabase Storage. */
export async function assertGenerationQuota(accountId: string, incomingBytes: number): Promise<void> {
  const used = await accountStorageBytes(accountId);
  if (used + incomingBytes > GENERATION_QUOTA_BYTES) {
    const usedMb = (used / (1024 * 1024)).toFixed(1);
    const limitMb = (GENERATION_QUOTA_BYTES / (1024 * 1024)).toFixed(0);
    const incomingMb = (incomingBytes / (1024 * 1024)).toFixed(1);
    throw new Error(
      `Generation storage quota exceeded: this account is using ${usedMb} MB of a ${limitMb} MB limit, ` +
      `and this generation would add ${incomingMb} MB. Approve or reject pending generations to free space, ` +
      `or wait for old ones to expire.`,
    );
  }
}

/**
 * THE SHARED WRITE PATH — every image generation site (generateBrandImage,
 * generateImage, POST /api/generate/image) MUST call this rather than
 * inlining check-quota → upload → record itself. One place to fix, one place
 * to grep (tests/generations-wrapper-guard.test.ts), instead of three copies
 * drifting apart the way the four generated-media call sites already did
 * once before (see migrations 086/087's history).
 *
 * Checks quota BEFORE uploading — no point paying a storage write only to
 * reject it after the fact — uploads through uploadGenerated (the existing
 * single write path into GENERATED_BUCKET), then records the row. Returns
 * exactly what every call site already returns to its caller today: a fresh
 * display URL and the stable storage path, plus the new generationId.
 */
export async function recordMediaGeneration(accountId: string, input: {
  kind: GenerationKind;
  sourceTool: string;
  prompt?: string | null;
  model?: string | null;
  brandId?: string | null;
  bytes: Buffer | Uint8Array;
  mimeType: string;
}): Promise<{ url: string; storagePath: string; generationId: string }> {
  await assertGenerationQuota(accountId, input.bytes.byteLength);
  const { storagePath, url } = await uploadGenerated(accountId, input.bytes, input.mimeType);
  const row = await recordGeneration(accountId, {
    brandId: input.brandId ?? null,
    kind: input.kind,
    sourceTool: input.sourceTool,
    prompt: input.prompt ?? null,
    model: input.model ?? null,
    storagePath,
    mimeType: input.mimeType,
    bytes: input.bytes.byteLength,
  });
  return { url, storagePath, generationId: row.id };
}

/**
 * The externally-hosted-video counterpart to recordMediaGeneration. Higgsfield
 * hosts the video — nothing is uploaded to our bucket, so there is no quota
 * check (bytes=0 never counts against GENERATION_QUOTA_BYTES) and no
 * storage_path, only external_url. Still goes through recordGeneration so a
 * rendered video appears in the same ledger, reviewable the same way, and
 * still ages out under the same retention policy if never approved.
 */
export async function recordExternalVideoGeneration(accountId: string, input: {
  sourceTool: string;
  prompt?: string | null;
  model?: string | null;
  brandId?: string | null;
  externalUrl: string;
}): Promise<{ generationId: string }> {
  const row = await recordGeneration(accountId, {
    brandId: input.brandId ?? null,
    kind: 'video',
    sourceTool: input.sourceTool,
    prompt: input.prompt ?? null,
    model: input.model ?? null,
    externalUrl: input.externalUrl,
    bytes: 0,
  });
  return { generationId: row.id };
}

/**
 * Two separate jobs, run in sequence, sharing one time budget — the ROW's
 * lifetime and the OBJECT's lifetime are governed differently and must never
 * be conflated (a published row must NEVER be deleted; only its object may
 * be):
 *
 *   JOB A — expired rows (PENDING aged out unreviewed, or REJECTED aged
 *   out). Deletes the storage object (if any) AND the row itself. Matches
 *   `expires_at < now()`; an APPROVED row (published or not) always has
 *   expires_at NULL (reviewGeneration clears it), so this job structurally
 *   cannot reach one — reinforced with an explicit review_state exclusion
 *   below rather than relying on that alone.
 *
 *   JOB B — published, past their grace period. Deletes ONLY the storage
 *   object (storage_path -> NULL, purged_at -> now()); the ROW SURVIVES with
 *   its prompt, model, review history and channel_url intact. Matches
 *   APPROVED rows with published_at set, an object still present, and a
 *   channel_url to send the user to — a row with published_at set but no
 *   channel_url is never produced by markGenerationPublished (see its
 *   comment) and this query would skip it anyway rather than purge a dead
 *   end.
 *
 * Time-bounded by `deadlineMs` (an absolute Date.now() cutoff, not a
 * duration — matches every other budget in this codebase, e.g. hermes tick's
 * `deadline`) so a large backlog cannot run unbounded; stops starting new
 * batches once the deadline passes and returns however many it got through.
 * Called by the lowest-priority step of the Hermes tick
 * (app/api/hermes/tick/route.ts) — see that file for why.
 */
export async function purgeExpiredGenerations(deadlineMs: number): Promise<{
  deletedRows: number;
  deletedObjects: number;
  publishedPurged: number;
}> {
  let deletedRows = 0;
  let deletedObjects = 0;
  let publishedPurged = 0;
  const BATCH = 50;

  // --- Job A: expired PENDING/REJECTED rows — delete object AND row. ---
  while (Date.now() < deadlineMs) {
    const { data, error } = await supabase
      .from('generations')
      .select('id, storage_path')
      .lt('expires_at', new Date().toISOString())
      .neq('review_state', 'APPROVED') // belt-and-suspenders — see header
      .limit(BATCH);
    if (error || !data || !data.length) break;

    const paths = data.map((r: any) => r.storage_path).filter((p: any): p is string => !!p);
    if (paths.length) {
      deletedObjects += await removeObjects(GENERATED_BUCKET, paths).catch(() => 0);
    }

    const ids = data.map((r: any) => r.id);
    const { error: delErr, count } = await supabase
      .from('generations')
      .delete({ count: 'exact' })
      .in('id', ids);
    if (!delErr) deletedRows += count ?? ids.length;

    if (data.length < BATCH) break; // last (partial) batch — nothing more to fetch
  }

  // --- Job B: published, past grace — delete object ONLY, row survives. ---
  const graceCutoff = new Date(Date.now() - GENERATION_PUBLISH_GRACE_DAYS * 864e5).toISOString();
  while (Date.now() < deadlineMs) {
    const { data, error } = await supabase
      .from('generations')
      .select('id, storage_path')
      .eq('review_state', 'APPROVED')
      .not('published_at', 'is', null)
      .lt('published_at', graceCutoff)
      .is('purged_at', null)
      .not('storage_path', 'is', null)
      .not('channel_url', 'is', null)
      .limit(BATCH);
    if (error || !data || !data.length) break;

    for (const row of data) {
      const removed = await removeObjects(GENERATED_BUCKET, [row.storage_path]).catch(() => 0);
      if (!removed) continue; // couldn't confirm deletion — leave the row pointing at it, retry next tick
      const { error: upErr } = await supabase
        .from('generations')
        .update({ storage_path: null, purged_at: new Date().toISOString() })
        .eq('id', row.id);
      if (!upErr) {
        deletedObjects += removed;
        publishedPurged += 1;
      }
    }

    if (data.length < BATCH) break;
  }

  return { deletedRows, deletedObjects, publishedPurged };
}
