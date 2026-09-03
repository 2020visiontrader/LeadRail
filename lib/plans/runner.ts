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
import { improvePrompt } from '@/lib/ai/prompt-improver';
import {
  runnablePlans, nextStep, claimStep, completeStep, blockStep,
  recordProgress, renderPlan, MAX_STEP_ATTEMPTS, advanceCursor, releaseStepForRetry,
  clearStepApproval,
  type Plan, type PlanStep, type PlanStatus,
} from './store';

/** Plans advanced per tick. Small: each one is a full agent turn, and a tick
 *  also drains sequences, enrichment, webhooks and memory extraction. */
const PLANS_PER_TICK = Number(process.env.PLAN_RUNNER_BATCH) || 2;
/** Agent steps one plan step may use. Deliberately well under MAX_STEPS: a plan
 *  step is meant to be one concrete outcome, and a step that needs sixteen tool
 *  calls was written too coarsely. */
const STEPS_PER_PLAN_STEP = Number(process.env.PLAN_STEPS_PER_RUN) || 6;
/** Items a BATCH step (one with `over`) advances per tick. This is the knob
 *  an operator trades tick cost against wall-clock with: at the real
 *  production cadence of 5 MINUTES, 8 items per tick clears a 95-item batch in
 *  ceil(95/8) = 12 ticks, roughly ONE HOUR. Raising it finishes sooner at the
 *  cost of a bigger, riskier single tick (still bounded by
 *  STEPS_PER_PLAN_STEP agent steps); lowering it shrinks each tick at the cost
 *  of wall-clock time.
 *
 *  CORRECTED 2026-09-02, and the mistake is worth keeping because it is easy
 *  to repeat. This comment used to claim "~35 minutes across 1,216 ticks / 30
 *  days", and therefore ~7 hours for 95 items. Both numbers were wrong. The
 *  30-day average was taken over a window in which the scheduler DID NOT EXIST
 *  for the first 26 days (BACKLOG §2: pg_cron `hermes-tick-every-5-min` was
 *  only stood up 2026-08-28), so it averaged a mostly-unscheduled month and
 *  reported the result as the current cadence.
 *
 *  Measured properly, over the window where the scheduler actually runs:
 *    app_logs, route ilike '%hermes%', created_at >= 2026-08-28
 *      -> n=1527, mean gap 5.0 minutes
 *    cron.job id 1 'hermes-tick-every-5-min', schedule '*''/5 * * * *', active
 *    net._http_response -> 72 rows, ALL 200, one per ~4.9 minutes
 *
 *  Do not read cron.job_run_details.status alone: pg_net is asynchronous and
 *  'succeeded' means the request was QUEUED, not that it returned 200 (that
 *  trap is written up in BACKLOG §2). The lesson generalises — a real query
 *  over the wrong time range is still the wrong answer. */
const ITEMS_PER_STEP_TICK = Number(process.env.PLAN_ITEMS_PER_TICK) || 8;

/**
 * A step that was parked with a granted approval carries `approvalId`. When
 * that approval is still genuinely usable, hand it to runAgent so its
 * existing hard gate (consumeApprovalForExecution) actually consumes it —
 * without this, a resumed step just proposes the same sensitive call again,
 * blocks again, and never executes (G15).
 *
 * Returns undefined for anything short of a clean, currently-approved,
 * decryptable row — a pending/rejected/expired/invalidated/executed approval
 * must NOT resume execution, it must fall back to today's behaviour (the
 * model proposes again, which re-raises a fresh approval if the human still
 * wants it done). Never throws: a failure here must degrade gracefully, not
 * take the tick down with it.
 */
async function grantedApprovalFor(
  plan: Plan,
  step: PlanStep,
): Promise<{ approvalId: string; tool: string; args: Record<string, any> } | undefined> {
  if (!step.approvalId) return undefined;
  try {
    const { getApproval, decryptApprovalArgs } = await import('@/lib/approvals/store');
    const row = await getApproval(plan.accountId, step.approvalId);
    if (!row || row.state !== 'approved') return undefined;
    const args = await decryptApprovalArgs(plan.accountId, step.approvalId);
    if (!args) return undefined;
    return { approvalId: row.id, tool: row.tool, args };
  } catch {
    return undefined;
  }
}

/**
 * Grounding for a plan step's runAgent call (G14): the same venture profile,
 * account snapshot, durable memory, and conversation transcript an
 * interactive turn gets via loadAgentContext/loadTranscript. Without this a
 * plan step runs blind — it cannot see what earlier steps actually did, or
 * anything the account has told the assistant outside this one turn.
 *
 * Both pieces degrade to undefined on failure rather than throwing — a
 * grounding miss must not fail the tick that would otherwise complete real
 * work.
 */
async function groundingFor(plan: Plan, step: PlanStep): Promise<{
  agentContext?: string;
  transcript?: any[];
}> {
  let agentContext: string | undefined;
  try {
    const { loadAgentContext } = await import('@/lib/agent/context');
    agentContext = await loadAgentContext({
      accountId: plan.accountId,
      brandId: plan.brandId ?? undefined,
      conversationId: plan.conversationId ?? undefined,
      query: step.title,
    });
  } catch {
    agentContext = undefined;
  }

  let transcript: any[] | undefined;
  if (plan.conversationId) {
    try {
      const { loadTranscript } = await import('@/lib/agent/memory');
      transcript = await loadTranscript(plan.conversationId, plan.accountId);
    } catch {
      transcript = undefined;
    }
  }

  return { agentContext, transcript };
}

/**
 * Mark/clear the plan's own conversation as "has a turn in progress" around
 * the runAgent call — exactly what an interactive turn does (see
 * markConversationRunning's own comment in lib/agent/memory.ts). Without this
 * the assistant console — which polls GET /api/agent/conversations/[id] only
 * while `running` is true — never repaints when a plan step finishes, even
 * though the escalation copy promises "you'll see it continue right here"
 * (G16a). A plan with no conversationId has nothing to mark.
 *
 * Both best-effort and silent on failure: markConversationRunning/
 * clearConversationRunning already never throw on their own, but the dynamic
 * import is wrapped here too so a broken module resolution can never take a
 * tick down with it — the plan step itself is the work that matters.
 */
async function markRunning(plan: Plan): Promise<void> {
  if (!plan.conversationId) return;
  try {
    const { markConversationRunning } = await import('@/lib/agent/memory');
    await markConversationRunning(plan.conversationId, plan.accountId);
  } catch { /* best-effort */ }
}

async function clearRunning(plan: Plan): Promise<void> {
  if (!plan.conversationId) return;
  try {
    const { clearConversationRunning } = await import('@/lib/agent/memory');
    await clearConversationRunning(plan.conversationId, plan.accountId);
  } catch { /* best-effort */ }
}

/**
 * Best-effort notification for a plan reaching done, blocked, or failed
 * (G16c) — raised by recordAndNotify below exactly on the STATUS TRANSITION,
 * never on every tick that merely observes an unchanged status. That matters
 * because a blocked plan drops out of runnablePlans (it only ever selects
 * `status = 'running'`), so without the transition check a plan sitting
 * blocked across many ticks would otherwise be safe by construction — but the
 * check is what makes that safety explicit rather than accidental, and it is
 * what keeps a `done`/`failed` transition (reachable from within a single
 * tick) from re-firing if recordAndNotify is ever called more than once
 * against the same tick's pre-work snapshot.
 */
async function notifyPlanStatus(plan: Plan, status: 'done' | 'blocked' | 'failed'): Promise<void> {
  try {
    const { createNotification } = await import('@/lib/notifications/store');
    const done = plan.steps.filter((s) => s.status === 'done').length;
    const total = plan.steps.length;
    const label = status === 'done' ? 'finished' : status === 'blocked' ? 'needs you' : 'failed';
    await createNotification(plan.accountId, {
      type: 'plan',
      title: `Plan ${label}: ${plan.objective.slice(0, 80)}`,
      body: `${done}/${total} steps done.`,
      ...(plan.conversationId ? { link: `/assistant?c=${plan.conversationId}` } : {}),
      // Never email a plan tick's own notification — the bell (and the
      // console, already repainting via markRunning/clearRunning above) is
      // enough; an unattended background job should not also page someone.
      email: false,
    });
  } catch { /* best-effort — a missed bell entry must not fail the tick */ }
}

/**
 * recordProgress, plus notifyPlanStatus exactly when it caused a transition.
 * `plan` is the tick's PRE-work snapshot — in practice always `status:
 * 'running'`, since that is the only status runnablePlans ever selects — so
 * this compares that snapshot against whatever recordProgress just set,
 * rather than assuming what "before" was.
 */
async function recordAndNotify(
  plan: Plan,
  stepsSpent: number,
  error?: string | null,
): Promise<PlanStatus | null> {
  const before = plan.status;
  const after = await recordProgress(plan.id, stepsSpent, error);
  if (after && after !== before && (after === 'done' || after === 'blocked' || after === 'failed')) {
    await notifyPlanStatus(plan, after);
  }
  return after;
}

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
    await recordAndNotify(plan, 0, 'step budget exhausted');
    return 'idle';
  }

  const step = nextStep(plan);
  if (!step) {
    // Nothing pending and nothing in progress — recordProgress decides whether
    // that is done or blocked.
    await recordAndNotify(plan, 0);
    return 'idle';
  }

  // A step that has already failed its allowance is parked for a human rather
  // than retried forever. Retrying the impossible is how an autonomous system
  // spends a budget on nothing.
  if (step.attempts >= MAX_STEP_ATTEMPTS) {
    await blockStep(step.id, `Tried ${step.attempts} times without completing it.`);
    await recordAndNotify(plan, 0);
    return 'blocked';
  }

  if (step.status === 'pending' && !(await claimStep(plan.id, step.id))) {
    // Another tick took it between the read and the claim. Not an error.
    return 'idle';
  }

  // A BATCH step (one with `over`) is worked a slice at a time across many
  // ticks, with its own cursor bookkeeping — everything below this point is
  // the single-shot path, pinned exactly as it behaved before batch steps
  // existed.
  if (step.over && step.over.length) {
    return advanceBatch(plan, step);
  }

  const { runAgent } = await import('@/lib/agent/loop');
  // G15: a step parked with a GRANTED approval must be resumed through it —
  // otherwise the model just proposes the same sensitive call again and
  // blocks again, forever. G14: ground the step the same way an interactive
  // turn is grounded, so it can actually see the plan's venture profile,
  // account snapshot, memory, and — when the plan has one — the conversation
  // it came from.
  const approve = await grantedApprovalFor(plan, step);
  const { agentContext, transcript } = await groundingFor(plan, step);
  // G16a: the console polls while `running` is true — mark it immediately
  // before the agent turn actually runs, and clear it no matter how the turn
  // ends (including a thrown exception, hence the `finally` below).
  await markRunning(plan);
  try {
    const result = await runAgent({
      accountId: plan.accountId,
      // The plan block is already in the grounding (lib/agent/context.ts), so
      // this names the ONE step rather than restating the objective — otherwise
      // the model re-plans instead of executing.
      // Structured through the same prompt-improver the generation paths use
      // (lib/ai/prompt-improver.ts): GOAL / INPUTS / RULES / DELIVERABLE. A
      // resumed step arrives with no conversational lead-up, so an ad-hoc
      // sentence is exactly the shallow one-liner that scaffolding exists to
      // fix — and every step of every plan should be framed the same way.
      message: improvePrompt({
        goal: `Complete step ${step.seq} of the current plan: ${step.title}`,
        inputs: {
          'Plan objective': plan.objective,
          'This step': step.title,
          'Step id': step.id,
          'Steps already done': String(plan.steps.filter((x) => x.status === 'done').length),
          'Previous step outcome': plan.steps.find((x) => x.seq === step.seq - 1)?.result ?? undefined,
        },
        rules: [
          'Work ONLY this step. Do not start the next one, and do not redo a finished one.',
          'The full plan is in your context above — read it rather than re-planning.',
          'When the step is finished, call completePlanStep with the step id and ONE sentence saying what came of it.',
          'If it genuinely cannot be done because something is missing that only the user can supply, call blockPlanStep with the reason. Do not park work merely because it is hard.',
        ],
        deliverable: 'The step carried out, and completePlanStep (or blockPlanStep) called for it.',
      }),
      conversationId: plan.conversationId ?? undefined,
      brandContext: plan.brandId ? { id: plan.brandId } : undefined,
      maxSteps: STEPS_PER_PLAN_STEP,
      requestedBy: `plan:${plan.id}`,
      // The guidance the plan was written under, not whatever this step's
      // wording would route to — see migration 066.
      pinnedSkills: plan.skills,
      // Same reasoning: the persona the plan was written for, so the voice and
      // judgement do not change between step 1 and step 4.
      ...(plan.personaId ? { personaId: plan.personaId } : {}),
      ...(agentContext ? { agentContext } : {}),
      ...(transcript ? { transcript } : {}),
      ...(approve ? { approve } : {}),
    });

    // The granted approval was either consumed above or turned out to be
    // stale/rejected by the time runAgent looked at it — either way it must
    // not linger on the step and be mistaken for still-usable next tick.
    if (approve && result.status !== 'needs_approval') {
      await clearStepApproval(step.id);
    }

    if (result.status === 'needs_approval') {
      // Phase 3: the step waits on a human, and the approval id is recorded so
      // granting it resumes HERE rather than restarting the plan.
      const summary = result.proposal?.summary || 'Waiting on your approval.';
      await blockStep(step.id, summary, result.proposal?.approvalId ?? null);
      // G16b: a single-shot step blocking is otherwise invisible in the
      // conversation the console is watching.
      await appendProgressLine(plan, `Step ${step.seq} is waiting on your approval: ${summary.slice(0, 200)}`);
      await recordAndNotify(plan, result.steps.length);
      return 'blocked';
    }

    if (result.status === 'error') {
      // Left `in_progress`; the attempts counter already rose when it was
      // claimed, so a repeatedly failing step reaches MAX_STEP_ATTEMPTS and
      // parks itself rather than looping.
      await recordAndNotify(plan, result.steps.length, result.message);
      return 'error';
    }

    // The model is asked to call completePlanStep itself, because it knows what
    // the outcome actually was. If it finished the turn without doing so, close
    // the step here with the answer it gave — leaving it `in_progress` would
    // stall the plan behind a step nothing will ever advance.
    const stillOpen = plan.steps.find((s) => s.id === step.id)?.status !== 'done';
    if (stillOpen) await completeStep(step.id, result.message || 'Completed.');
    // G16b: a single-shot step's completion previously wrote nothing into the
    // conversation at all — only batch ticks got a progress line.
    await appendProgressLine(plan, `Step ${step.seq} done: ${(result.message || 'Completed.').slice(0, 200)}`);
    await recordAndNotify(plan, result.steps.length);
    return 'completed';
  } catch (e: any) {
    await recordAndNotify(plan, 0, String(e?.message || e));
    return 'error';
  } finally {
    await clearRunning(plan);
  }
}

/**
 * Advance ONE tick of a BATCH step: the next ITEMS_PER_STEP_TICK items from
 * `over`, starting at `cursor`, through the SAME runAgent path and the SAME
 * STEPS_PER_PLAN_STEP budget an ordinary step uses — same gates, same
 * approvals, nothing here runs any action a normal step could not also run.
 *
 * The correctness property this exists to hold: no item is ever processed
 * twice, and none is skipped, across a crashed tick, a parked approval, and
 * two concurrent ticks.
 *   - Two concurrent ticks: claimStep already made only one of them own the
 *     step (`in_progress`) before this function runs; advanceCursor's
 *     conditional UPDATE is the same guard one level down, for the same
 *     reason — see its comment in lib/plans/store.ts.
 *   - A crashed/errored tick: releaseStepForRetry puts the step back to
 *     `pending` WITHOUT touching the cursor, so the next tick reclaims it and
 *     redoes the SAME slice rather than skipping ahead.
 *   - A parked approval: blockStep runs instead of advanceCursor, so the
 *     cursor does not move; unblockStep (existing, unchanged) returns the
 *     step to `pending` with the cursor untouched, so it resumes on the same
 *     slice rather than skipping it or repeating an earlier one.
 */
/**
 * Append a short "N of M done" progress line to the plan's own conversation,
 * so a long batch job reports itself the way a human watching would expect —
 * the same reasoning the screenshot this Phase 2 build is modelled on shows.
 *
 * Reuses the EXISTING conversation writer (loadTranscript + saveConversation,
 * lib/agent/memory.ts) rather than inventing a second write path — that pair
 * is already what every agent turn persists through (see e.g.
 * lib/scheduled/store.ts), and saveConversation already carries the guards a
 * hand-rolled append would have to reinvent (stable message ids, the
 * shrink-refusal guard, the deleted-conversation refusal).
 *
 * Best-effort and silent on failure: a missed progress line must not fail the
 * tick that earned it — the plan step itself already completed or advanced by
 * the time this runs. Does nothing when the plan has no conversationId
 * (nothing to append to).
 */
async function appendProgressLine(plan: Plan, text: string): Promise<void> {
  if (!plan.conversationId) return;
  try {
    const { loadTranscript, saveConversation } = await import('@/lib/agent/memory');
    const transcript = await loadTranscript(plan.conversationId, plan.accountId);
    await saveConversation({
      id: plan.conversationId,
      accountId: plan.accountId,
      brandId: plan.brandId ?? null,
      transcript: [...transcript, { role: 'assistant', content: text }],
    });
  } catch {
    // best-effort — see the function comment above.
  }
}

async function advanceBatch(plan: Plan, step: PlanStep): Promise<'completed' | 'blocked' | 'idle' | 'error'> {
  const items = step.over || [];
  const slice = items.slice(step.cursor, step.cursor + ITEMS_PER_STEP_TICK);

  const { runAgent } = await import('@/lib/agent/loop');
  // Same reasoning as the single-shot path above — see grantedApprovalFor and
  // groundingFor's own comments (G15/G14).
  const approve = await grantedApprovalFor(plan, step);
  const { agentContext, transcript } = await groundingFor(plan, step);
  // G16a: same reasoning as the single-shot path above.
  await markRunning(plan);
  try {
    const result = await runAgent({
      accountId: plan.accountId,
      message: improvePrompt({
        goal: `Work step ${step.seq} of the current plan, for this tick's slice of a batch: ${step.title}`,
        inputs: {
          'Plan objective': plan.objective,
          'This step (a batch step)': step.title,
          'Step id': step.id,
          'Items to handle THIS TURN ONLY': slice.join('; '),
          'Progress before this turn': `${step.cursor} of ${step.total} items already done`,
        },
        rules: [
          `Work ONLY the ${slice.length} item(s) listed above — the rest of the list belongs to later turns, not this one.`,
          'The full plan is in your context above — read it rather than re-planning.',
          'This step spans many turns. Do NOT call completePlanStep for it — the system advances and completes it automatically as items finish.',
          'If the batch genuinely cannot proceed because something only the user can supply is missing, call blockPlanStep with the reason. Do not park it merely because it is hard.',
        ],
        deliverable: `Each of the ${slice.length} listed item(s) handled, exactly as this step describes.`,
      }),
      conversationId: plan.conversationId ?? undefined,
      brandContext: plan.brandId ? { id: plan.brandId } : undefined,
      maxSteps: STEPS_PER_PLAN_STEP,
      requestedBy: `plan:${plan.id}`,
      pinnedSkills: plan.skills,
      ...(plan.personaId ? { personaId: plan.personaId } : {}),
      ...(agentContext ? { agentContext } : {}),
      ...(transcript ? { transcript } : {}),
      ...(approve ? { approve } : {}),
    });

    if (approve && result.status !== 'needs_approval') {
      await clearStepApproval(step.id);
    }

    if (result.status === 'needs_approval') {
      const summary = result.proposal?.summary || 'Waiting on your approval.';
      await blockStep(step.id, summary, result.proposal?.approvalId ?? null);
      // G16b: same line the single-shot path writes — a batch step blocking
      // on approval is otherwise as invisible as a single-shot one was.
      await appendProgressLine(plan, `Step ${step.seq} is waiting on your approval: ${summary.slice(0, 200)}`);
      await recordAndNotify(plan, result.steps.length);
      return 'blocked';
    }

    if (result.status === 'error') {
      // Re-claimable next tick, cursor untouched — see the function comment.
      await releaseStepForRetry(step.id);
      await recordAndNotify(plan, result.steps.length, result.message);
      return 'error';
    }

    const progress = await advanceCursor(step.id, slice.length);
    if (!progress) {
      // Lost the race to another tick, or the model closed the step itself
      // against instructions — either way there is nothing safe to do this
      // tick. Not an error: the next tick re-reads real state.
      await recordAndNotify(plan, result.steps.length);
      return 'idle';
    }

    // Report the tick's advance into the conversation, whether or not this
    // was the tick that finished the batch — see appendProgressLine's own
    // comment for why this reuses the existing conversation writer.
    await appendProgressLine(plan, `${progress.cursor} of ${progress.total} done.`);

    if (progress.done) {
      await completeStep(step.id, result.message || `Completed all ${progress.total} items.`);
      await recordAndNotify(plan, result.steps.length);
      return 'completed';
    }

    await recordAndNotify(plan, result.steps.length);
    return 'idle';
  } catch (e: any) {
    await releaseStepForRetry(step.id);
    await recordAndNotify(plan, 0, String(e?.message || e));
    return 'error';
  } finally {
    await clearRunning(plan);
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
