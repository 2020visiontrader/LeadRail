// LeadRail AI — durable memory + conversation persistence.
//
// Two stores, both tenant-scoped by accountId (UUID, from the session):
//   agent_conversations — one row per chat: transcript + token_estimate, plus a
//     `carryover` memo used to seed a fresh chat when one gets too long.
//   agent_memory — durable facts the copilot has learned about the account
//     (freeform `fact`, optional subject/predicate/object triple for graph use).
//
// Everything here is best-effort: persistence must never break a chat turn. If a
// write fails (e.g. migration not yet applied), we swallow the error and the
// conversation still works — it just isn't saved. Reads degrade to empty.

import { supabase } from '@/lib/db';
import type { ChatMessage } from '@/lib/ai/router';
import { embedPassage, embedQuery, toPgVector } from './embeddings';

/** Cheap token estimate (~4 chars/token) over a transcript. */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) chars += (m.content?.length || 0) + 8;
  return Math.ceil(chars / 4);
}

export interface CarryoverMemo {
  objective?: string;
  active_context?: string;
  established_facts?: string[];
  decisions?: string[];
  open_tasks?: string[];
  dont_repeat?: string[];
}

export interface ConversationRow {
  id: string;
  account_id: string;
  brand_id: string | null;
  title: string | null;
  transcript: ChatMessage[] | null;
  carryover: CarryoverMemo | null;
  token_estimate: number;
}

/**
 * Create or update a conversation row and return its id. Pass `id` to update an
 * existing conversation; omit it to create a new one. Never throws.
 */
export async function saveConversation(args: {
  id?: string;
  accountId: string;
  brandId?: string | null;
  title?: string | null;
  transcript: ChatMessage[];
  carryover?: CarryoverMemo | null;
}): Promise<string | null> {
  const tokenEstimate = estimateTokens(args.transcript);
  const row: Record<string, any> = {
    account_id: args.accountId,
    brand_id: args.brandId ?? null,
    transcript: args.transcript,
    token_estimate: tokenEstimate,
    updated_at: new Date().toISOString(),
  };
  if (args.title !== undefined) row.title = args.title;
  if (args.carryover !== undefined) row.carryover = args.carryover;
  try {
    if (args.id) {
      const { data } = await supabase.from('agent_conversations')
        .update(row).eq('id', args.id).eq('account_id', args.accountId)
        .select('id').maybeSingle();
      if (data?.id) return data.id;
      // Row vanished or id was stale — fall through to insert.
    }
    const { data } = await supabase.from('agent_conversations')
      .insert(row).select('id').maybeSingle();
    return data?.id ?? null;
  } catch {
    return null;
  }
}

/** Load one conversation (transcript + carryover), tenant-scoped. */
export async function loadConversation(id: string, accountId: string): Promise<ConversationRow | null> {
  try {
    const { data } = await supabase.from('agent_conversations')
      .select('*').eq('id', id).eq('account_id', accountId).maybeSingle();
    return (data as ConversationRow) || null;
  } catch {
    return null;
  }
}

/** Persist a carryover memo on a conversation (used at compaction). */
export async function saveCarryover(id: string, accountId: string, carryover: CarryoverMemo): Promise<void> {
  try {
    await supabase.from('agent_conversations')
      .update({ carryover, updated_at: new Date().toISOString() })
      .eq('id', id).eq('account_id', accountId);
  } catch { /* best-effort */ }
}

/** Load the carryover memo from a prior conversation, to seed a fresh chat. */
export async function loadCarryover(fromId: string, accountId: string): Promise<CarryoverMemo | null> {
  const row = await loadConversation(fromId, accountId);
  return row?.carryover ?? null;
}

// --- durable facts ---------------------------------------------------------

export interface MemoryFact {
  fact: string;
  subject?: string;
  predicate?: string;
  object?: string;
}

/** Record a durable fact about the account. Best-effort.
 *
 * Embeds the fact (migration 036) so it's recallable by meaning. Embedding is
 * best-effort and never blocks: if it fails, the row is still written and stays
 * recall-able via the recency digest — it just won't match semantically until a
 * backfill re-embeds it. */
export async function recordFact(accountId: string, f: MemoryFact): Promise<void> {
  const fact = (f.fact || '').trim();
  if (!fact) return;
  const row: Record<string, any> = {
    account_id: accountId,
    fact,
    subject: f.subject ?? null,
    predicate: f.predicate ?? null,
    object: f.object ?? null,
  };
  try {
    const vec = await embedPassage(fact);
    if (vec) row.embedding = toPgVector(vec);
  } catch { /* embedding optional — write the fact anyway */ }
  try {
    await supabase.from('agent_memory').insert(row);
  } catch { /* best-effort */ }
}

/**
 * Semantic recall: facts closest in MEANING to `query` for this account.
 * Returns `[]` when embeddings are unavailable, the table lacks the vector
 * column (migration 036 not applied), or nothing clears `minSimilarity`. Never
 * throws. `minSimilarity` filters out weak matches so recall stays relevant.
 */
export async function semanticRecall(
  accountId: string,
  query: string,
  limit = 8,
  // nv-embedqa-e5-v5 cosine scores are compressed: in the live retrieval eval,
  // CORRECT top-1 matches ran 0.29–0.51 and clearly-unrelated facts ~0.22–0.26.
  // A 0.25 floor keeps every true positive (dropping a real memory is worse than
  // one stray line in a capped, recency-padded digest the model can ignore).
  minSimilarity = 0.25,
): Promise<string[]> {
  const q = (query || '').trim();
  if (!q) return [];
  try {
    const vec = await embedQuery(q);
    if (!vec) return [];
    const { data, error } = await supabase.rpc('match_agent_memory', {
      p_account_id: accountId,
      p_query: toPgVector(vec),
      p_limit: limit,
    });
    if (error || !Array.isArray(data)) return [];
    return data
      .filter((r: any) => typeof r?.fact === 'string' && (r.similarity ?? 0) >= minSimilarity)
      .map((r: any) => r.fact as string);
  } catch {
    return [];
  }
}

/**
 * Compact digest of durable facts for the account, capped so it never bloats the
 * prompt. Returns '' when there's nothing (or on error).
 *
 * Blended recall (B4): when `query` is supplied AND semantic recall is available,
 * the most MEANING-relevant facts are surfaced first, then padded with the most
 * recent facts (deduped). With no query — or when embeddings/migration 036 are
 * unavailable — this is byte-for-byte the original recency-only digest.
 */
export async function recallMemoryDigest(
  accountId: string,
  limit = 12,
  query?: string,
): Promise<string> {
  try {
    const facts: string[] = [];
    const seen = new Set<string>();
    const add = (f: string) => {
      const t = (f || '').trim();
      if (!t || seen.has(t)) return;
      seen.add(t);
      facts.push(t);
    };

    // Semantic-first: only when a query is given (existing callers pass none, so
    // their behavior is unchanged). semanticRecall returns [] if unavailable.
    if (query && query.trim()) {
      const relevant = await semanticRecall(accountId, query, Math.min(8, limit));
      for (const f of relevant) add(f);
    }

    // Pad with the most recent facts up to the cap.
    if (facts.length < limit) {
      const { data } = await supabase.from('agent_memory')
        .select('fact').eq('account_id', accountId)
        .order('updated_at', { ascending: false }).limit(limit);
      for (const r of (data || [])) add((r as any).fact);
    }

    if (!facts.length) return '';
    return facts.slice(0, limit).map((f) => `- ${f}`).join('\n');
  } catch {
    return '';
  }
}

/** Render a carryover memo as a system-prompt block for a reseeded chat. */
export function carryoverBlock(c: CarryoverMemo): string {
  const lines = ['CARRYOVER CONTEXT (from the previous chat — continue seamlessly, do not redo done work):'];
  if (c.objective) lines.push(`- Objective: ${c.objective}`);
  if (c.active_context) lines.push(`- Active context: ${c.active_context}`);
  if (c.established_facts?.length) lines.push(`- Established facts:\n${c.established_facts.map((f) => `  • ${f}`).join('\n')}`);
  if (c.decisions?.length) lines.push(`- Decisions made:\n${c.decisions.map((d) => `  • ${d}`).join('\n')}`);
  if (c.open_tasks?.length) lines.push(`- Open tasks:\n${c.open_tasks.map((t) => `  • ${t}`).join('\n')}`);
  if (c.dont_repeat?.length) lines.push(`- Already done (do NOT repeat):\n${c.dont_repeat.map((d) => `  • ${d}`).join('\n')}`);
  return lines.join('\n');
}
