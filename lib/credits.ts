// AI-credit wallet. Referral rewards are paid in credits only (never cash).
import { supabase } from '@/lib/db';

// Monthly AI-credit allocation per plan — the base a referral % is taken from.
// Single source of truth for LeadRail plan credits (adjust as pricing firms up).
export const PLAN_CREDITS: Record<string, number> = {
  free: 200,
  pro: 2000,
  enterprise: 10000,
};

export function planCredits(plan?: string | null): number {
  const key = (plan || 'free').toLowerCase();
  return PLAN_CREDITS[key] ?? PLAN_CREDITS.free;
}

/**
 * Atomically add (or subtract) credits and append the ledger row in one DB
 * statement (no lost updates under concurrency). account_id must be
 * server-derived — never a client-supplied value. Returns the new balance.
 */
export async function applyCredits(
  accountId: string, delta: number, reason: string, refId?: string,
): Promise<number | null> {
  const { data, error } = await supabase.rpc('apply_credits', {
    p_account: accountId, p_delta: Math.round(delta), p_reason: reason, p_ref: refId ?? null,
  });
  if (error) return null;
  return typeof data === 'number' ? data : null;
}

export async function getBalance(accountId: string): Promise<number> {
  const { data } = await supabase.from('accounts').select('credit_balance').eq('id', accountId).maybeSingle();
  return data?.credit_balance ?? 0;
}
