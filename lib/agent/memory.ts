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
import { SECRET_KEY_PATTERN } from '@/lib/approvals/store';
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

/** Load a conversation's transcript, tenant-scoped. Returns [] when the id
 *  is absent, unknown, or belongs to another account — callers must never
 *  distinguish "not yours" from "empty" (no existence oracle).
 *
 *  This is the ONLY source of prior conversation content for an agent turn:
 *  the server owns conversation state, the client never sends transcript. */
export async function loadTranscript(conversationId: string | undefined, accountId: string): Promise<ChatMessage[]> {
  if (!conversationId) return [];
  const row = await loadConversation(conversationId, accountId);
  const transcript = row?.transcript;
  if (!Array.isArray(transcript)) return [];
  return transcript.filter(
    (m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string',
  ) as ChatMessage[];
}

export interface ConversationSummary {
  id: string;
  title: string | null;
  updated_at: string | null;
  token_estimate: number | null;
}

/** Recent conversations for one account, newest first.
 *
 *  Deliberately does NOT select `transcript` (or `carryover`): this powers a
 *  sidebar list that renders on every dock open, and a transcript column is
 *  unbounded. Cost and blast radius both stay small. Rehydration pulls the
 *  transcript one conversation at a time via loadTranscript.
 *
 *  The account filter is in the query, never applied after the fetch. */
export async function listConversationsForAccount(
  accountId: string,
  limit = 30,
): Promise<ConversationSummary[]> {
  const n = Math.min(Math.max(Math.trunc(limit) || 30, 1), 100);
  try {
    const { data } = await supabase.from('agent_conversations')
      .select('id, title, updated_at, token_estimate')
      .eq('account_id', accountId)
      .order('updated_at', { ascending: false })
      .limit(n);
    return (data || []) as ConversationSummary[];
  } catch {
    return [];
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

/** Longest plausible durable fact. Anything longer is a pasted blob, not a
 *  fact worth carrying into every future chat. */
export const MAX_FACT_LENGTH = 500;

// A long unbroken alphanumeric run is what an API key, JWT segment, or bearer
// token looks like; ordinary prose never contains one. Paired with
// SECRET_KEY_PATTERN (the same heuristic redactArgs uses in
// lib/approvals/store.ts) so the two secret checks stay in one place.
const OPAQUE_TOKEN_PATTERN = /[A-Za-z0-9_\-]{32,}/;

/**
 * Why this text must NOT be written to durable memory, or null if it's fine.
 *
 * Durable memory is read back into EVERY future prompt for this account, so a
 * credential landing here would be re-surfaced indefinitely. Rejection is
 * deliberately blunt: losing a fact that merely mentions the word "password" is
 * cheaper than persisting one real key.
 */
export function factRejectionReason(fact: string | undefined | null): string | null {
  const t = (fact || '').trim();
  if (!t) return 'empty';
  if (t.length > MAX_FACT_LENGTH) return `too long (max ${MAX_FACT_LENGTH} characters)`;
  if (SECRET_KEY_PATTERN.test(t)) return 'looks like a credential — secrets are never remembered';
  if (OPAQUE_TOKEN_PATTERN.test(t)) return 'contains what looks like a token or key — secrets are never remembered';
  return null;
}

/** Record a durable fact about the account. Best-effort.
 *
 * Guarded (Packet 1.1): a fact that looks like a secret, or exceeds
 * MAX_FACT_LENGTH, is dropped rather than stored. The guard lives HERE, at the
 * write, because there are two ingestion paths — the rememberFact capability
 * and passive carryover extraction — and only one of them is model-mediated.
 *
 * Embeds the fact (migration 036) so it's recallable by meaning. Embedding is
 * best-effort and never blocks: if it fails, the row is still written and stays
 * recall-able via the recency digest — it just won't match semantically until a
 * backfill re-embeds it. */
export async function recordFact(accountId: string, f: MemoryFact): Promise<void> {
  const fact = (f.fact || '').trim();
  if (factRejectionReason(fact)) return;
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

export interface StoredFact {
  id: string;
  fact: string;
  subject: string | null;
  predicate: string | null;
  object: string | null;
  created_at: string | null;
}

/** The most recent durable facts for this account, newest first, so the user
 *  can audit what the assistant remembers. Tenant-scoped in the query. */
export async function listFacts(accountId: string, limit = 25): Promise<StoredFact[]> {
  const n = Math.min(Math.max(Math.trunc(limit) || 25, 1), 100);
  try {
    const { data } = await supabase.from('agent_memory')
      .select('id, fact, subject, predicate, object, created_at')
      .eq('account_id', accountId)
      .order('updated_at', { ascending: false })
      .limit(n);
    return (data || []) as StoredFact[];
  } catch {
    return [];
  }
}

/** Delete one remembered fact. Returns whether a row was actually removed —
 *  false for an unknown id AND for an id belonging to another account, which
 *  are indistinguishable to the caller by design (no existence oracle). The
 *  account_id filter is in the query, never applied after the fetch. */
export async function deleteFact(accountId: string, id: string): Promise<boolean> {
  if (!id) return false;
  try {
    const { data } = await supabase.from('agent_memory')
      .delete().eq('id', id).eq('account_id', accountId)
      .select('id');
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

/** Passive ingestion: promote a carryover memo's established_facts into durable
 *  memory. Best-effort and per-fact isolated — recordFact already swallows its
 *  own errors and applies the secret/length guard, so a bad entry drops instead
 *  of aborting the rest. Callers fire this and forget it; it must never be
 *  awaited on a request's critical path. */
export async function ingestCarryoverFacts(accountId: string, carryover: CarryoverMemo | null): Promise<void> {
  const facts = carryover?.established_facts;
  if (!Array.isArray(facts) || !facts.length) return;
  for (const f of facts.slice(0, 20)) {
    if (typeof f !== 'string') continue;
    try {
      await recordFact(accountId, { fact: f });
    } catch { /* best-effort */ }
  }
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
