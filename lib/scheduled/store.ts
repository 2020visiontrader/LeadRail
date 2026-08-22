// Account-scoped CRUD + sweep runner for scheduled_tasks (migration
// 027_scheduled_tasks.sql). Named intervals ONLY — hourly/daily/weekly. No
// cron expression parsing, by design (keeps this file trivial and un-stallable).
//
// runDueScheduledTasks() is called from two places: the standalone
// app/api/scheduled-tasks/run-due route (Bearer APP_API_SECRET, for an
// external scheduler) and, if wired, the existing hermes tick handler.

import { supabase } from '@/lib/db';
import { loadAgentContext } from '@/lib/agent/context';
import { createNotification } from '@/lib/notifications/store';

// runAgent is imported lazily (inside runDueScheduledTasks, not here at
// module top level) — same reasoning as logUsage's lazy `@/lib/credits`
// import in lib/ai/router.ts. lib/capabilities/registry.ts -> this module ->
// lib/agent/loop.ts -> lib/agent/tools.ts -> lib/capabilities/registry.ts is
// a cycle; a top-level import here makes it live the moment scheduled.ts is
// registered, and under vitest's resetModules()+dynamic-import
// (tests/parity.test.ts) that leaves CAPABILITIES undefined mid-import. A
// dynamic import deferred until the function actually runs breaks the cycle
// at load time without changing anything about how runAgent's result is used.

export type ScheduledInterval = 'hourly' | 'daily' | 'weekly';

export interface ScheduledTaskRow {
  id: string;
  account_id: string;
  /** Optional venture scope (migration 043). ADDITIVE — null = account-wide,
   *  which is every pre-043 row. Used only to ground the background run. */
  brand_id: string | null;
  name: string;
  prompt: string;
  interval: ScheduledInterval;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  /** 'ok' | 'needs_approval' | 'error' | null (never run). */
  last_status: string | null;
  last_result: string | null;
  created_at: string;
  updated_at: string;
}

const RESULT_TRUNCATE_LEN = 2000;

/** Trivial named-interval math. NOT a cron parser — hourly/daily/weekly only. */
export function computeNextRun(interval: ScheduledInterval, from: Date = new Date()): Date {
  const next = new Date(from);
  switch (interval) {
    case 'hourly':
      next.setHours(next.getHours() + 1);
      break;
    case 'weekly':
      next.setDate(next.getDate() + 7);
      break;
    case 'daily':
    default:
      next.setDate(next.getDate() + 1);
      break;
  }
  return next;
}

export async function listScheduledTasks(accountId: string): Promise<ScheduledTaskRow[]> {
  const { data, error } = await supabase
    .from('scheduled_tasks')
    .select('*')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function getScheduledTask(accountId: string, id: string): Promise<ScheduledTaskRow | null> {
  const { data, error } = await supabase
    .from('scheduled_tasks')
    .select('*')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function createScheduledTask(accountId: string, input: {
  name: string; prompt: string; interval: ScheduledInterval; enabled?: boolean;
}): Promise<ScheduledTaskRow> {
  const row = {
    account_id: accountId,
    name: input.name,
    prompt: input.prompt,
    interval: input.interval,
    enabled: input.enabled ?? true,
    next_run_at: computeNextRun(input.interval).toISOString(),
  };
  const { data, error } = await supabase.from('scheduled_tasks').insert([row]).select().single();
  if (error) throw error;
  return data;
}

export async function updateScheduledTask(accountId: string, id: string, patch: {
  name?: string; prompt?: string; interval?: ScheduledInterval; enabled?: boolean;
}): Promise<ScheduledTaskRow> {
  const row: Record<string, any> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.prompt !== undefined) row.prompt = patch.prompt;
  if (patch.enabled !== undefined) row.enabled = patch.enabled;
  if (patch.interval !== undefined) {
    row.interval = patch.interval;
    // Interval changed — recompute the next run from now so the new cadence
    // takes effect immediately instead of waiting out the old schedule.
    row.next_run_at = computeNextRun(patch.interval).toISOString();
  }
  const { data, error } = await supabase
    .from('scheduled_tasks')
    .update(row)
    .eq('id', id)
    .eq('account_id', accountId)
    .select()
    .single();
  if (error) throw error;
  if (!data) throw new Error('scheduled task not found');
  return data;
}

export async function deleteScheduledTask(accountId: string, id: string): Promise<{ id: string; deleted: true }> {
  const { data, error } = await supabase
    .from('scheduled_tasks')
    .delete()
    .eq('id', id)
    .eq('account_id', accountId)
    .select('id');
  if (error) throw error;
  if (!data || !data.length) throw new Error('scheduled task not found');
  return { id, deleted: true };
}

/**
 * Grounding for an unattended run (Packet 3.1). Mirrors what the chat routes
 * assemble (app/api/agent/route.ts): venture name resolved account-scoped, then
 * the full loadAgentContext block keyed on the task prompt.
 *
 * Best-effort BY DESIGN: a background job has no human to retry it, so a
 * grounding read that fails must cost the run some context, never the run
 * itself. Both catches are therefore silent — this is a read, not a gate.
 */
async function groundingFor(task: ScheduledTaskRow): Promise<{
  agentContext?: string;
  brandName?: string;
  brandId?: string;
}> {
  let brandName: string | undefined;
  if (task.brand_id) {
    try {
      // account_id is filtered IN THE QUERY: a background job has no session to
      // fall back on, so an unscoped read here would be silent cross-tenant access.
      const { data } = await supabase
        .from('brands')
        .select('name')
        .eq('id', task.brand_id)
        .eq('account_id', task.account_id)
        .maybeSingle();
      brandName = data?.name || undefined;
    } catch { /* venture name omitted — grounding degrades, run continues */ }
  }
  try {
    const agentContext = await loadAgentContext({
      accountId: task.account_id,
      brandId: task.brand_id ?? undefined,
      brandName,
      query: task.prompt,
    });
    return { agentContext, brandName, brandId: task.brand_id ?? undefined };
  } catch {
    // No context block at all — the run still happens, just ungrounded.
    return { brandName };
  }
}

/**
 * Sweep due tasks (enabled AND next_run_at <= now), run each through the
 * existing agent loop, and record the outcome. Bounded to 25 per call.
 * Each task is wrapped in its own try/catch so one failure never stops the
 * sweep — the loop always finishes and reports a per-task result.
 *
 * All three runAgent statuses are handled explicitly (Packet 3.1). Before, only
 * throw-vs-return existed, so a `needs_approval` return recorded 'ok' with the
 * proposal text as its result: a task that hit a sensitive tool did nothing and
 * reported success, with nobody watching to notice.
 */
export async function runDueScheduledTasks(): Promise<{
  processed: number;
  results: { id: string; ok: boolean; status?: string; error?: string }[];
}> {
  const nowIso = new Date().toISOString();
  const { data: due, error } = await supabase
    .from('scheduled_tasks')
    .select('*')
    .eq('enabled', true)
    .lte('next_run_at', nowIso)
    .limit(25);
  if (error) throw error;

  const results: { id: string; ok: boolean; status?: string; error?: string }[] = [];

  const { runAgent } = await import('@/lib/agent/loop');

  for (const task of (due || []) as ScheduledTaskRow[]) {
    try {
      const { agentContext, brandName, brandId } = await groundingFor(task);
      const agentResult = await runAgent({
        accountId: task.account_id,
        message: task.prompt,
        agentContext,
        brandContext: (brandId || brandName) ? { id: brandId, name: brandName } : undefined,
      });

      if (agentResult?.status === 'needs_approval') {
        // The run proposed a sensitive action and stopped. It did NOT execute.
        // Record that plainly and tell a human — an unattended run that needs a
        // decision is worthless if nothing surfaces it.
        const approvalId = agentResult.proposal?.approvalId;
        const summary = (agentResult.message || '').slice(0, RESULT_TRUNCATE_LEN);
        const lastResult = (approvalId ? `approval_id=${approvalId}; ${summary}` : summary)
          .slice(0, RESULT_TRUNCATE_LEN);
        await supabase
          .from('scheduled_tasks')
          .update({
            last_run_at: new Date().toISOString(),
            last_status: 'needs_approval',
            last_result: lastResult,
            next_run_at: computeNextRun(task.interval).toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', task.id)
          .eq('account_id', task.account_id);
        // Best-effort notify: a failed bell entry must not turn a correctly
        // halted run into a failed one.
        try {
          await createNotification(task.account_id, {
            type: 'scheduled_task',
            title: `Scheduled task "${task.name}" needs your approval`,
            body: lastResult,
          });
        } catch { /* notification is best-effort */ }
        results.push({ id: task.id, ok: false, status: 'needs_approval' });
        continue;
      }

      if (agentResult?.status === 'error') {
        // runAgent returns errors as a value, not a throw — record it as an
        // error rather than letting it pass as 'ok'.
        const errMsg = (agentResult.message || 'agent error').slice(0, RESULT_TRUNCATE_LEN);
        await supabase
          .from('scheduled_tasks')
          .update({
            last_run_at: new Date().toISOString(),
            last_status: 'error',
            last_result: errMsg,
            next_run_at: computeNextRun(task.interval).toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', task.id)
          .eq('account_id', task.account_id);
        results.push({ id: task.id, ok: false, status: 'error', error: errMsg });
        continue;
      }

      const resultText = (agentResult?.message || '').slice(0, RESULT_TRUNCATE_LEN);
      await supabase
        .from('scheduled_tasks')
        .update({
          last_run_at: new Date().toISOString(),
          last_status: 'ok',
          last_result: resultText,
          next_run_at: computeNextRun(task.interval).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', task.id)
        .eq('account_id', task.account_id);
      results.push({ id: task.id, ok: true, status: 'ok' });
    } catch (e: any) {
      const errMsg = String(e?.message || e).slice(0, RESULT_TRUNCATE_LEN);
      await supabase
        .from('scheduled_tasks')
        .update({
          last_run_at: new Date().toISOString(),
          last_status: 'error',
          last_result: errMsg,
          next_run_at: computeNextRun(task.interval).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', task.id)
        .eq('account_id', task.account_id)
        .then(() => {}, () => {});
      results.push({ id: task.id, ok: false, status: 'error', error: errMsg });
    }
  }

  return { processed: results.length, results };
}
