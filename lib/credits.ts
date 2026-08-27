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

/**
 * Record one AI-registry call into the ai_usage ledger (migration 023).
 * Separate from the credit_transactions balance ledger above — this is a
 * technical/observability log of who answered a generateText/generateChat
 * call and what it cost, not a billing mutation. Best-effort: a logging
 * failure never breaks the caller's actual AI response. Callers that also
 * want to spend AI credits still call applyCredits() themselves, keyed off
 * the returned usage id, so nothing here double-bills.
 */
export async function recordAiUsage(entry: {
  accountId: string;
  providerId?: string | null;
  modelId?: string | null;
  modelLabel?: string | null;
  kind: 'text' | 'chat';
  tokensIn?: number | null;
  tokensOut?: number | null;
  latencyMs?: number | null;
  ok: boolean;
  error?: string | null;
  /** agent_conversations.id, when the caller has one (migration 060). Absent
   *  for every pre-060 caller, so those rows keep the NULL they always had. */
  conversationId?: string | null;
}): Promise<string | null> {
  try {
    const { data } = await supabase.from('ai_usage').insert([{
      account_id: entry.accountId,
      provider_id: entry.providerId ?? null,
      model_id: entry.modelId ?? null,
      model_label: entry.modelLabel ?? null,
      kind: entry.kind,
      tokens_in: entry.tokensIn ?? null,
      tokens_out: entry.tokensOut ?? null,
      latency_ms: entry.latencyMs ?? null,
      ok: entry.ok,
      error: entry.error ?? null,
      conversation_id: entry.conversationId ?? null,
    }])
      // The id is returned so the CALLER can later record whether the response
      // it got was actually usable — see markParseOutcome. Nothing else changes
      // about this insert; returning null on failure keeps it best-effort.
      .select('id')
      .single();
    return (data as any)?.id ?? null;
  } catch {
    // best-effort; never break the caller's AI response over a logging failure
    return null;
  }
}

/**
 * Record whether a response that was already logged turned out to be usable.
 *
 * `ok` on an ai_usage row is written the moment a tier returns text, which is
 * the only thing the router knows. Whether that text satisfied the caller's
 * contract — for the agent loop, being one parseable JSON envelope — is a fact
 * only the caller learns, and later. Without this the two were the same column,
 * and a model answering in prose was indistinguishable from a real success.
 *
 * Best-effort and fire-and-forget, exactly like the insert above: an
 * observability write must never fail a turn the user is waiting on.
 */
export async function markParseOutcome(usageRowId: string, parseOk: boolean): Promise<void> {
  try {
    await supabase.from('ai_usage').update({ parse_ok: parseOk }).eq('id', usageRowId);
  } catch {
    /* best-effort */
  }
}

export interface AiUsageSummaryRow {
  provider_id: string | null;
  model_id: string | null;
  model_label: string | null;
  calls: number;
  ok_calls: number;
  tokens_in: number;
  tokens_out: number;
}

/** Aggregate ai_usage for an account, most-used first. Used by the Settings→Models usage view. */
export async function getAiUsageSummary(accountId: string, sinceDays = 30): Promise<AiUsageSummaryRow[]> {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('ai_usage')
    .select('provider_id, model_id, model_label, tokens_in, tokens_out, ok')
    .eq('account_id', accountId)
    .gte('created_at', since);
  if (error) throw error;
  const rows = data || [];
  const byModel = new Map<string, AiUsageSummaryRow>();
  for (const r of rows as any[]) {
    const key = `${r.provider_id || 'none'}:${r.model_id || 'none'}`;
    const row = byModel.get(key) || {
      provider_id: r.provider_id, model_id: r.model_id, model_label: r.model_label,
      calls: 0, ok_calls: 0, tokens_in: 0, tokens_out: 0,
    };
    row.calls += 1;
    if (r.ok) row.ok_calls += 1;
    row.tokens_in += r.tokens_in || 0;
    row.tokens_out += r.tokens_out || 0;
    byModel.set(key, row);
  }
  return Array.from(byModel.values()).sort((a, b) => b.calls - a.calls);
}
