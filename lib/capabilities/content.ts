// Content engine capabilities — the board, the pillars, the platform specs,
// the character references, and the generator that uses all four.
//
// The through-line: before this, "write me a LinkedIn post" produced a blob
// from a model that knew the platform only as a string, knew the brand only as
// a name, and left nothing behind. Now it produces a grounded piece that lands
// on a board with a lifecycle, a pillar, and an angle — and the constraints it
// obeyed are facts stored in the workspace rather than guesses.

import { z } from 'zod';
import {
  listPillars, createPillar, deletePillar,
  listPlatformSpecs, getPlatformSpec, upsertPlatformSpec,
  listCharacterRefs, getCharacterRef, createCharacterRef, resolveCharacterRefUrl,
  createContentItem, listContentItems, getContentItem, updateContentItem,
  setContentStatus, deleteContentItem, contentBoardSummary,
  CONTENT_STATUSES, FUNNEL_STAGES,
} from '@/lib/content/store';
import { generateContent } from '@/lib/content/engine';
import { loadCanon, saveCanon, scoreLinearity } from '@/lib/content/canon';
import { runResearchSweep, listFindings, RESEARCH_PASSES } from '@/lib/content/research';
import { syncPerformance, performanceReport } from '@/lib/content/performance';
import { proposeLearning } from '@/lib/content/learning';
import { runIntake, proposeCanon } from '@/lib/content/intake';
import { generateImage as routeImage } from '@/lib/ai/image-router';
import { generateVideo, getVideoStatus, higgsfieldUnavailableReason } from '@/lib/integrations/higgsfield';
import { uploadGenerated } from '@/lib/storage';
import { obj, S, type Capability, rowsOf, plural, samples, tally, digestLine } from './types';

export const CONTENT_CAPABILITIES: Capability[] = [
  // ------------------------------------------------------------- the board
  {
    name: 'listContentItems',
    domain: 'content',
    title: 'List content items',
    description: `Read the content board — every planned, drafted and published piece, newest first. Filter by status (${CONTENT_STATUSES.join(', ')}), by venture, or by platform. Use whenever the user asks what content exists, what is in draft, or what is ready to go out.`,
    gate: 'read',
    inputSchema: obj({ status: S.string, brandId: S.string, platform: S.string, limit: S.number, intent: S.string }),
    zod: z.object({
      status: z.enum(CONTENT_STATUSES as [string, ...string[]]).optional(),
      brandId: z.string().optional(),
      platform: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      intent: z.enum(['organic', 'paid']).optional(),
    }),
    run: (accountId, a) => listContentItems(accountId, a),
    digest: (_a, result) => {
      const rows = rowsOf(result);
      if (!rows) return '';
      if (!rows.length) return 'Nothing on the content board.';
      return digestLine(
        `${plural(rows.length, 'content item')}.`,
        tally(rows, 'status') ? `${tally(rows, 'status')}.` : null,
        `Titles: ${samples(rows, ['title'], 5).join(', ')}`,
      );
    },
  },
  {
    name: 'getContentBoard',
    domain: 'content',
    title: 'Summarise the content board',
    description: 'Counts per stage across the content board — how much is in ideation, draft, approved, queued, published. Use to answer "where does content stand?" without pulling every piece.',
    gate: 'read',
    inputSchema: obj({ brandId: S.string }),
    zod: z.object({ brandId: z.string().optional() }),
    run: (accountId, a) => contentBoardSummary(accountId, a?.brandId),
  },
  {
    name: 'getContentItem',
    domain: 'content',
    title: 'Read a content item',
    description: 'Read one piece of content in full — hook, body, CTA, hashtags, pillar, angle, and where it stands. Needs the id from listContentItems.',
    gate: 'read',
    inputSchema: obj({ itemId: S.string }, ['itemId']),
    zod: z.object({ itemId: z.string().min(1) }),
    run: async (accountId, a) => {
      const row = await getContentItem(accountId, a.itemId);
      if (!row) throw new Error('No content item with that id for this account.');
      return row;
    },
  },
  {
    name: 'createContentItem',
    domain: 'content',
    title: 'Add a content item',
    description: 'Put a piece of content on the board by hand — an idea, an outline, or copy the user has already written. For generating one, use generateContentPiece instead, which grounds it in the brand and platform.',
    gate: 'internal_write',
    inputSchema: obj({
      title: S.string, brandId: S.string, status: S.string, contentType: S.string,
      platforms: { type: 'array', items: S.string }, funnelStage: S.string,
      keyAngle: S.string, hook: S.string, body: S.string, cta: S.string,
    }, ['title']),
    zod: z.object({
      title: z.string().min(1).max(200),
      brandId: z.string().optional(),
      status: z.enum(CONTENT_STATUSES as [string, ...string[]]).optional(),
      contentType: z.string().optional(),
      platforms: z.array(z.string()).optional(),
      funnelStage: z.enum(FUNNEL_STAGES as unknown as [string, ...string[]]).optional(),
      keyAngle: z.string().optional(),
      hook: z.string().optional(),
      body: z.string().optional(),
      cta: z.string().optional(),
    }),
    run: (accountId, a) => createContentItem(accountId, a as any),
  },
  {
    name: 'updateContentItem',
    domain: 'content',
    title: 'Edit a content item',
    description: 'Change a piece of content on the board — its copy, its platforms, its angle, when it is scheduled. To move it between stages use setContentStatus.',
    gate: 'internal_write',
    inputSchema: obj({
      itemId: S.string, title: S.string, hook: S.string, body: S.string, cta: S.string,
      keyAngle: S.string, platforms: { type: 'array', items: S.string },
      hashtags: { type: 'array', items: S.string }, scheduledFor: S.string,
    }, ['itemId']),
    zod: z.object({
      itemId: z.string().min(1),
      title: z.string().max(200).optional(),
      hook: z.string().optional(),
      body: z.string().optional(),
      cta: z.string().optional(),
      keyAngle: z.string().optional(),
      platforms: z.array(z.string()).optional(),
      hashtags: z.array(z.string()).optional(),
      scheduledFor: z.string().optional(),
    }),
    run: async (accountId, a) => {
      const { itemId, scheduledFor, keyAngle, ...rest } = a;
      const patch: Record<string, any> = { ...rest };
      if (scheduledFor !== undefined) patch.scheduled_for = scheduledFor;
      if (keyAngle !== undefined) patch.key_angle = keyAngle;
      if (!Object.keys(patch).length) throw new Error('Nothing to update — give at least one field.');
      return updateContentItem(accountId, itemId, patch);
    },
  },
  {
    name: 'setContentStatus',
    domain: 'content',
    title: 'Move a content item',
    description: `Move a piece along the board: ${CONTENT_STATUSES.join(' → ')}. Moving to APPROVED means a human signed it off; moving to PUBLISHED only records that it went out — it does NOT publish anything. Use publishSocialPost or scheduleSocialPost to actually send it.`,
    gate: 'internal_write',
    inputSchema: obj({ itemId: S.string, status: S.string }, ['itemId', 'status']),
    zod: z.object({
      itemId: z.string().min(1),
      status: z.enum(CONTENT_STATUSES as [string, ...string[]]),
    }),
    run: (accountId, a) => setContentStatus(accountId, a.itemId, a.status as any),
  },
  {
    name: 'deleteContentItem',
    domain: 'content',
    title: 'Delete a content item',
    description: 'Permanently remove a piece from the content board. Prefer moving it to ARCHIVED unless the user asks to delete it.',
    gate: 'destructive',
    inputSchema: obj({ itemId: S.string }, ['itemId']),
    zod: z.object({ itemId: z.string().min(1) }),
    run: (accountId, a) => deleteContentItem(accountId, a.itemId),
    summarize: (a) => `Permanently delete content item ${a.itemId}. This cannot be undone.`,
  },

  // -------------------------------------------------------------- generation
  {
    name: 'generateContentPiece',
    domain: 'content',
    title: 'Generate a content piece',
    description: "Write one publish-ready piece of content, held to the brand THESIS and grounded in the venture's brand kit, the platform's real constraints (character limit, hashtag convention, CTA format) and the next content pillar in rotation. Returns the hook, body and CTA separately. Saves it to the content board as a DRAFT unless you say otherwise. Set intent to 'paid' for an ad — direct response, substantiable claims, one hard ask — or leave it 'organic' for content that earns attention. These are different briefs, not the same brief reworded. This is the right tool for any real content request — it knows the constraints, a plain chat answer does not.",
    gate: 'internal_write',
    inputSchema: obj({
      topic: S.string, platform: S.string, brandId: S.string, pillarId: S.string,
      funnelStage: S.string, hook: S.string, cta: S.string, save: { type: 'boolean' },
      intent: S.string,
    }, ['topic', 'platform']),
    zod: z.object({
      topic: z.string().min(3).max(500),
      platform: z.string().min(1),
      brandId: z.string().optional(),
      pillarId: z.string().optional(),
      funnelStage: z.enum(FUNNEL_STAGES as unknown as [string, ...string[]]).optional(),
      hook: z.string().optional(),
      cta: z.string().optional(),
      save: z.boolean().optional(),
      intent: z.enum(['organic', 'paid']).optional(),
    }),
    run: async (accountId, a) => {
      const piece = await generateContent({ accountId, ...a });
      if (a.save === false) return piece;
      const item = await createContentItem(accountId, {
        title: piece.title,
        brandId: a.brandId ?? null,
        status: 'DRAFT',
        contentType: 'Social',
        intent: a.intent ?? 'organic',
        linearityScore: piece.linearity?.score ?? null,
        linearityReport: piece.linearity ?? null,
        platforms: [piece.platform],
        pillarId: piece.pillarId,
        pillar: piece.pillar,
        funnelStage: a.funnelStage ?? null,
        keyAngle: piece.keyAngle,
        targetAudience: piece.targetAudience,
        hook: piece.hook,
        body: piece.body,
        cta: piece.cta,
        hashtags: piece.hashtags,
        imagePrompt: piece.imagePrompt,
      });
      return { ...piece, itemId: item.id };
    },
    observationLimit: 16_000,
    digest: (a, result) => {
      const r: any = result;
      if (!r?.hook) return '';
      // The evaluator's blocking issues are stated first and plainly. A digest
      // that leads with "wrote a piece" and buries "it is 800 characters over
      // and will be truncated" is how flawed work gets presented as finished.
      const ev = r.evaluation;
      const blocks: string[] = Array.isArray(ev?.issues)
        ? ev.issues.filter((i: any) => i?.severity === 'block').map((i: any) => String(i.message))
        : [];
      const warns: string[] = Array.isArray(ev?.issues)
        ? ev.issues.filter((i: any) => i?.severity === 'warn').map((i: any) => String(i.message))
        : [];
      const beats = Array.isArray(r.production?.beats) ? r.production.beats.length : 0;

      return digestLine(
        `Wrote a ${r.platform} piece${r.pillar ? ` on the "${r.pillar}" pillar` : ''}: "${String(r.hook).slice(0, 100)}"`,
        r.formatFamily === 'short_video' && beats
          ? `Shot as short-form video: ${plural(beats, 'beat')}${r.production?.openingFrame ? ', with an opening frame' : ''}.`
          : null,
        r.formatFamily === 'visual' && Array.isArray(r.production?.slides) && r.production.slides.length > 1
          ? `${plural(r.production.slides.length, 'slide')} in the carousel.`
          : null,
        blocks.length
          ? `NOT READY — ${blocks.join(' ')} Say this plainly rather than presenting it as finished.`
          : null,
        // Only when nothing blocks: a list of nits under a "not ready" line
        // reads as equally important and dilutes the thing that matters.
        !blocks.length && warns.length ? `Worth fixing: ${warns.slice(0, 3).join(' ')}` : null,
        r.itemId ? `Saved to the board as a draft (${r.itemId}).` : null,
      );
    },
  },

  // ------------------------------------------------------------------ media
  {
    name: 'generateBrandImage',
    domain: 'content',
    title: 'Generate an on-brand image',
    description: "Generate an image that keeps a recurring character consistent. Pass characterRefId and the character's face, wardrobe and art style are held identical to the saved reference — describe only what CHANGES (the setting, the action). Without a characterRefId this is ordinary text-to-image. Use this, not generateImage, whenever a brand avatar or recurring person is in the shot.",
    gate: 'internal_write',
    inputSchema: obj({ prompt: S.string, characterRefId: S.string, caption: S.string, aspect: S.string }, ['prompt']),
    zod: z.object({
      prompt: z.string().min(3).max(2000),
      characterRefId: z.string().optional(),
      caption: z.string().max(300).optional(),
      aspect: z.string().max(16).optional(),
    }),
    run: async (accountId, a) => {
      let referenceUrls: string[] | undefined;
      let styleLock: string | undefined;
      let prompt = a.prompt;
      if (a.characterRefId) {
        const ref = await getCharacterRef(accountId, a.characterRefId);
        if (!ref) throw new Error('No character reference with that id for this account.');
        referenceUrls = [await resolveCharacterRefUrl(ref)];
        styleLock = ref.style_lock || undefined;
        // The invariant description leads, the scene follows — the same order
        // the reference system uses everywhere: who they are never varies,
        // only what they are doing.
        prompt = `${ref.description}\n\nScene: ${a.prompt}`;
      }
      const img = await routeImage({ prompt, caption: a.caption, aspect: a.aspect, referenceUrls, styleLock });
      const { storagePath, url } = await uploadGenerated(accountId, Buffer.from(img.base64, 'base64'), img.mimeType);
      // Both travel forward: `url` is a freshly signed link for immediate
      // display, `storagePath` is the stable identifier — pass THIS to
      // createCharacterRef so the character reference re-signs at use time
      // instead of persisting a URL that expires (see GENERATED_URL_TTL).
      return { url, storagePath, mimeType: img.mimeType, conditioned: Boolean(referenceUrls) };
    },
    digest: (_a, result) => {
      const r: any = result;
      if (!r?.url) return '';
      return digestLine(`Image generated: ${r.url}`, r.conditioned ? 'Held to the saved character reference.' : null);
    },
  },
  {
    name: 'listCharacterRefs',
    domain: 'content',
    title: 'List character references',
    description: 'List the saved character references — the anchor images that keep a recurring avatar or presenter looking the same across every generated image and video. Call before generateBrandImage or generateBrandVideo to get the id.',
    gate: 'read',
    inputSchema: obj({ brandId: S.string }),
    zod: z.object({ brandId: z.string().optional() }),
    run: (accountId, a) => listCharacterRefs(accountId, a?.brandId),
    digest: (_a, result) => {
      const rows = rowsOf(result);
      if (!rows) return '';
      if (!rows.length) return 'No character references saved — a recurring character will drift between generations until one exists.';
      return digestLine(`${plural(rows.length, 'character reference')}.`, `Named: ${samples(rows, ['name'], 5).join(', ')}`);
    },
  },
  {
    name: 'createCharacterRef',
    domain: 'content',
    title: 'Save a character reference',
    description: "Save an anchor image as a reusable character reference so a recurring avatar or presenter stays identical across every future generation. Needs the image URL, plus the fixed description of who they are (face, build, wardrobe, art style) that travels with every use. Generate the anchor image first with generateBrandImage, then save it here — pass through BOTH the `url` and `storagePath` generateBrandImage returned (storagePath lets the reference re-sign a fresh link every time it's reused instead of relying on a link that expires) — never re-generate the character from text later.",
    gate: 'internal_write',
    inputSchema: obj({ name: S.string, imageUrl: S.string, storagePath: S.string, description: S.string, styleLock: S.string, brandId: S.string }, ['name', 'imageUrl', 'description']),
    zod: z.object({
      name: z.string().min(1).max(120),
      imageUrl: z.string().min(1),
      storagePath: z.string().min(1).optional(),
      description: z.string().min(10).max(2000),
      styleLock: z.string().max(500).optional(),
      brandId: z.string().optional(),
    }),
    run: (accountId, a) => createCharacterRef(accountId, a),
  },
  {
    name: 'generateBrandVideo',
    domain: 'content',
    title: 'Generate a video',
    description: "Animate a still image into a short video, optionally with the subject speaking a line to camera (lip-synced). Give the URL of the image to animate and describe what MOVES — camera motion, gesture, action — not who the subject is; the image already fixes that. Pair it with an image made from a character reference so the person on screen matches the stills. Renders take minutes. Runs through the account's Higgsfield MCP connection.",
    gate: 'internal_write',
    inputSchema: obj({ imageUrl: S.string, prompt: S.string, dialogue: S.string }, ['imageUrl', 'prompt']),
    zod: z.object({
      imageUrl: z.string().min(1),
      prompt: z.string().min(3).max(1000),
      dialogue: z.string().max(600).optional(),
    }),
    run: async (accountId, a) => {
      // The reason is looked up rather than assumed: "not connected" and
      // "connected but switched off" are different problems with different
      // fixes, and the earlier version of this told people to set an API key
      // that Higgsfield does not issue.
      const blocked = await higgsfieldUnavailableReason(accountId);
      if (blocked) return { error: blocked };
      try {
        return await generateVideo(accountId, { imageUrl: a.imageUrl, prompt: a.prompt, dialogue: a.dialogue });
      } catch (e: any) {
        return { error: e?.message || 'The video render failed.' };
      }
    },
    digest: (_a, result) => {
      const r: any = result;
      if (r?.error) return digestLine(`Video not generated: ${r.error}`);
      return r?.url ? digestLine(`Video rendered: ${r.url}`) : '';
    },
  },
  {
    name: 'getVideoStatus',
    domain: 'content',
    title: 'Check a video render',
    description: 'Check on a video render that was still going when you last looked. Needs the request id from the earlier attempt. A render that timed out is still running — this is how you pick it up rather than paying to start it again.',
    gate: 'read',
    inputSchema: obj({ requestId: S.string }, ['requestId']),
    zod: z.object({ requestId: z.string().min(1) }),
    run: async (accountId, a) => {
      const blocked = await higgsfieldUnavailableReason(accountId);
      if (blocked) return { error: blocked };
      try {
        const { status, url } = await getVideoStatus(accountId, a.requestId);
        return { status, url };
      } catch (e: any) {
        return { error: e?.message || 'Could not read the render status.' };
      }
    },
  },

  // ------------------------------------------------------------ performance
  //
  // The loop was open: the engine generated, scored and published, and then
  // nothing ever checked whether the judgement it made at the moment of
  // writing turned out to be right.
  {
    name: 'syncContentPerformance',
    domain: 'content',
    title: 'Pull live metrics for published content',
    description:
      "Read likes, comments and shares for content already published to a connected Instagram or Facebook account, and store them against the board. Matches by the recorded post id only — an item published without one cannot be matched and is reported rather than guessed at. Use before reporting on how content is doing, or when the user asks what worked.",
    gate: 'read',
    inputSchema: obj({ brandId: S.string, limit: S.number }, []),
    zod: z.object({ brandId: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }),
    run: (accountId, a) => syncPerformance({ accountId, ...a }),
    digest: (_a, result) => {
      const r: any = result;
      if (!r || typeof r.updated !== 'number') return '';
      return digestLine(
        r.updated ? `Metrics updated for ${plural(r.updated, 'published piece')}.` : 'No published piece could be matched to a live post.',
        // Named, not swallowed. Metrics for 3 of 20 published items look
        // identical to 20 items performing badly once the gap is invisible.
        Array.isArray(r.unmatched) && r.unmatched.length
          ? `${plural(r.unmatched.length, 'item')} could not be matched: ${r.unmatched.slice(0, 3).map((u: any) => `"${String(u.title).slice(0, 40)}" (${u.reason})`).join('; ')}. Say so rather than reporting only on what matched.`
          : null,
      );
    },
  },
  {
    name: 'getContentPerformance',
    domain: 'content',
    title: 'What the numbers suggest',
    description:
      "Summarise how published content has performed, grouped by pillar and platform, using median engagement. Returns OBSERVATIONS, not instructions — and stays silent where the sample is too small to support a claim rather than ranking three posts and calling it a result. Use when the user asks what is working. Never treat the top row as a directive to change the brand's canon; that is a decision the user makes.",
    gate: 'read',
    inputSchema: obj({ brandId: S.string }, []),
    zod: z.object({ brandId: z.string().optional() }),
    run: (accountId, a) => performanceReport({ accountId, ...a }),
    digest: (_a, result) => {
      const r: any = result;
      if (!r || typeof r.scored !== 'number') return '';
      const obs = Array.isArray(r.observations) ? r.observations : [];
      const caveats = Array.isArray(r.caveats) ? r.caveats : [];
      if (!obs.length) {
        return digestLine(caveats.length ? caveats.join(' ') : 'No published content has metrics on file yet.');
      }
      return digestLine(
        `Across ${plural(r.scored, 'published piece')}: ${obs.slice(0, 4).map((o: any) => `${o.value} (${o.dimension}, median ${o.medianEngagement} over ${o.sample})`).join(', ')}.`,
        'These are observations over a small sample, not a strategy. Present them that way.',
        caveats.length ? caveats.join(' ') : null,
      );
    },
  },

  {
    name: 'proposeContentLearnings',
    domain: 'content',
    title: 'What the results might mean',
    description:
      "Look at how published content performed and propose what to change — as SUGGESTIONS a person accepts, never as changes. This writes nothing: not to the brand canon, not to the pillars, not to the platform specs. Use when the user asks what they should do differently. Present every proposal with its evidence and its confidence, and never describe one as applied. If it returns nothing, say the data does not support a change yet rather than reaching for a suggestion.",
    gate: 'read',
    inputSchema: obj({ brandId: S.string }, []),
    zod: z.object({ brandId: z.string().optional() }),
    run: (accountId, a) => proposeLearning({ accountId, ...a }),
    digest: (_a, result) => {
      const r: any = result;
      if (!r || !Array.isArray(r.proposals)) return '';
      if (!r.proposals.length) {
        return digestLine(
          'Nothing in the results supports a change yet.',
          Array.isArray(r.caveats) && r.caveats.length ? r.caveats.join(' ') : null,
        );
      }
      return digestLine(
        `${plural(r.proposals.length, 'suggestion')}: ${r.proposals.map((p: any) => `${p.suggestion} (${p.evidence}, ${p.confidence} confidence)`).join(' ')}`,
        Array.isArray(r.caveats) && r.caveats.length ? r.caveats.join(' ') : null,
        // Restated in the digest itself so it cannot be lost between the data
        // and the moment someone decides to act on it.
        r.governance,
      );
    },
  },

  // ---------------------------------------------------------------- pillars
  {
    name: 'startBrandIntake',
    domain: 'content',
    title: 'Set up a venture from a description',
    description:
      "THE FRONT DOOR. Take what the user says they are building and turn it into a grounded venture: records their description verbatim, then runs four research passes in parallel — what competitors say, what the platforms are rewarding, what people search for, and how the audience talks about the problem. Findings are stored so later work does not repeat the sweep. Use this when someone describes a new brand, product or venture, or when an existing one has no research on file. Ask for competitors if they have not named any; the sweep is much better with them. This does NOT set the brand's beliefs — call proposeBrandCanon afterwards and show the user what it drafted.",
    gate: 'internal_write',
    inputSchema: obj({
      description: S.string, brandId: S.string,
      competitors: { type: 'array', items: S.string },
      audience: S.string, offer: S.string,
    }, ['description']),
    zod: z.object({
      description: z.string().min(20).max(4000),
      brandId: z.string().optional(),
      competitors: z.array(z.string()).max(8).optional(),
      audience: z.string().max(600).optional(),
      offer: z.string().max(600).optional(),
    }),
    run: (accountId, a) => runIntake({ accountId, ...a }),
    observationLimit: 20_000,
    digest: (_a, result) => {
      const r: any = result;
      if (!r || typeof r !== 'object' || !r.research) return '';
      const f = Array.isArray(r.research.findings) ? r.research.findings : [];
      const gaps = Array.isArray(r.research.gaps) ? r.research.gaps : [];
      if (!f.length && !gaps.length) return '';
      return digestLine(
        f.length ? `${plural(f.length, 'research finding')} stored.` : 'The sweep found nothing usable.',
        // Gaps are named, never swallowed: a pass that failed silently reads to
        // the user as a pass that found nothing to say.
        gaps.length ? `Could not cover: ${gaps.map((g: any) => `${g.pass} (${g.reason})`).join('; ')}.` : null,
        f.length ? `Sample: ${f.slice(0, 3).map((x: any) => String(x.finding).slice(0, 100)).join(' | ')}` : null,
      );
    },
  },
  {
    name: 'runBrandResearch',
    domain: 'content',
    title: 'Research a venture',
    description: `Run the research passes for a venture and store what they find: ${RESEARCH_PASSES.join(', ')}. Use to refresh stale research, or to run one pass on its own when the user asks a specific question about competitors, trends, search demand or audience language. Findings supersede the previous set for the same passes rather than deleting it.`,
    gate: 'read',
    inputSchema: obj({
      subject: S.string, brandId: S.string,
      competitors: { type: 'array', items: S.string },
      passes: { type: 'array', items: S.string },
    }, ['subject']),
    zod: z.object({
      subject: z.string().min(5).max(1000),
      brandId: z.string().optional(),
      competitors: z.array(z.string()).max(8).optional(),
      passes: z.array(z.enum(['competitor', 'trend', 'search', 'audience'])).optional(),
    }),
    run: (accountId, a) => runResearchSweep({ accountId, ...a }),
    observationLimit: 20_000,
    digest: (_a, result) => {
      const r: any = result;
      if (!r || typeof r !== 'object') return '';
      const f = Array.isArray(r.findings) ? r.findings : [];
      const gaps = Array.isArray(r.gaps) ? r.gaps : [];
      if (!f.length && !gaps.length) return '';
      return digestLine(
        f.length ? `${plural(f.length, 'finding')}.` : 'Nothing usable came back.',
        gaps.length ? `Gaps: ${gaps.map((g: any) => g.pass).join(', ')}.` : null,
      );
    },
  },
  {
    name: 'listResearchFindings',
    domain: 'content',
    title: 'Read stored research',
    description: 'Read the research on file for a venture — what was found about competitors, trends, search demand and audience language, with the source of each. Use before writing content or strategy so you build on what is known rather than searching again.',
    gate: 'read',
    inputSchema: obj({ brandId: S.string, pass: S.string }),
    zod: z.object({
      brandId: z.string().optional(),
      pass: z.enum(['competitor', 'trend', 'search', 'audience']).optional(),
    }),
    run: (accountId, a) => listFindings(accountId, a?.brandId, a?.pass as any),
    observationLimit: 16_000,
    digest: (_a, result) => {
      const rows = rowsOf(result);
      if (!rows) return '';
      if (!rows.length) return 'No research on file for that venture — run startBrandIntake or runBrandResearch first.';
      return digestLine(
        `${plural(rows.length, 'stored finding')}.`,
        tally(rows, 'pass') ? `${tally(rows, 'pass')}.` : null,
      );
    },
  },
  {
    name: 'proposeBrandCanon',
    domain: 'content',
    title: 'Draft what the brand stands for',
    description:
      "Draft a brand canon from the venture's description and stored research — a core thesis, the belief it argues against, the takeaway, owned and banned words, and 3-5 content pillars. This PROPOSES only and saves nothing. Show the user what it drafted, in full, and let them correct it before you call setBrandCanon: a brand's core belief is a claim its owner has to recognise as theirs, not a fact you extract on their behalf. Always relay the caveats — they say where the research was thin.",
    gate: 'read',
    inputSchema: obj({ description: S.string, brandId: S.string }, ['description']),
    zod: z.object({ description: z.string().min(20).max(4000), brandId: z.string().optional() }),
    run: (accountId, a) => proposeCanon({ accountId, ...a }),
    observationLimit: 16_000,
    digest: (_a, result) => {
      const r: any = result;
      if (!r || typeof r !== 'object') return '';
      if (r.error) return digestLine(String(r.error));
      if (!r.coreThesis) return '';
      return digestLine(
        `Proposed thesis: "${String(r.coreThesis).slice(0, 200)}"`,
        r.brandEnemy ? `Against: ${String(r.brandEnemy).slice(0, 120)}` : null,
        Array.isArray(r.pillars) && r.pillars.length ? `${plural(r.pillars.length, 'pillar')} proposed.` : null,
        Array.isArray(r.caveats) && r.caveats.length ? `Caveats: ${r.caveats.join(' ')}` : null,
        'NOT SAVED — show this to the user and let them correct it before calling setBrandCanon.',
      );
    },
  },
  {
    name: 'getBrandCanon',
    domain: 'content',
    title: 'Read the brand thesis',
    description: "Read a venture's brand canon — the core thesis it asserts, the belief it argues against, the takeaway a reader should be left with, and the words it owns or refuses. This is what keeps content recognisably one brand across platforms. Use before writing anything substantial, or when the user asks what the brand stands for.",
    gate: 'read',
    inputSchema: obj({ brandId: S.string }, ['brandId']),
    zod: z.object({ brandId: z.string().min(1) }),
    run: (accountId, a) => loadCanon(accountId, a.brandId),
    digest: (_a, result) => {
      const r: any = result;
      // Null is "there was nothing to read", which the observation already
      // carries — a digest that narrates absence is inventing a finding.
      if (!r || typeof r !== 'object') return '';
      if (!r.coreThesis) return 'No thesis set — content for this venture is not held to one, so it will drift.';
      return digestLine(
        `Thesis: "${String(r.coreThesis).slice(0, 200)}"`,
        r.brandEnemy ? `Argues against: ${String(r.brandEnemy).slice(0, 120)}` : null,
        r.bannedTerms?.length ? `Banned: ${r.bannedTerms.join(', ')}` : null,
      );
    },
  },
  {
    name: 'setBrandCanon',
    domain: 'content',
    title: 'Set the brand thesis',
    description: "Define what a venture stands for, as a constraint every future piece is held to. coreThesis is the single non-negotiable claim; brandEnemy is the belief it argues against (a hook that agitates this is on-brand, one that ignores it is generic); anchorTakeaway is what a reader concludes even with the logo removed; bannedTerms are the generic words that dissolve the identity. Setting the thesis also embeds it, so later content can be scored for drift. Only set this from what the user actually told you — inventing a brand's beliefs is worse than leaving it empty.",
    gate: 'internal_write',
    inputSchema: obj({
      brandId: S.string, coreThesis: S.string, brandEnemy: S.string, anchorTakeaway: S.string,
      mandatoryLexicon: { type: 'array', items: S.string },
      bannedTerms: { type: 'array', items: S.string },
    }, ['brandId']),
    zod: z.object({
      brandId: z.string().min(1),
      coreThesis: z.string().min(10).max(600).optional(),
      brandEnemy: z.string().max(600).optional(),
      anchorTakeaway: z.string().max(600).optional(),
      mandatoryLexicon: z.array(z.string()).max(40).optional(),
      bannedTerms: z.array(z.string()).max(60).optional(),
    }),
    run: (accountId, a) => {
      const { brandId, ...rest } = a;
      return saveCanon(accountId, brandId, rest);
    },
    digest: (_a, result) => {
      const r: any = result;
      if (!r?.saved) return '';
      return digestLine(
        'Brand thesis saved.',
        r.embedded
          ? 'It is embedded, so future content is scored for drift against it.'
          : 'It could not be embedded, so drift scoring is unavailable until it is set again.',
      );
    },
  },
  {
    name: 'scoreContentLinearity',
    domain: 'content',
    title: 'Check copy against the brand thesis',
    description: "Score a piece of copy against a venture's brand thesis — semantic distance from the thesis plus any banned wording. Use before publishing something written by hand, or when the user asks whether a draft sounds like them. A low score means the copy has wandered off the argument, not that it phrased it differently: expressing the thesis natively for a platform is the goal, repeating it word-for-word is not.",
    gate: 'read',
    inputSchema: obj({ brandId: S.string, copy: S.string }, ['brandId', 'copy']),
    zod: z.object({ brandId: z.string().min(1), copy: z.string().min(10).max(20000) }),
    run: (accountId, a) => scoreLinearity(accountId, a.brandId, a.copy),
    digest: (_a, result) => {
      const r: any = result;
      // A score of `undefined` rendered as "undefined/10" — a number the digest
      // invented from a result that carried none. Report the verdict only when
      // there is actually a number behind it.
      if (!r || typeof r !== 'object' || typeof r.score !== 'number') return '';
      return digestLine(
        `${r.pass ? 'On brand' : 'OFF BRAND'} — ${r.score}/10.`,
        typeof r.thesisSimilarity === 'number' ? `Thesis similarity ${Number(r.thesisSimilarity).toFixed(2)}.` : null,
        Array.isArray(r.reasons) && r.reasons.length ? r.reasons.join(' ') : null,
      );
    },
  },
  {
    name: 'listContentPillars',
    domain: 'content',
    title: 'List content pillars',
    description: 'List the content pillars — the recurring themes content rotates through so a feed does not become one idea restated. Each names a pain and the relief the brand promises.',
    gate: 'read',
    inputSchema: obj({ brandId: S.string }),
    zod: z.object({ brandId: z.string().optional() }),
    run: (accountId, a) => listPillars(accountId, a?.brandId),
    digest: (_a, result) => {
      const rows = rowsOf(result);
      if (!rows) return '';
      if (!rows.length) return 'No content pillars defined — content will have no rotation and will tend to repeat one theme.';
      return digestLine(`${plural(rows.length, 'content pillar')}: ${samples(rows, ['name'], 8).join(', ')}.`);
    },
  },
  {
    name: 'createContentPillar',
    domain: 'content',
    title: 'Add a content pillar',
    description: 'Define a content pillar: a name, the pain it speaks to, and the relief the brand promises. Three to five pillars is the useful range — fewer and the feed repeats, more and none of them lands. Leave brandId off for a house pillar every venture inherits.',
    gate: 'internal_write',
    inputSchema: obj({ name: S.string, pain: S.string, promise: S.string, brandId: S.string, sortOrder: S.number }, ['name']),
    zod: z.object({
      name: z.string().min(1).max(120),
      pain: z.string().max(600).optional(),
      promise: z.string().max(600).optional(),
      brandId: z.string().optional(),
      sortOrder: z.number().int().min(0).max(100).optional(),
    }),
    run: (accountId, a) => createPillar(accountId, a),
  },
  {
    name: 'deleteContentPillar',
    domain: 'content',
    title: 'Delete a content pillar',
    description: 'Remove a content pillar. Content already assigned to it keeps its recorded pillar name.',
    gate: 'destructive',
    inputSchema: obj({ pillarId: S.string }, ['pillarId']),
    zod: z.object({ pillarId: z.string().min(1) }),
    run: (accountId, a) => deletePillar(accountId, a.pillarId),
    summarize: (a) => `Delete content pillar ${a.pillarId}. Content already assigned to it keeps its recorded pillar name.`,
  },

  // --------------------------------------------------------- platform specs
  {
    name: 'listPlatformSpecs',
    domain: 'content',
    title: 'List platform specs',
    description: "List the per-platform content constraints this workspace writes to — character limit, image spec, hashtag convention, CTA format, tone and best posting time. These are what generated content is held to. Use when the user asks why a post is shaped a certain way, or what a platform allows.",
    gate: 'read',
    inputSchema: obj({}),
    zod: z.object({}),
    run: (accountId) => listPlatformSpecs(accountId),
    digest: (_a, result) => {
      const rows = rowsOf(result);
      if (!rows) return '';
      return digestLine(`Specs for ${plural(rows.length, 'platform')}: ${samples(rows, ['platform'], 8).join(', ')}.`);
    },
  },
  {
    name: 'setPlatformSpec',
    domain: 'content',
    title: 'Override a platform spec',
    description: "Override this workspace's constraints for one platform — character limit, image spec, hashtag strategy, CTA format, tone, or posting time. Sensible defaults already exist for every platform; only set this when the user's own rules differ. Every future generated piece obeys it.",
    gate: 'internal_write',
    inputSchema: obj({
      platform: S.string, charLimit: S.number, imageSpecs: S.string, hashtagStrategy: S.string,
      ctaFormat: S.string, copyTone: S.string, optimalTime: S.string,
    }, ['platform']),
    zod: z.object({
      platform: z.string().min(1),
      charLimit: z.number().int().min(1).max(100000).optional(),
      imageSpecs: z.string().max(500).optional(),
      hashtagStrategy: z.string().max(500).optional(),
      ctaFormat: z.string().max(500).optional(),
      copyTone: z.string().max(1000).optional(),
      optimalTime: z.string().max(200).optional(),
    }),
    run: async (accountId, a) => {
      const { platform, charLimit, imageSpecs, hashtagStrategy, ctaFormat, copyTone, optimalTime } = a;
      // Start from whatever currently applies (the account's row, else the
      // default) so setting one field does not blank the other five.
      const current = await getPlatformSpec(accountId, platform);
      return upsertPlatformSpec(accountId, platform, {
        char_limit: charLimit ?? current?.char_limit ?? null,
        image_specs: imageSpecs ?? current?.image_specs ?? null,
        hashtag_strategy: hashtagStrategy ?? current?.hashtag_strategy ?? null,
        cta_format: ctaFormat ?? current?.cta_format ?? null,
        copy_tone: copyTone ?? current?.copy_tone ?? null,
        optimal_time: optimalTime ?? current?.optimal_time ?? null,
      });
    },
  },
];
