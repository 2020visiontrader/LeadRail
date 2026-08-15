// Account-scoped spend budgets / credit caps (migration 033_budgets.sql).
// `spent` is always computed live from credit_transactions (sum of negative
// deltas this UTC month) rather than a running counter, so it can never drift.

import { supabase } from '@/lib/db';

export interface AccountBudgetRow {
  id: string;
  account_id: string;
  monthly_limit_credits: number | null;
  alert_threshold_pct: number;
  hard_stop: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface BudgetStatus {
  enabled: boolean;
  limit: number | null;
  spent: number;
  remaining: number | null;
  pct: number;
  alert: boolean;
  overLimit: boolean;
}

export async function getBudget(accountId: string): Promise<AccountBudgetRow | null> {
  const { data, error } = await supabase
    .from('account_budgets')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function upsertBudget(accountId: string, patch: {
  monthly_limit_credits?: number | null;
  alert_threshold_pct?: number;
  hard_stop?: boolean;
  enabled?: boolean;
}): Promise<AccountBudgetRow> {
  const row: Record<string, any> = {
    account_id: accountId,
    updated_at: new Date().toISOString(),
  };
  if (patch.monthly_limit_credits !== undefined) row.monthly_limit_credits = patch.monthly_limit_credits;
  if (patch.alert_threshold_pct !== undefined) row.alert_threshold_pct = patch.alert_threshold_pct;
  if (patch.hard_stop !== undefined) row.hard_stop = patch.hard_stop;
  if (patch.enabled !== undefined) row.enabled = patch.enabled;

  const { data, error } = await supabase
    .from('account_budgets')
    .upsert([row], { onConflict: 'account_id' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

function monthStartISO(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export async function getBudgetStatus(accountId: string): Promise<BudgetStatus> {
  const budget = await getBudget(accountId);
  const enabled = Boolean(budget?.enabled);
  const limit = budget?.monthly_limit_credits ?? null;
  const alertThresholdPct = budget?.alert_threshold_pct ?? 80;

  const { data, error } = await supabase
    .from('credit_transactions')
    .select('delta')
    .eq('account_id', accountId)
    .lt('delta', 0)
    .gte('created_at', monthStartISO());
  if (error) throw error;

  const total = (data || []).reduce((sum, row: any) => sum + (row.delta || 0), 0);
  const spent = Math.abs(total);

  const pct = limit ? Math.round((spent / limit) * 100) : 0;
  const alert = Boolean(enabled && limit && pct >= alertThresholdPct);
  const overLimit = Boolean(enabled && limit && spent >= limit);
  const remaining = limit != null ? limit - spent : null;

  return { enabled, limit, spent, remaining, pct, alert, overLimit };
}

/**
 * Backward-compatible spend gate: allowed=false ONLY when budgets are
 * enabled, hard_stop is on, and the account is already over its limit.
 * With no budget row (or enabled=false), this always returns allowed=true —
 * existing callers see no behavior change unless the operator opts in.
 */
export async function checkBudget(accountId: string): Promise<{ allowed: boolean; reason?: string }> {
  const status = await getBudgetStatus(accountId);
  if (status.enabled && status.overLimit) {
    const budget = await getBudget(accountId);
    if (budget?.hard_stop) {
      return { allowed: false, reason: 'Monthly spend limit reached' };
    }
  }
  return { allowed: true };
}
