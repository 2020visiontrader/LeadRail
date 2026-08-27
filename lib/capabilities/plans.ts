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
  cancelPlans, renderPlan, MAX_PLAN_STEPS,
} from '@/lib/plans/store';

export const PLAN_CAPABILITIES: Capability[] = [
  {
    name: 'createPlan',
    domain: 'workspace',
    title: 'Write a plan',
    description:
      'Break a large piece of work into ordered steps and save it, so the work survives across turns and you never lose your place. Use for anything that will take more than a handful of tool calls — researching a list of companies, building and launching a campaign, working through a batch of leads. Each step should be one concrete outcome, not a vague phase.',
    gate: 'internal_write',
    inputSchema: obj(
      { objective: S.string, steps: { type: 'array', items: { type: 'string' } } },
      ['objective', 'steps'],
    ),
    zod: z.object({
      objective: z.string().min(3).max(2000),
      steps: z.array(z.string().min(1)).min(2).max(MAX_PLAN_STEPS),
    }),
    run: async (accountId, a, ctx?: any) => {
      const plan = await createPlan({
        accountId,
        objective: a.objective,
        steps: a.steps,
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
        steps: plan.steps.map((s) => ({ seq: s.seq, title: s.title })),
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
