// Planning capabilities — the assistant's own task list.
//
// WHY THIS SHAPE. It mirrors how a coding agent tracks long work, because the
// property that matters is the same: "where am I" must be STATE, not something
// re-derived from the transcript each turn. Re-deriving is expensive, lossy,
// and — here — hard-capped at MAX_STEPS = 16 inside one request. A plan row
// survives the request, so a task can span ticks.
//
// The rules that make it work, in order of how easy they are to get wrong:
//   1. Exactly ONE step in progress. Enforced by a partial unique index, not by
//      convention — a plan with two active steps has no answer to "what are you
//      doing", which was the whole point of keeping a cursor.
//   2. Mark a step done the moment it IS done, not in a batch at the end.
//      A batch update means a crash loses every step's progress at once.
//   3. The model writes the plan; the model may not raise its own budget.
//      createPlan clamps, and no capability here can extend max_steps.
//
// LeadRail already had this pattern for deterministic work —
// `hermes_jobs.step_index` is a durable cursor into an email sequence. It just
// never existed for agentic work.

import { z } from 'zod';
import { obj, S, type Capability } from './types';
import {
  createPlan, getPlan, activePlanForConversation, completeStep, blockStep,
  cancelPlans, renderPlan, MAX_PLAN_STEPS, MAX_STEP_OVER_ITEMS,
} from '@/lib/plans/store';
import { loadEnabledSkillsForAgent } from '@/lib/skills/store';
import { hermesRoute } from '@/lib/ai/hermes';
import { listPersonas } from '@/lib/agent/personas';
import { pickPersonaSlug, resolvePersona } from '@/lib/agent/persona-routing';
import { PERSONA_TEMPLATES } from '@/lib/agent/persona-registry';

export const PLAN_CAPABILITIES: Capability[] = [
  {
    name: 'createPlan',
    domain: 'workspace',
    title: 'Write a plan',
    description:
      'Break a large piece of work into ordered steps and save it, so the work survives across turns and you never lose your place; give a step { title, over: [...] } instead of a bare string when it means "for each of these N things, do X" (research/draft/send N leads, enrich N companies) — that is ONE batch step worked a few items per tick, not N separate steps. Use for anything that will take more than a handful of tool calls. Each step should be one concrete outcome, not a vague phase.',
    gate: 'internal_write',
    inputSchema: obj(
      {
        objective: S.string,
        steps: {
          type: 'array',
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: { title: S.string, over: { type: 'array', items: S.string } },
                required: ['title', 'over'],
              },
            ],
          },
        },
      },
      ['objective', 'steps'],
    ),
    zod: z.object({
      objective: z.string().min(3).max(2000),
      steps: z.array(z.union([
        z.string().min(1),
        z.object({
          title: z.string().min(1),
          over: z.array(z.string().min(1)).min(1).max(MAX_STEP_OVER_ITEMS),
        }),
      ])).min(2).max(MAX_PLAN_STEPS),
    }),
    run: async (accountId, a, ctx?: any) => {
      // STRUCTURE THE PLAN AGAINST THE OBJECTIVE, then pin what it chose.
      //
      // Two selections, both made ONCE and both against the objective rather
      // than against a step's wording:
      //
      //   skills  — routed through Hermes, the same shortlist-then-classify
      //             path an ordinary turn uses. Pinning ALL enabled skills
      //             would not be selection at all, and the catalog is 353.
      //   persona — derived from those SAME routed skills (BACKLOG 5b), not
      //             from the objective text. A plan worked one step per tick
      //             must not get a strategist on step 1 and an analyst on
      //             step 4 with the voice drifting mid-job, so the persona is
      //             picked once, here, the same way a single turn's voice is
      //             picked in lib/agent/loop.ts: each routed skill's
      //             "## Agents Used" section names the persona that executes
      //             it (lib/agent/persona-routing.ts personaSlugsForSkill),
      //             pickPersonaSlug picks the one named by the most routed
      //             skills, and resolvePersona resolves that slug to an
      //             account's own enabled row before falling back to the
      //             harvested template.
      //
      //             `plans.personaId` is a DB row FK, so only a ROW resolution
      //             is pinned — when the winner resolves to a template with no
      //             matching row, nothing is pinned rather than inventing a
      //             row, and the plan runs as the default assistant on every
      //             step (still consistent, just voiceless).
      //
      // Skills degrade to nothing on failure: a plan with no pinned skills
      // routes per turn as before, and the persona pin degrades with it since
      // it is derived from the same routed set.
      let skills: string[] = [];
      let personaId: string | null = null;
      try {
        const enabled = await loadEnabledSkillsForAgent(accountId);
        const enabledSlugs = new Set(enabled.map((sk: any) => sk.slug).filter(Boolean));
        const routed = await hermesRoute(a.objective, {});
        // Intersect: Hermes routes over the whole catalog, but enabled-ness
        // always wins — the same rule selectSkillsForTurn applies.
        skills = (routed.skillIds || []).filter((slug: string) => enabledSlugs.has(slug));

        const bySlug = new Map(enabled.map((sk: any) => [sk.slug, sk]));
        const routedSkills = skills
          .map((slug) => bySlug.get(slug))
          .filter((sk): sk is { slug: string; instructions: string } => Boolean(sk?.instructions));
        const personaSlug = pickPersonaSlug(routedSkills);
        if (personaSlug) {
          const rows = await listPersonas(accountId);
          const resolved = resolvePersona(personaSlug, rows, PERSONA_TEMPLATES);
          if (resolved?.source === 'row') personaId = resolved.row.id;
        }
      } catch { /* routes per turn instead */ }

      const plan = await createPlan({
        accountId,
        objective: a.objective,
        steps: a.steps,
        skills,
        personaId,
        conversationId: ctx?.conversationId ?? null,
        brandId: ctx?.brandId ?? null,
        createdBy: ctx?.requestedBy ?? null,
        // In chat the operator is watching, so a plan starts running. Plan mode
        // (planOnly) is what makes it a draft awaiting a go-ahead, and that is
        // decided by the caller, never by the model.
        requireApproval: Boolean(ctx?.planOnly),
      });
      if (!plan) return { created: false, reason: 'could not save the plan' };
      return {
        planId: plan.id,
        status: plan.status,
        steps: plan.steps.map((s) => ({ seq: s.seq, title: s.title, ...(s.total != null ? { items: s.total } : {}) })),
        // Surfaced so the operator can see how the work was framed before
        // approving it — a plan mode that hides its own reasoning is just a
        // delay.
        usingSkills: plan.skills,
        persona: plan.personaId ? 'a specialist' : 'the default assistant',
        note: plan.status === 'draft'
          ? 'Saved as a draft. Nothing will run until the user approves it.'
          : 'Saved. Work the first step now.',
      };
    },
    digest: (_a, r: any) => {
      if (!r) return '';
      return r.planId ? `Plan saved with ${r.steps?.length ?? 0} steps.` : 'Plan was not saved.';
    },
  },
  {
    name: 'completePlanStep',
    domain: 'workspace',
    title: 'Mark a plan step done',
    description:
      'Mark the step you just finished as done and record what came of it, in one short sentence. Do this the MOMENT a step is finished — never in a batch at the end, or a interruption loses everything you did.',
    gate: 'internal_write',
    inputSchema: obj({ stepId: S.string, result: S.string }, ['stepId', 'result']),
    zod: z.object({ stepId: z.string().min(1), result: z.string().min(1).max(4000) }),
    run: async (_accountId, a) => {
      await completeStep(a.stepId, a.result);
      return { done: true, stepId: a.stepId };
    },
  },
  {
    name: 'blockPlanStep',
    domain: 'workspace',
    title: 'Park a plan step',
    description:
      'Park a step you cannot finish, with the reason. Use when something is genuinely missing — a credential, a decision only the user can make, data that does not exist. Do NOT use it to skip work that is merely hard.',
    gate: 'internal_write',
    inputSchema: obj({ stepId: S.string, reason: S.string }, ['stepId', 'reason']),
    zod: z.object({ stepId: z.string().min(1), reason: z.string().min(1).max(1000) }),
    run: async (_accountId, a) => {
      await blockStep(a.stepId, a.reason);
      return { blocked: true, reason: a.reason };
    },
  },
  {
    name: 'getPlan',
    domain: 'workspace',
    title: 'Read the current plan',
    description:
      'Read the plan for this chat — what is done, what is next, what is parked. Use if you have lost your place, or when the user asks how far along you are.',
    gate: 'read',
    inputSchema: obj({ planId: S.string }, []),
    zod: z.object({ planId: z.string().optional() }),
    run: async (accountId, a, ctx?: any) => {
      const plan = a.planId
        ? await getPlan(accountId, a.planId)
        : ctx?.conversationId ? await activePlanForConversation(accountId, ctx.conversationId) : null;
      if (!plan) return { plan: null };
      return {
        planId: plan.id,
        objective: plan.objective,
        status: plan.status,
        stepsUsed: plan.stepsUsed,
        maxSteps: plan.maxSteps,
        rendered: renderPlan(plan),
        steps: plan.steps.map((s) => ({ stepId: s.id, seq: s.seq, title: s.title, status: s.status })),
      };
    },
    digest: (_a, r: any) => {
      if (!r) return '';
      if (!r.plan && !r.planId) return 'No plan is active for this chat.';
      const done = (r.steps || []).filter((s: any) => s.status === 'done').length;
      return `Plan "${r.objective}" — ${done} of ${(r.steps || []).length} steps done.`;
    },
  },
  {
    name: 'cancelPlan',
    domain: 'workspace',
    title: 'Stop a plan',
    description:
      'Stop a plan so nothing further runs from it. Pass a planId to stop one, or omit it to stop every plan on the account. Use the moment the user says stop, abandon, or start over.',
    // Never sensitive: stopping must take effect immediately and must never
    // queue behind an approval the user then has to grant.
    gate: 'internal_write',
    inputSchema: obj({ planId: S.string }, []),
    zod: z.object({ planId: z.string().optional() }),
    run: async (accountId, a) => {
      const n = await cancelPlans(accountId, a.planId);
      return { cancelled: n };
    },
    digest: (_a, r: any) => {
      if (!r) return '';
      return r.cancelled ? `Stopped ${r.cancelled} plan(s).` : 'There was no running plan to stop.';
    },
  },
];
