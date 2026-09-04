// Generations capabilities — the review surface for media the assistant made.
//
// SCOPE: image/video only. Text content already has content_items and its
// IDEATION → ... → PUBLISHED lifecycle (lib/content/store.ts) — a second
// review surface for text would duplicate that, not close a gap.
//
// This module never writes content_items directly — promoteGenerationToContent
// reuses createContentItem/updateContentItem (lib/capabilities/content.ts's
// backing store, lib/content/store.ts) for that write, and only records the
// link back on the generations row via lib/generations/store.ts.

import { z } from 'zod';
import {
  listGenerations, getGeneration, reviewGeneration, resolveGenerationUrl,
  linkGenerationToContentItem,
  type ReviewState, type GenerationKind,
} from '@/lib/generations/store';
import { createContentItem, updateContentItem, CONTENT_STATUSES } from '@/lib/content/store';
import { obj, S, type Capability, plural, tally, digestLine } from './types';

const REVIEW_STATES: ReviewState[] = ['PENDING', 'APPROVED', 'REJECTED'];
const KINDS: GenerationKind[] = ['image', 'video'];

export const GENERATIONS_CAPABILITIES: Capability[] = [
  {
    name: 'listGenerations',
    domain: 'generations',
    title: 'List generated media',
    description: `List generated images and videos — what the assistant has made, its review state (${REVIEW_STATES.join(', ')}), and where it lives. Filter by venture, review state, or kind (image/video). Use this before reviewGeneration to find what needs a decision, or when the user asks what has been generated.`,
    gate: 'read',
    inputSchema: obj({ brandId: S.string, reviewState: S.string, kind: S.string, limit: S.number }),
    zod: z.object({
      brandId: z.string().optional(),
      reviewState: z.enum(REVIEW_STATES as [string, ...string[]]).optional(),
      kind: z.enum(KINDS as [string, ...string[]]).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    run: async (accountId, a) => {
      const rows = await listGenerations(accountId, a as any);
      // Every row gets a fresh, display-ready URL here — the caller (chat)
      // never signs one itself, and a signed URL is never stored (see
      // resolveGenerationUrl's comment).
      return Promise.all(rows.map(async (r) => ({ ...r, url: await resolveGenerationUrl(r) })));
    },
    digest: (_a, result) => {
      const rows = Array.isArray(result) ? result : null;
      if (!rows) return '';
      if (!rows.length) return 'No generations recorded yet.';
      const byState = tally(rows, 'review_state');
      const byKind = tally(rows, 'kind');
      return digestLine(
        `${plural(rows.length, 'generation')}.`,
        byState ? `By review state: ${byState}.` : null,
        byKind ? `By kind: ${byKind}.` : null,
      );
    },
  },
  {
    name: 'reviewGeneration',
    domain: 'generations',
    title: 'Approve or reject a generation',
    description: "Approve or reject one generated image or video. Approving keeps it (it stops ageing toward automatic deletion, until it is published to a channel — see promoteGenerationToContent). Rejecting leaves it on its original retention schedule so it ages out. Call listGenerations first for the id.",
    gate: 'internal_write',
    inputSchema: obj({ generationId: S.string, decision: S.string, note: S.string }, ['generationId', 'decision']),
    zod: z.object({
      generationId: z.string().min(1),
      decision: z.enum(['APPROVED', 'REJECTED']),
      note: z.string().max(500).optional(),
    }),
    run: async (accountId, a) => {
      const row = await reviewGeneration(accountId, a.generationId, a.decision as 'APPROVED' | 'REJECTED', a.note ?? null);
      return { ...row, url: await resolveGenerationUrl(row) };
    },
    digest: (a, result) => {
      const r: any = result;
      if (!r?.id) return '';
      return digestLine(
        a?.decision === 'APPROVED'
          ? `Generation approved and kept.`
          : `Generation rejected — it will age out on its original schedule.`,
        a?.note ? `Note: ${String(a.note).slice(0, 120)}` : null,
      );
    },
  },
  {
    name: 'promoteGenerationToContent',
    domain: 'generations',
    title: 'Queue an approved generation for posting',
    description: "Put an approved generated image/video onto the content board so it can be scheduled and published. Give the generation's id (must already be APPROVED — call reviewGeneration first) and either a contentItemId to attach it to an existing piece, or a title/platforms to create a new one. Links the generation to the content item it produces, both ways.",
    gate: 'internal_write',
    inputSchema: obj({
      generationId: S.string, contentItemId: S.string, title: S.string, brandId: S.string,
      platforms: { type: 'array', items: S.string }, hook: S.string, body: S.string, cta: S.string,
      status: S.string,
    }, ['generationId']),
    zod: z.object({
      generationId: z.string().min(1),
      contentItemId: z.string().optional(),
      title: z.string().max(200).optional(),
      brandId: z.string().optional(),
      platforms: z.array(z.string()).optional(),
      hook: z.string().optional(),
      body: z.string().optional(),
      cta: z.string().optional(),
      status: z.enum(CONTENT_STATUSES as [string, ...string[]]).optional(),
    }),
    run: async (accountId, a) => {
      const gen = await getGeneration(accountId, a.generationId);
      if (!gen) throw new Error('No generation with that id for this account.');
      if (gen.review_state !== 'APPROVED') {
        throw new Error('Only an APPROVED generation can be queued for posting — call reviewGeneration first.');
      }
      const mediaUrl = await resolveGenerationUrl(gen);
      if (!mediaUrl) throw new Error('Could not resolve a URL for this generation — the stored file may be missing.');

      const item = a.contentItemId
        ? await updateContentItem(accountId, a.contentItemId, { media_url: mediaUrl })
        : await createContentItem(accountId, {
            title: a.title || `Generated ${gen.kind} — ${new Date(gen.created_at).toLocaleDateString()}`,
            brandId: a.brandId ?? gen.brand_id ?? null,
            platforms: a.platforms ?? [],
            hook: a.hook ?? null,
            body: a.body ?? null,
            cta: a.cta ?? null,
            mediaUrl,
            status: a.status ?? 'APPROVED',
          });

      const linked = await linkGenerationToContentItem(accountId, a.generationId, item.id);
      return { contentItemId: item.id, generation: linked, mediaUrl };
    },
    digest: (_a, result) => {
      const r: any = result;
      if (!r?.contentItemId) return '';
      return digestLine(`Queued on the content board as ${r.contentItemId}.`);
    },
  },
];

