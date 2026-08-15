// Account-scoped CRUD + sweep runner for scheduled_tasks (migration
// 027_scheduled_tasks.sql). Named intervals ONLY — hourly/daily/weekly. No
// cron expression parsing, by design (keeps this file trivial and un-stallable).
//
// runDueScheduledTasks() is called from two places: the standalone
// app/api/scheduled-tasks/run-due route (Bearer APP_API_SECRET, for an
// external scheduler) and, if wired, the existing hermes tick handler.

import { supabase } from '@/lib/db';
import { runAgent } from '@/lib/agent/loop';

export type ScheduledInterval = 'hourly' | 'daily' | 'weekly';

export interface ScheduledTaskRow {
  id: string;
  account_id: string;
  name: string;
  prompt: string;
  interval: ScheduledInterval;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
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
 * Sweep due tasks (enabled AND next_run_at <= now), run each through the
 * existing agent loop, and record the outcome. Bounded to 25 per call.
 * Each task is wrapped in its own try/catch so one failure never stops the
 * sweep — the loop always finishes and reports a per-task result.
 */
export async function runDueScheduledTasks(): Promise<{
  processed: number;
  results: { id: string; ok: boolean; error?: string }[];
}> {
  const nowIso = new Date().toISOString();
  const { data: due, error } = await supabase
    .from('scheduled_tasks')
    .select('*')
    .eq('enabled', true)
    .lte('next_run_at', nowIso)
    .limit(25);
  if (error) throw error;

  const results: { id: string; ok: boolean; error?: string }[] = [];

  for (const task of (due || []) as ScheduledTaskRow[]) {
    try {
      const agentResult = await runAgent({ accountId: task.account_id, message: task.prompt });
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
      results.push({ id: task.id, ok: true });
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
      results.push({ id: task.id, ok: false, error: errMsg });
    }
  }

  return { processed: results.length, results };
}
