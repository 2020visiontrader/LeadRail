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
  /** Why tokensIn/tokensOut are (or are not) populated (migration 075). Every
   *  caller now passes this explicitly via lib/ai/router.ts::logUsage; the
   *  defaults here exist only for a caller that predates 075 and would
   *  otherwise fail the NOT NULL column — 'not_attempted'/'none' is the
   *  honest read for "this call did not go through usage classification",
   *  never a guess at what actually happened. */
  usageStatus?: 'reported' | 'provider_not_reported' | 'capture_failed' | 'not_attempted' | 'not_applicable';
  usageSource?: 'provider' | 'estimated' | 'none';
  /** Provider-reported call duration in ms (migration 078) — distinct from
   *  `latencyMs` above, which is our own wrapper's elapsed clock and is always
   *  present. Null when the provider reported nothing; `timingStatus` says
   *  why, same convention as `usageStatus` for tokens. */
  providerLatencyMs?: number | null;
  timingStatus?: 'reported' | 'provider_not_reported' | 'capture_failed' | 'not_attempted' | 'not_applicable';
  timingSource?: 'provider' | 'estimated' | 'none';
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
      usage_status: entry.usageStatus ?? 'not_attempted',
      usage_source: entry.usageSource ?? 'none',
      provider_latency_ms: entry.providerLatencyMs ?? null,
      timing_status: entry.timingStatus ?? 'not_attempted',
      timing_source: entry.timingSource ?? 'none',
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
  /** PROVIDER-REPORTED tokens only. Rows whose `usage_source` is 'estimated'
   *  are excluded and counted separately below — see the header comment. */
  tokens_in: number;
  tokens_out: number;
  /** Tokens this codebase estimated for calls the provider never costed —
   *  today, failed calls (lib/ai/router.ts::failureUsage). Kept apart from
   *  `tokens_in` so a caller can show it as an estimate or ignore it, but
   *  never so a caller can add it in by accident. */
  tokens_in_estimated: number;
  /** How many of `calls` contributed a provider-reported token figure. The
   *  gap between this and `calls` is the coverage the totals above do NOT
   *  have. */
  reported_calls: number;
  /** Most recent successful / failed call for this model, ISO-8601, or null
   *  when there has not been one in the window. */
  last_ok_at: string | null;
  last_failure_at: string | null;
}

/**
 * Aggregate ai_usage for an account, most-used first. Used by the
 * Settings→Models usage view (src/components/AiUsage.tsx).
 *
 * TOKEN TOTALS ARE A COVERED SUBSET, AND SAY SO. Several providers report no
 * usage at all — Zo Ask's `{output}` body has never carried one, and it
 * answered more production calls last week than any other tier — so summing
 * `tokens_in` across every row and labelling it "tokens in" reported the sum
 * of the providers that report as though it were the sum of everything. The
 * numbers are now split by provenance (`usage_source`, migration 075, which
 * until this change nothing in the codebase read) and `reported_calls` names
 * the coverage, so the panel can state what the figure actually covers.
 *
 * FRESHNESS, NOT JUST RATE. A 7-day success rate averages a provider that
 * broke and recovered into one number that describes neither state: OpenCode
 * read as "13%" on a week where all 21 failures were five days old and all 3
 * successes were the same morning. `last_ok_at`/`last_failure_at` are the two
 * extra aggregates that tell those apart, from the same single query.
 */
export async function getAiUsageSummary(accountId: string, sinceDays = 30): Promise<AiUsageSummaryRow[]> {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('ai_usage')
    .select('provider_id, model_id, model_label, tokens_in, tokens_out, ok, usage_source, created_at')
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
      tokens_in_estimated: 0, reported_calls: 0,
      last_ok_at: null, last_failure_at: null,
    };
    row.calls += 1;
    if (r.ok) row.ok_calls += 1;
    // 'estimated' is only ever written by us (lib/ai/router.ts::failureUsage);
    // every other source with numbers attached is the provider's own figure,
    // including pre-075 rows the migration backfilled to reported/provider.
    if (r.usage_source === 'estimated') {
      row.tokens_in_estimated += r.tokens_in || 0;
    } else {
      const hasTokens = r.tokens_in != null || r.tokens_out != null;
      if (hasTokens) row.reported_calls += 1;
      row.tokens_in += r.tokens_in || 0;
      row.tokens_out += r.tokens_out || 0;
    }
    // Compared as instants, not strings: two rows can carry the same moment
    // in different textual forms (offset vs Z, differing fractional digits),
    // and a lexicographic max would pick the wrong one.
    const at: string | null = r.created_at ?? null;
    const t = at ? Date.parse(at) : NaN;
    if (at && !Number.isNaN(t)) {
      const field = r.ok ? 'last_ok_at' : 'last_failure_at';
      const current = row[field];
      if (!current || t > Date.parse(current)) row[field] = at;
    }
    byModel.set(key, row);
  }
  return Array.from(byModel.values()).sort((a, b) => b.calls - a.calls);
}
