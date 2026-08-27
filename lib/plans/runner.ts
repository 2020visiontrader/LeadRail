// Phase 2 — the runner that carries a plan across ticks.
//
// This is what makes a plan more than a note. MAX_STEPS caps ONE runAgent call
// at 16 steps; a plan is worked one step per tick, so a twenty-step job spans
// twenty invocations and is bounded by its own budget rather than by how much
// fits in a single request.
//
// THE THREE THINGS THAT KEEP IT SAFE, and each is a rule this codebase learned
// the hard way:
//
//   1. ONE STEP PER TICK, ONE STEP IN PROGRESS. claimStep is conditional on the
//      row still being `pending`, and a partial unique index backs it, so two
//      concurrent ticks cannot both take the same step.
//   2. BUDGETS ARE CHECKED BEFORE WORK, not after. A plan that has spent its
//      steps stops on the next tick rather than running one more.
//   3. AN APPROVAL PARKS THE STEP, it does not fail the plan. Phase 3 releases
//      it when a human decides. Nothing here auto-approves anything: a plan
//      step runs through the same runAgent, the same gates, the same standing
//      grants as an interactive turn.
//
// It rides the existing hermes tick rather than a new scheduler, for the same
// reason memory extraction does: a second cron is a second thing that can stop
// silently, and this codebase already has enough of those.

import { log } from '@/lib/logger';
import {
  runnablePlans, nextStep, claimStep, completeStep, blockStep,
  recordProgress, renderPlan, MAX_STEP_ATTEMPTS, type Plan,
} from './store';

/** Plans advanced per tick. Small: each one is a full agent turn, and a tick
 *  also drains sequences, enrichment, webhooks and memory extraction. */
const PLANS_PER_TICK = Number(process.env.PLAN_RUNNER_BATCH) || 2;
/** Agent steps one plan step may use. Deliberately well under MAX_STEPS: a plan
 *  step is meant to be one concrete outcome, and a step that needs sixteen tool
 *  calls was written too coarsely. */
const STEPS_PER_PLAN_STEP = Number(process.env.PLAN_STEPS_PER_RUN) || 6;

export interface PlanTickResult {
  plansTouched: number;
  stepsCompleted: number;
  stepsBlocked: number;
  plansFinished: number;
}

/**
 * Advance ONE step of one plan.
 *
 * Returns what happened so the caller can summarise a tick. Never throws: a
 * plan that cannot run must not take the rest of the tick's work down with it,
 * so a failure is recorded against the plan and the next tick tries the next
 * thing.
 */
async function advance(plan: Plan): Promise<'completed' | 'blocked' | 'idle' | 'error'> {
  // Budget first. Checking after the work would let a plan always run one more
  // step than it was allowed.
  if (plan.stepsUsed >= plan.maxSteps) {
    await recordProgress(plan.id, 0, 'step budget exhausted');
    return 'idle';
  }

  const step = nextStep(plan);
  if (!step) {
    // Nothing pending and nothing in progress — recordProgress decides whether
    // that is done or blocked.
    await recordProgress(plan.id, 0);
    return 'idle';
  }

  // A step that has already failed its allowance is parked for a human rather
  // than retried forever. Retrying the impossible is how an autonomous system
  // spends a budget on nothing.
  if (step.attempts >= MAX_STEP_ATTEMPTS) {
    await blockStep(step.id, `Tried ${step.attempts} times without completing it.`);
    await recordProgress(plan.id, 0);
    return 'blocked';
  }

  if (step.status === 'pending' && !(await claimStep(plan.id, step.id))) {
    // Another tick took it between the read and the claim. Not an error.
    return 'idle';
  }

  const { runAgent } = await import('@/lib/agent/loop');
  try {
    const result = await runAgent({
      accountId: plan.accountId,
      // The plan block is already in the grounding (lib/agent/context.ts), so
      // this names the ONE step rather than restating the objective — otherwise
      // the model re-plans instead of executing.
      message: [
        `Work ONLY this step of the current plan, then stop:`,
        `  Step ${step.seq}: ${step.title}`,
        '',
        'When it is finished, call completePlanStep with its stepId and one sentence saying what came of it.',
        `The stepId is: ${step.id}`,
        'If it genuinely cannot be done — something is missing that only the user can supply — call blockPlanStep with the reason instead. Do not skip work merely because it is hard.',
      ].join('\n'),
      conversationId: plan.conversationId ?? undefined,
      brandContext: plan.brandId ? { id: plan.brandId } : undefined,
      maxSteps: STEPS_PER_PLAN_STEP,
      requestedBy: `plan:${plan.id}`,
    });

    if (result.status === 'needs_approval') {
      // Phase 3: the step waits on a human, and the approval id is recorded so
      // granting it resumes HERE rather than restarting the plan.
      await blockStep(
        step.id,
        result.proposal?.summary || 'Waiting on your approval.',
        result.proposal?.approvalId ?? null,
      );
      await recordProgress(plan.id, result.steps.length);
      return 'blocked';
    }

    if (result.status === 'error') {
      // Left `in_progress`; the attempts counter already rose when it was
      // claimed, so a repeatedly failing step reaches MAX_STEP_ATTEMPTS and
      // parks itself rather than looping.
      await recordProgress(plan.id, result.steps.length, result.message);
      return 'error';
    }

    // The model is asked to call completePlanStep itself, because it knows what
    // the outcome actually was. If it finished the turn without doing so, close
    // the step here with the answer it gave — leaving it `in_progress` would
    // stall the plan behind a step nothing will ever advance.
    const stillOpen = plan.steps.find((s) => s.id === step.id)?.status !== 'done';
    if (stillOpen) await completeStep(step.id, result.message || 'Completed.');
    await recordProgress(plan.id, result.steps.length);
    return 'completed';
  } catch (e: any) {
    await recordProgress(plan.id, 0, String(e?.message || e));
    return 'error';
  }
}

/** One pass over the runnable plans. Called from the hermes tick. */
export async function runPlanTick(limit = PLANS_PER_TICK): Promise<PlanTickResult> {
  const out: PlanTickResult = { plansTouched: 0, stepsCompleted: 0, stepsBlocked: 0, plansFinished: 0 };
  let plans: Plan[] = [];
  try {
    plans = await runnablePlans(limit);
  } catch {
    return out;
  }

  for (const plan of plans) {
    out.plansTouched++;
    const outcome = await advance(plan);
    if (outcome === 'completed') out.stepsCompleted++;
    if (outcome === 'blocked') out.stepsBlocked++;
  }

  if (out.plansTouched) {
    log.info('plan runner: tick', { ...out });
  }
  return out;
}

/** Rendered progress for a notification or a UI. */
export function planSummary(plan: Plan): string {
  return renderPlan(plan);
}
