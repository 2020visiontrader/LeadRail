// Durable plans (migration 063) — the cursor for agentic work.
//
// Every mutation here defends one of three invariants:
//   1. AT MOST ONE step in_progress per plan. The database enforces it; this
//      file must not create a situation where it fires.
//   2. BUDGETS ARE CEILINGS, NOT SUGGESTIONS. steps_used only ever rises, and
//      nothing in the agent path may raise max_steps — only a human.
//   3. A STEP THAT KEEPS FAILING STOPS. attempts is incremented before work,
//      not after success, so a step that crashes mid-run still counts.

import { supabase } from '@/lib/db';
import { log } from '@/lib/logger';

export type PlanStatus = 'draft' | 'running' | 'blocked' | 'done' | 'cancelled' | 'failed';
export type StepStatus = 'pending' | 'in_progress' | 'done' | 'blocked' | 'skipped';

/** Attempts on one step before it is blocked for a human. Three is enough to
 *  ride out a flaky upstream and few enough that an impossible step surfaces
 *  quickly instead of eating the plan's budget. */
export const MAX_STEP_ATTEMPTS = Number(process.env.PLAN_MAX_STEP_ATTEMPTS) || 3;
/** Default total agent steps across every resumption of one plan. */
export const DEFAULT_PLAN_BUDGET = Number(process.env.PLAN_MAX_STEPS) || 200;
/** How long a plan may stay runnable. A plan that has not finished in a day is
 *  not going to; it should surface rather than linger. */
export const PLAN_TTL_MS = Number(process.env.PLAN_TTL_MS) || 24 * 60 * 60 * 1000;
/** Most steps one plan may contain. A "plan" of 400 items is a list operation
 *  the model should be batching, not a plan. */
export const MAX_PLAN_STEPS = Number(process.env.PLAN_MAX_STEP_COUNT) || 40;

export interface PlanStep {
  id: string;
  seq: number;
  title: string;
  status: StepStatus;
  result: string | null;
  attempts: number;
  blockedReason: string | null;
  approvalId: string | null;
}

export interface Plan {
  id: string;
  accountId: string;
  conversationId: string | null;
  brandId: string | null;
  objective: string;
  status: PlanStatus;
  maxSteps: number;
  stepsUsed: number;
  expiresAt: string;
  lastError: string | null;
  steps: PlanStep[];
}

function toStep(r: any): PlanStep {
  return {
    id: r.id, seq: r.seq, title: r.title, status: r.status,
    result: r.result ?? null, attempts: r.attempts ?? 0,
    blockedReason: r.blocked_reason ?? null, approvalId: r.approval_id ?? null,
  };
}

function toPlan(r: any, steps: any[]): Plan {
  return {
    id: r.id, accountId: r.account_id, conversationId: r.conversation_id ?? null,
    brandId: r.brand_id ?? null, objective: r.objective, status: r.status,
    maxSteps: r.max_steps, stepsUsed: r.steps_used, expiresAt: r.expires_at,
    lastError: r.last_error ?? null,
    steps: steps.map(toStep).sort((a, b) => a.seq - b.seq),
  };
}

/**
 * Create a plan and its steps.
 *
 * Starts in `draft` when `requireApproval` — that is plan mode: the plan is
 * written and shown, and nothing runs until a human says go. Otherwise it
 * starts `running`, which is the normal in-chat behaviour where the operator is
 * watching anyway.
 */
export async function createPlan(args: {
  accountId: string;
  objective: string;
  steps: string[];
  conversationId?: string | null;
  brandId?: string | null;
  createdBy?: string | null;
  maxSteps?: number;
  requireApproval?: boolean;
}): Promise<Plan | null> {
  const titles = args.steps.map((s) => String(s || '').trim()).filter(Boolean).slice(0, MAX_PLAN_STEPS);
  if (!titles.length) return null;

  try {
    const { data: planRow, error } = await supabase
      .from('agent_plans')
      .insert([{
        account_id: args.accountId,
        conversation_id: args.conversationId ?? null,
        brand_id: args.brandId ?? null,
        objective: args.objective.slice(0, 2000),
        status: args.requireApproval ? 'draft' : 'running',
        // Clamped: a caller cannot mint itself a bigger budget than the ceiling.
        max_steps: Math.min(Math.max(1, args.maxSteps ?? DEFAULT_PLAN_BUDGET), DEFAULT_PLAN_BUDGET),
        expires_at: new Date(Date.now() + PLAN_TTL_MS).toISOString(),
        created_by: args.createdBy ?? null,
      }])
      .select()
      .single();
    if (error || !planRow) return null;

    const { data: stepRows, error: stepErr } = await supabase
      .from('agent_plan_steps')
      .insert(titles.map((title, i) => ({ plan_id: (planRow as any).id, seq: i + 1, title: title.slice(0, 500) })))
      .select();
    if (stepErr) {
      // A plan with no steps is a plan that will spin. Remove it rather than
      // leave a runnable husk in the queue.
      await supabase.from('agent_plans').delete().eq('id', (planRow as any).id);
      return null;
    }
    log.info('plan: created', {
      accountId: args.accountId, steps: titles.length,
      status: (planRow as any).status, actorEmail: args.createdBy ?? undefined,
    });
    return toPlan(planRow, stepRows || []);
  } catch {
    return null;
  }
}

export async function getPlan(accountId: string, planId: string): Promise<Plan | null> {
  try {
    const { data: p } = await supabase
      .from('agent_plans').select('*').eq('account_id', accountId).eq('id', planId).maybeSingle();
    if (!p) return null;
    const { data: s } = await supabase.from('agent_plan_steps').select('*').eq('plan_id', planId);
    return toPlan(p, s || []);
  } catch {
    return null;
  }
}

/** The plan currently attached to a conversation, if any. */
export async function activePlanForConversation(accountId: string, conversationId: string): Promise<Plan | null> {
  try {
    const { data } = await supabase
      .from('agent_plans')
      .select('*')
      .eq('account_id', accountId)
      .eq('conversation_id', conversationId)
      .in('status', ['draft', 'running', 'blocked'])
      .order('created_at', { ascending: false })
      .limit(1);
    const row = Array.isArray(data) ? data[0] : null;
    if (!row) return null;
    const { data: s } = await supabase.from('agent_plan_steps').select('*').eq('plan_id', row.id);
    return toPlan(row, s || []);
  } catch {
    return null;
  }
}

/** Plans with work to do, for the runner. Ordered least-recently-run so one
 *  busy plan cannot starve the others. */
export async function runnablePlans(limit = 3): Promise<Plan[]> {
  try {
    const { data } = await supabase
      .from('agent_plans')
      .select('*')
      .eq('status', 'running')
      .gt('expires_at', new Date().toISOString())
      .order('last_run_at', { ascending: true, nullsFirst: true })
      .limit(limit);
    if (!Array.isArray(data) || !data.length) return [];
    const out: Plan[] = [];
    for (const row of data) {
      const { data: s } = await supabase.from('agent_plan_steps').select('*').eq('plan_id', row.id);
      out.push(toPlan(row, s || []));
    }
    return out;
  } catch {
    return [];
  }
}

/** The next step to work: the one already in progress, else the first pending.
 *  Returns null when the plan is finished or every remaining step is blocked. */
export function nextStep(plan: Plan): PlanStep | null {
  return plan.steps.find((s) => s.status === 'in_progress')
    ?? plan.steps.find((s) => s.status === 'pending')
    ?? null;
}

/** Claim a step, atomically enough for the single-active invariant.
 *
 *  The conditional `.eq('status', 'pending')` is the guard: two concurrent
 *  runners racing the same plan will see one update return a row and the other
 *  return none. The partial unique index is the backstop if both somehow pass.
 *  `attempts` rises HERE, before the work, so a step that dies mid-run still
 *  counts against its limit — otherwise a crashing step retries forever. */
export async function claimStep(planId: string, stepId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('agent_plan_steps')
      .update({
        status: 'in_progress',
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', stepId)
      .eq('plan_id', planId)
      .eq('status', 'pending')
      .select('id, attempts');
    if (error || !Array.isArray(data) || !data.length) return false;
    await supabase
      .from('agent_plan_steps')
      .update({ attempts: ((data[0] as any).attempts ?? 0) + 1 })
      .eq('id', stepId);
    return true;
  } catch {
    return false;
  }
}

export async function completeStep(stepId: string, result: string): Promise<void> {
  try {
    await supabase.from('agent_plan_steps').update({
      status: 'done', result: result.slice(0, 4000),
      finished_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq('id', stepId);
  } catch { /* the runner re-reads state next tick */ }
}

/** Park a step for a human. `approvalId` links the card that halted it, so
 *  resuming continues from HERE rather than restarting the plan. */
export async function blockStep(stepId: string, reason: string, approvalId?: string | null): Promise<void> {
  try {
    await supabase.from('agent_plan_steps').update({
      status: 'blocked', blocked_reason: reason.slice(0, 1000),
      approval_id: approvalId ?? null, updated_at: new Date().toISOString(),
    }).eq('id', stepId);
  } catch { /* best-effort */ }
}

/** Release a step back to pending — used when an approval it waited on is
 *  granted. Deliberately does NOT reset `attempts`: a step that failed twice
 *  and then blocked has still failed twice. */
export async function unblockStep(accountId: string, stepId: string): Promise<boolean> {
  try {
    const { data } = await supabase
      .from('agent_plan_steps')
      .update({ status: 'pending', blocked_reason: null, updated_at: new Date().toISOString() })
      .eq('id', stepId)
      .eq('status', 'blocked')
      .select('id, plan_id');
    if (!Array.isArray(data) || !data.length) return false;
    // A plan is only blocked because a step was; releasing one makes it
    // runnable again.
    await supabase.from('agent_plans')
      .update({ status: 'running', updated_at: new Date().toISOString() })
      .eq('id', (data[0] as any).plan_id)
      .eq('account_id', accountId)
      .eq('status', 'blocked');
    return true;
  } catch {
    return false;
  }
}

/** Record steps spent and re-evaluate the plan's own status.
 *
 *  This is the only place a plan reaches a terminal state, so the exhaustion
 *  and completion rules live together rather than being re-derived by callers. */
export async function recordProgress(planId: string, stepsSpent: number, error?: string | null): Promise<PlanStatus | null> {
  try {
    const { data: p } = await supabase.from('agent_plans').select('*').eq('id', planId).maybeSingle();
    if (!p) return null;
    const used = ((p as any).steps_used ?? 0) + Math.max(0, stepsSpent);
    const { data: steps } = await supabase.from('agent_plan_steps').select('status, attempts').eq('plan_id', planId);
    const rows = (steps || []) as any[];

    const unresolved = rows.filter((s) => s.status === 'pending' || s.status === 'in_progress');
    const blocked = rows.filter((s) => s.status === 'blocked');

    let status: PlanStatus = (p as any).status;
    if (!unresolved.length && !blocked.length) status = 'done';
    else if (used >= (p as any).max_steps) status = 'failed';
    else if (!unresolved.length && blocked.length) status = 'blocked';
    else status = 'running';

    await supabase.from('agent_plans').update({
      steps_used: used,
      status,
      last_run_at: new Date().toISOString(),
      last_error: error ? String(error).slice(0, 1000) : (p as any).last_error,
      updated_at: new Date().toISOString(),
    }).eq('id', planId);

    if (status === 'failed') {
      log.warn('plan: budget exhausted', { planId, used, maxSteps: (p as any).max_steps });
    }
    return status;
  } catch {
    return null;
  }
}

/** Approve a draft plan into a running one — the "go" in plan mode. */
export async function approvePlan(accountId: string, planId: string): Promise<boolean> {
  try {
    const { data } = await supabase.from('agent_plans')
      .update({ status: 'running', updated_at: new Date().toISOString() })
      .eq('account_id', accountId).eq('id', planId).eq('status', 'draft')
      .select('id');
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

/** Stop a plan. The kill switch — reachable for one plan or, with no id, for
 *  every live plan on the account. */
export async function cancelPlans(accountId: string, planId?: string): Promise<number> {
  try {
    let q = supabase.from('agent_plans')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('account_id', accountId)
      .in('status', ['draft', 'running', 'blocked']);
    if (planId) q = q.eq('id', planId);
    const { data } = await q.select('id');
    return Array.isArray(data) ? data.length : 0;
  } catch {
    return 0;
  }
}

/** The plan block spliced into a turn's grounding.
 *
 *  This is the point of the whole table: the model reads "step 7 of 20, here is
 *  what is done" instead of reconstructing it from a transcript that may have
 *  been truncated. */
export function renderPlan(plan: Plan): string {
  const done = plan.steps.filter((s) => s.status === 'done').length;
  const lines = [
    `CURRENT PLAN — "${plan.objective}" (${done}/${plan.steps.length} steps done, ${plan.stepsUsed}/${plan.maxSteps} of the step budget used).`,
    'Work the FIRST step that is not done. Do not restart the plan and do not redo a finished step.',
    '',
    ...plan.steps.map((s) => {
      const mark = s.status === 'done' ? 'x'
        : s.status === 'in_progress' ? '>'
        : s.status === 'blocked' ? '!'
        : s.status === 'skipped' ? '-' : ' ';
      const detail = s.status === 'done' && s.result ? ` — ${s.result.slice(0, 200)}`
        : s.status === 'blocked' && s.blockedReason ? ` — WAITING: ${s.blockedReason.slice(0, 200)}`
        : '';
      return `[${mark}] ${s.seq}. ${s.title}${detail}`;
    }),
  ];
  return lines.join('\n');
}
