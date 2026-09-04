// Workspace capabilities — the everyday surfaces the assistant could not reach.
//
// Each one wraps a function that already worked and already had an HTTP route
// and a UI. None of this is new machinery; it is the catalog catching up with
// the product. The pattern this closes: a user asks the assistant to do
// something the platform plainly does, and gets "I can't do that" — not because
// the feature is missing, but because no tool name pointed at it.
//
// Notably this makes the outreach loop whole. The assistant could already
// enrol contacts into a sequence and send from a template; it could not create
// either. "Set up a 3-step follow-up and enrol these leads" needed a human to
// go and build the sequence by hand first.

import { z } from 'zod';
import {
  getTemplates, createTemplate, createVenture, updateVenture, getVenture,
} from '@/lib/db';
import { listNotifications, markAllRead, unreadCount } from '@/lib/notifications/store';
import { listApprovals } from '@/lib/approvals/store';
import { createSequence, listSequences } from '@/lib/sequences';
import { listVisibleSkills, listAccountSkillStates, setAccountSkillState } from '@/lib/skills/store';
import { generateImage as routeImage, imageConfigured } from '@/lib/ai/image-router';
import { insertCampaignAsset, dbReady } from '@/lib/db';
import { uploadGenerated } from '@/lib/storage';
import { obj, S, type Capability, rowsOf, plural, samples, tally, digestLine } from './types';

const STEP_CHANNELS = ['email', 'wait', 'task', 'branch'] as const;

export const WORKSPACE_CAPABILITIES: Capability[] = [
  // ------------------------------------------------------------ notifications
  {
    name: 'listNotifications',
    domain: 'workspace',
    title: 'List notifications',
    description: 'Read this account\'s notifications, newest first — what the platform has flagged (replies, failures, approvals waiting, automation events). Use when the user asks what they have missed or what needs attention.',
    gate: 'read',
    inputSchema: obj({ unreadOnly: { type: 'boolean' }, limit: S.number }),
    zod: z.object({ unreadOnly: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional() }),
    run: async (accountId, a) => {
      const rows = await listNotifications(accountId, { unreadOnly: a?.unreadOnly, limit: a?.limit ?? 25 } as any);
      return { unread: await unreadCount(accountId).catch(() => null), notifications: rows };
    },
    digest: (_a, result) => {
      const rows = rowsOf((result as any)?.notifications);
      if (!rows) return '';
      if (!rows.length) return 'No notifications.';
      return digestLine(
        `${plural(rows.length, 'notification')}${typeof (result as any)?.unread === 'number' ? `, ${(result as any).unread} unread` : ''}.`,
        samples(rows, ['title', 'body'], 4).length ? `Latest: ${samples(rows, ['title', 'body'], 4).join(' | ')}` : null,
      );
    },
  },
  {
    name: 'markNotificationsRead',
    domain: 'workspace',
    title: 'Mark notifications read',
    description: 'Mark every notification on this account as read. Only do this when the user asks to clear them.',
    gate: 'internal_write',
    inputSchema: obj({}),
    zod: z.object({}),
    run: (accountId) => markAllRead(accountId),
  },

  // ---------------------------------------------------------------- approvals
  {
    name: 'listApprovals',
    domain: 'workspace',
    title: 'List approval requests',
    description: "Read the approval queue — actions that were proposed and are waiting on a decision, plus recently approved or rejected ones. Use when the user asks what is waiting on them, or to check whether something you proposed earlier was ever approved. You cannot approve anything yourself; only the user can.",
    gate: 'read',
    inputSchema: obj({ state: S.string }),
    zod: z.object({ state: z.enum(['pending', 'approved', 'rejected', 'executed', 'expired']).optional() }),
    run: (accountId, a) => listApprovals(accountId, a?.state ? { state: a.state as any } : undefined),
    digest: (_a, result) => {
      const rows = rowsOf(result);
      if (!rows) return '';
      if (!rows.length) return 'Nothing in the approval queue.';
      return digestLine(
        `${plural(rows.length, 'approval request')}.`,
        tally(rows, 'state') ? `${tally(rows, 'state')}.` : null,
        samples(rows, ['title'], 4).length ? `Waiting on: ${samples(rows, ['title'], 4).join(', ')}` : null,
      );
    },
  },

  // ----------------------------------------------------------------- ventures
  {
    name: 'createVenture',
    domain: 'ventures',
    title: 'Create a venture',
    description: 'Create a new venture (brand) in this workspace, optionally with its pitch, description, sectors and lead goal. Everything else — leads, campaigns, content, connections — hangs off a venture, so create one before setting up work for a new brand.',
    gate: 'internal_write',
    inputSchema: obj({
      name: S.string, description: S.string, pitch: S.string,
      sectors: { type: 'array', items: S.string }, leadGoal: S.number,
    }, ['name']),
    zod: z.object({
      name: z.string().min(1).max(120),
      description: z.string().max(2000).optional(),
      pitch: z.string().max(2000).optional(),
      sectors: z.array(z.string()).optional(),
      leadGoal: z.number().int().min(0).optional(),
    }),
    run: (accountId, a) => createVenture(accountId, a.name, {
      description: a.description,
      pitch: a.pitch,
      sectors: a.sectors,
      lead_goal: a.leadGoal,
    } as any),
  },
  {
    name: 'updateVenture',
    domain: 'ventures',
    title: 'Update a venture',
    description: "Update a venture's profile — its description, pitch, sectors or lead goal. Use when the user tells you something durable about how a brand positions itself. Call listVentures first for the id.",
    gate: 'internal_write',
    inputSchema: obj({
      brandId: S.string, name: S.string, description: S.string, pitch: S.string,
      sectors: { type: 'array', items: S.string }, leadGoal: S.number,
    }, ['brandId']),
    zod: z.object({
      brandId: z.string().min(1),
      name: z.string().min(1).max(120).optional(),
      description: z.string().max(2000).optional(),
      pitch: z.string().max(2000).optional(),
      sectors: z.array(z.string()).optional(),
      leadGoal: z.number().int().min(0).optional(),
    }),
    run: async (accountId, a) => {
      const patch: Record<string, any> = {};
      if (a.name !== undefined) patch.name = a.name;
      if (a.description !== undefined) patch.description = a.description;
      if (a.pitch !== undefined) patch.pitch = a.pitch;
      if (a.sectors !== undefined) patch.sectors = a.sectors;
      if (a.leadGoal !== undefined) patch.lead_goal = a.leadGoal;
      if (!Object.keys(patch).length) throw new Error('Nothing to update — give at least one field to change.');
      return updateVenture(a.brandId, accountId, patch);
    },
  },

  // ---------------------------------------------------------------- templates
  {
    name: 'listTemplates',
    domain: 'outreach',
    title: 'List message templates',
    description: 'List the saved email/message templates for this account, optionally for one venture. Use before sending or before writing a new one, so you reuse what exists instead of duplicating it.',
    gate: 'read',
    inputSchema: obj({ brandId: S.string }),
    zod: z.object({ brandId: z.string().optional() }),
    run: (accountId, a) => getTemplates(accountId, a?.brandId),
    digest: (_a, result) => {
      const rows = rowsOf(result);
      if (!rows) return '';
      if (!rows.length) return 'No saved templates.';
      return digestLine(
        `${plural(rows.length, 'template')}.`,
        `Named: ${samples(rows, ['name'], 5).join(', ')}`,
      );
    },
  },
  {
    name: 'createTemplate',
    domain: 'outreach',
    title: 'Save a message template',
    description: 'Save a reusable email/message template with a name, optional subject, and body. Nothing is sent — this only stores it for later use.',
    gate: 'internal_write',
    inputSchema: obj({ name: S.string, body: S.string, subject: S.string, category: S.string, brandId: S.string }, ['name', 'body']),
    zod: z.object({
      name: z.string().min(1).max(200),
      body: z.string().min(1),
      subject: z.string().max(300).optional(),
      category: z.string().max(80).optional(),
      brandId: z.string().optional(),
    }),
    run: (accountId, a) => createTemplate({
      account_id: accountId,
      brand_id: a.brandId ?? null,
      name: a.name,
      category: a.category ?? null,
      subject: a.subject ?? null,
      body: a.body,
    }),
  },

  // ---------------------------------------------------------------- sequences
  {
    name: 'createSequence',
    domain: 'outreach',
    title: 'Create a follow-up sequence',
    description: `Create a multi-step follow-up sequence for a venture. Steps run in order; each is one of: ${STEP_CHANNELS.join(', ')}. An "email" step needs a subject and body; a "wait" step needs waitDays. Creating a sequence sends nothing — people only start receiving it when they are separately enrolled, which is its own approval.`,
    gate: 'internal_write',
    inputSchema: obj({
      name: S.string, brandId: S.string,
      steps: { type: 'array', items: { type: 'object' } },
    }, ['name', 'brandId', 'steps']),
    zod: z.object({
      name: z.string().min(1).max(200),
      brandId: z.string().min(1),
      steps: z.array(z.object({
        type: z.enum(STEP_CHANNELS),
        subject: z.string().optional(),
        body: z.string().optional(),
        waitDays: z.number().int().min(0).max(365).optional(),
      })).min(1).max(20),
    }).refine((a) => a.steps.every((s) => s.type !== 'email' || (s.subject && s.body)), {
      message: 'Every email step needs both a subject and a body.',
    }),
    run: (accountId, a) => createSequence({
      account_id: accountId,
      brand_id: a.brandId,
      name: a.name,
      steps: a.steps.map((s: any, i: number) => ({
        step_order: i + 1,
        type: s.type,
        subject: s.subject ?? null,
        body: s.body ?? null,
        wait_days: s.waitDays ?? 0,
      })),
    } as any),
  },

  // ------------------------------------------------------------------- skills
  {
    name: 'listSkills',
    domain: 'workspace',
    title: 'List skills',
    description: "List the skills available to this workspace and which are switched on. A skill is saved guidance that shapes how you write and decide — house style, a playbook, a checklist. Use when the user asks what skills exist or why you are following a particular approach.",
    gate: 'read',
    inputSchema: obj({ enabledOnly: { type: 'boolean' } }),
    zod: z.object({ enabledOnly: z.boolean().optional() }),
    run: async (accountId, a) => {
      const [skills, states] = await Promise.all([
        listVisibleSkills(accountId),
        listAccountSkillStates(accountId),
      ]);
      const enabledBy = new Map(states.map((s: any) => [s.skill_id, s.enabled]));
      const rows = skills.map((s: any) => ({
        id: s.id,
        slug: s.slug,
        name: s.name,
        enabled: enabledBy.get(s.id) === true,
      }));
      return a?.enabledOnly ? rows.filter((r) => r.enabled) : rows;
    },
    digest: (_a, result) => {
      const rows = rowsOf(result);
      if (!rows) return '';
      if (!rows.length) return 'No skills available.';
      const on = rows.filter((r: any) => r.enabled);
      return digestLine(
        `${plural(rows.length, 'skill')} available, ${on.length} switched on.`,
        on.length ? `On: ${samples(on, ['name'], 6).join(', ')}` : null,
      );
    },
  },
  {
    name: 'setSkillEnabled',
    domain: 'workspace',
    title: 'Switch a skill on or off',
    description: 'Switch one skill on or off for this workspace. A switched-on skill changes how you write and decide on every future turn, so only do this when the user asks. Call listSkills first for the id.',
    gate: 'internal_write',
    inputSchema: obj({ skillId: S.string, enabled: { type: 'boolean' } }, ['skillId', 'enabled']),
    zod: z.object({ skillId: z.string().min(1), enabled: z.boolean() }),
    run: (accountId, a) => setAccountSkillState(accountId, a.skillId, a.enabled),
  },

  // -------------------------------------------------------------------- image
  {
    name: 'generateImage',
    domain: 'creative',
    title: 'Generate an image',
    description: 'Generate an image from a text prompt — ad creative, a social visual, a mockup. Optionally render a caption onto it and set an aspect ratio (e.g. "1:1", "9:16"). Pass a campaignId to attach the result to that campaign as a creative asset. Returns a URL to the generated image.',
    gate: 'internal_write',
    inputSchema: obj({ prompt: S.string, caption: S.string, aspect: S.string, campaignId: S.string }, ['prompt']),
    zod: z.object({
      prompt: z.string().min(3).max(2000),
      caption: z.string().max(300).optional(),
      aspect: z.string().max(16).optional(),
      campaignId: z.string().optional(),
    }),
    run: async (accountId, a) => {
      if (!imageConfigured()) throw new Error('Image generation is not connected for this workspace.');
      const img = await routeImage({ prompt: a.prompt, caption: a.caption, aspect: a.aspect });
      // Routed through lib/storage.ts's private, tenant-prefixed bucket — the
      // same helper the other two generateImage call sites use — instead of
      // the old `public/generated/` path, which was gitignored, served
      // unauthenticated, and destroyed on every deploy. Never return the
      // base64 — a single image would swamp the observation budget and every
      // downstream stage's context with it.
      // storagePath is the stable identifier — persist THIS (never the signed
      // `url`, which expires after GENERATED_URL_TTL and would otherwise make
      // every campaign asset 404 a day after it was generated).
      const { url, storagePath } = await uploadGenerated(accountId, Buffer.from(img.base64, 'base64'), img.mimeType);

      let asset = null;
      if (a.campaignId && dbReady()) {
        asset = await insertCampaignAsset({
          campaign_id: a.campaignId,
          account_id: accountId,
          url,
          storage_path: storagePath,
          ai_analysis: { caption: a.caption ?? null, prompt: a.prompt },
        });
      }
      return { url, mimeType: img.mimeType, attachedToCampaign: Boolean(asset) };
    },
    digest: (a, result) => {
      const r: any = result;
      if (!r?.url) return '';
      return digestLine(`Image generated for "${String(a?.prompt ?? '').slice(0, 80)}": ${r.url}`, r.attachedToCampaign ? 'Attached to the campaign.' : null);
    },
  },
];
