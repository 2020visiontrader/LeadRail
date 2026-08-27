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
import { log } from '@/lib/logger';
import type { ChatMessage } from '@/lib/ai/router';
import { SECRET_KEY_PATTERN } from '@/lib/approvals/store';
import { embedPassage, embedQuery, toPgVector } from './embeddings';
import { scoreFacts, packTier, tierForRequest, renderTier } from './memory-tiers';

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
/**
 * How much of a stored conversation one write may discard.
 *
 * THE GUARD MIGRATION 059 DESIGNED, FINALLY ATTACHED. That migration added
 * `message_count` so a shrinking write would "match no rows instead of
 * destroying one" — and the column has been written on every save since and
 * used as a condition nowhere. The protection existed only in a comment.
 *
 * WHY TOKENS, NOT MESSAGE COUNT. Message count is a proxy for "how much is
 * here" and a poor one: forty one-word replies are worth less than five turns
 * carrying tool results. Tokens measure the thing actually at risk.
 *
 * WHY A RATIO, NOT `<=`. This is the part that inverts if you get it wrong. A
 * plain "never shrink" rule — on tokens OR on message count — would block
 * capTranscript (lib/agent/loop.ts), which deliberately drops the oldest
 * messages once a transcript passes its bound. That is a CORRECT shrink, and
 * refusing it would be the same class of bug in the opposite direction.
 *
 * What separates the two is magnitude, not direction. capTranscript stops the
 * moment it is back under the bound, so its worst single-turn drop is one
 * message — at most ~6% of the bound, since an observation is itself capped.
 * A truncation bug replaces a long history with one message: a drop of ~99%.
 * Refusing to discard more than half sits with 8x headroom above the first and
 * nowhere near the second.
 */
const SHRINK_TOLERANCE = Number(process.env.CONVERSATION_SHRINK_TOLERANCE) || 2;

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
    // Maintained so the write guard in migration 059 has something to compare
    // against. See loadTranscriptResult for the failure this protects from: a
    // read that errors returns [], and a save built on [] would replace a long
    // conversation with a single message.
    message_count: args.transcript.length,
    updated_at: new Date().toISOString(),
  };
  if (args.title !== undefined) row.title = args.title;
  if (args.carryover !== undefined) row.carryover = args.carryover;
  try {
    if (args.id) {
      // The error is READ, not discarded. It used to be destructured away —
      // `const { data } = await ...update(...)` — and supabase-js reports
      // failures in the result object rather than throwing, so a failed UPDATE
      // looked identical to one that matched no rows, and fell through to the
      // INSERT below.
      //
      // That is how a conversation FORKS. Observed live: a turn saved three
      // messages to one row, the next turn's update failed, the insert created
      // a second row carrying the full history, and the client was handed the
      // new id. From the user's side the chat "disappeared" — it was intact,
      // under an id nothing pointed at any more, while the tab showed a
      // three-message stub.
      //
      // An error means we do not know the row's state, and inventing a second
      // row is the worst available response. Report the failure instead: the
      // caller keeps the id it had, and the next turn tries the same row again.
      const { data, error } = await supabase.from('agent_conversations')
        .update(row).eq('id', args.id).eq('account_id', args.accountId)
        // THE GUARD. Proceed only where what is stored is at most
        // SHRINK_TOLERANCE x what is being written — i.e. this save is not
        // throwing away more than half the conversation. A catastrophic
        // shrink matches no rows and writes nothing.
        .lte('token_estimate', tokenEstimate * SHRINK_TOLERANCE)
        // A conversation the user deleted must not be resurrected by a save
        // that was already in flight (migration 069). Excluding deleted rows
        // here makes this update match zero rows against a deleted
        // conversation, same as any other "matched no rows" case, and the
        // re-read below tells THIS one apart from a stale id or a refused
        // shrink so it does not fall through to the insert path.
        .is('deleted_at', null)
        .select('id').maybeSingle();
      if (error) {
        log.error('saveConversation: update failed, refusing to fork', error, {
          conversationId: args.id, messages: args.transcript.length,
        });
        return null;
      }
      if (data?.id) return data.id;

      // ZERO ROWS IS NOW AMBIGUOUS, AND THE CASES DEMAND DIFFERENT ACTIONS.
      //
      // Before the guard, no-error-and-no-row could only mean a stale id, so
      // falling through to INSERT was right. With the shrink guard it can ALSO
      // mean the write was refused — and inserting there would fork the
      // conversation: the user's chat splits in two, the client is handed the
      // new id, and the original becomes unreachable. That is the exact "my
      // chat disappeared" symptom this guard exists to prevent, caused by the
      // guard. A fix that produces the bug it prevents is worse than no fix.
      //
      // Migration 069 adds a THIRD case: the row is gone from this query only
      // because it was soft-deleted. Inserting there would be its own kind of
      // resurrection — the deleted content reappears, silently, under a new
      // id, in the user's chat list, moments after they deleted it. So the
      // re-read below is unfiltered on deleted_at: it must see a deleted row
      // in order to refuse the insert for it, same refusal as the shrink case.
      const { data: existing } = await supabase.from('agent_conversations')
        .select('id, token_estimate, message_count, deleted_at')
        .eq('id', args.id).eq('account_id', args.accountId).maybeSingle();

      if (existing && (existing as any).deleted_at) {
        // The conversation was deleted after this turn's read and before its
        // write landed. Deleted means gone: do not write the new content back
        // onto the deleted row (that would silently undelete it) and do not
        // insert it as a fresh conversation either (that would silently
        // resurrect the same content under a new id, defeating the deletion
        // just as surely). The turn's reply is lost from persistence, same as
        // it would be for any other resource a user just deleted out from
        // under an in-flight write.
        log.warn('saveConversation: refused a write to a deleted conversation', {
          conversationId: args.id,
        });
        return null;
      }

      if (existing) {
        // Refuse, exactly as the error branch above does. The caller keeps its
        // id, and the next turn writes against the real row. Loud, because a
        // rejection means two writers are fighting over one conversation and
        // one of them just lost a turn's work.
        log.error('saveConversation: refused a shrinking write', undefined, {
          conversationId: args.id,
          storedTokens: (existing as any).token_estimate,
          writingTokens: tokenEstimate,
          storedMessages: (existing as any).message_count,
          writingMessages: args.transcript.length,
        });
        return null;
      }

      // Genuinely stale, or another account's. Inserting is right here — and
      // now it is the ONLY thing that reaches this line.
      log.warn('saveConversation: id matched no row, creating a new conversation', {
        conversationId: args.id,
      });
    }
    const { data, error } = await supabase.from('agent_conversations')
      .insert(row).select('id').maybeSingle();
    if (error) {
      log.error('saveConversation: insert failed', error, { messages: args.transcript.length });
      return null;
    }
    return data?.id ?? null;
  } catch (e) {
    log.error('saveConversation: threw', e, { conversationId: args.id ?? null });
    return null;
  }
}

/** Load one conversation (transcript + carryover), tenant-scoped.
 *
 *  Returns null for "no such conversation, or not yours" and THROWS on a real
 *  read failure. Those were the same value before, which is how a transient
 *  database error became an empty transcript, and an empty transcript became a
 *  save that overwrote the real one. A caller that cannot tell the difference
 *  cannot protect the data.
 *
 *  Throwing leaks nothing about tenancy: an error is not an existence signal,
 *  and a row belonging to another account still returns null. */
export async function loadConversation(id: string, accountId: string): Promise<ConversationRow | null> {
  const { data, error } = await supabase.from('agent_conversations')
    .select('*').eq('id', id).eq('account_id', accountId)
    // Soft-deleted (migration 069): excluded from every read, same as
    // deleted_at IS NULL on contacts/companies/deals/brands. A deleted
    // conversation reads exactly like an unknown one — no existence oracle.
    .is('deleted_at', null)
    .maybeSingle();
  if (error) {
    const err: any = new Error('Could not read the conversation');
    err.cause = error;
    throw err;
  }
  return (data as ConversationRow) || null;
}

/** Load a conversation's transcript, tenant-scoped. Returns [] when the id
 *  is absent, unknown, or belongs to another account — callers must never
 *  distinguish "not yours" from "empty" (no existence oracle).
 *
 *  This is the ONLY source of prior conversation content for an agent turn:
 *  the server owns conversation state, the client never sends transcript. */
export async function loadTranscript(conversationId: string | undefined, accountId: string): Promise<ChatMessage[]> {
  return (await loadTranscriptResult(conversationId, accountId)).messages;
}

export interface TranscriptResult {
  messages: ChatMessage[];
  /** False when the read itself failed. `messages` is then [] and MUST NOT be
   *  treated as the conversation's contents — see the note below. */
  ok: boolean;
}

/**
 * loadTranscript, plus whether the read actually succeeded.
 *
 * WHY A CALLER NEEDS THIS. The turn loop reads a conversation, appends the new
 * user message, and writes the result back over the same row. If the read fails
 * and reports [], the write is a one-message transcript replacing however many
 * were there — silently, permanently, and looking exactly like a conversation
 * that vanished.
 *
 * "No such conversation" and "could not read it" have to be told apart at the
 * point where the difference decides whether to write. Absent, unknown, or
 * another account's still returns { messages: [], ok: true }: callers must
 * never distinguish "not yours" from "empty", and that is unchanged.
 */
export async function loadTranscriptResult(
  conversationId: string | undefined,
  accountId: string,
): Promise<TranscriptResult> {
  if (!conversationId) return { messages: [], ok: true };
  let row: ConversationRow | null;
  try {
    row = await loadConversation(conversationId, accountId);
  } catch (e) {
    log.error('loadTranscript: read failed', e, { conversationId });
    return { messages: [], ok: false };
  }
  const transcript = row?.transcript;
  if (!Array.isArray(transcript)) return { messages: [], ok: true };
  return {
    ok: true,
    messages: transcript.filter(
      (m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string',
    ) as ChatMessage[],
  };
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
export interface ConversationPage {
  conversations: ConversationSummary[];
  /** Pass back as `cursor` for the next page. Null when this is the last. */
  nextCursor: string | null;
}

/**
 * One page of an account's conversations, newest first.
 *
 * CURSOR, NOT OFFSET. The list is ordered by `updated_at`, which CHANGES as
 * conversations are used — so an offset drifts under you: reply to an old chat
 * while paging and it jumps to the front, shifting everything and making page 2
 * repeat a row page 1 already showed. A cursor keyed on the sort column cannot
 * do that.
 *
 * Added before the UI exists rather than after. The endpoint previously
 * returned a flat 30 with no way to reach anything older, and this account is
 * already at 28 — building a history surface against that assumption and
 * retrofitting paging later is the more expensive order.
 */
export async function listConversationsForAccount(
  accountId: string,
  limit = 30,
  cursor?: string | null,
  search?: string | null,
): Promise<ConversationPage> {
  const n = Math.min(Math.max(Math.trunc(limit) || 30, 1), 100);
  try {
    let q = supabase.from('agent_conversations')
      .select('id, title, updated_at, token_estimate')
      .eq('account_id', accountId)
      // Soft-deleted (migration 069): excluded from the list immediately,
      // same as deleted_at IS NULL on contacts/companies/deals/brands.
      .is('deleted_at', null)
      .order('updated_at', { ascending: false })
      // One extra row is the page-end signal: if it comes back, there is more.
      // Cheaper and more honest than a COUNT, which would be a second query
      // whose answer is stale the moment a turn lands.
      .limit(n + 1);
    if (cursor) q = q.lt('updated_at', cursor);
    if (search && search.trim()) q = q.ilike('title', `%${search.trim()}%`);

    const { data } = await q;
    const rows = (data || []) as ConversationSummary[];
    const hasMore = rows.length > n;
    const page = hasMore ? rows.slice(0, n) : rows;
    return {
      conversations: page,
      nextCursor: hasMore ? (page[page.length - 1]?.updated_at ?? null) : null,
    };
  } catch {
    return { conversations: [], nextCursor: null };
  }
}

/** Soft-delete one conversation (migration 069). Disappears from the list and
 *  from the transcript read immediately; hard-purged by purge_soft_deleted
 *  after DEFAULT_GRACE_DAYS (lib/privacy.ts), same shape as
 *  contacts/companies/deals/brands.
 *
 *  Returns whether a row was actually soft-deleted — false for an unknown id,
 *  an id belonging to another account, AND an id already deleted, which are
 *  indistinguishable to the caller by design (no existence oracle: the
 *  account_id filter is in the query, never applied after the fetch, and
 *  "already gone" reads the same as "never yours"). */
export async function deleteConversation(accountId: string, id: string): Promise<boolean> {
  if (!id) return false;
  try {
    const { data } = await supabase.from('agent_conversations')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id).eq('account_id', accountId).is('deleted_at', null)
      .select('id');
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
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

/** Where a candidate fact came from — see the source-gated check in
 *  factRejectionReason below. 'capability' = the model explicitly decided,
 *  mid-turn, that this was worth remembering (rememberFact). 'carryover' =
 *  promoted passively from an LLM-generated conversation summary, with no
 *  human or tool-result confirmation in the loop. */
export type FactSource = 'capability' | 'carryover';

// Matches things like "64% open rate" or "12% reply rate". A carryover memo is
// the model summarizing its OWN prior turn — it has no access to a real
// analytics table, so a metric-shaped claim in one can only be a restated (or
// invented) number from its own prose, not a verified read. Promoting that
// into durable memory risks the model citing its own unverified claim back to
// itself as established fact in every future turn — the self-referential loop
// this guard exists to break. `rememberFact` (source: 'capability') is exempt:
// that's the model choosing, live, with real tool access in the same turn.
const UNVERIFIED_METRIC_PATTERN = /\b\d{1,3}(\.\d+)?%\s*(open|reply|click|conversion|response|engagement)/i;

/**
 * Why this text must NOT be written to durable memory, or null if it's fine.
 *
 * Durable memory is read back into EVERY future prompt for this account, so a
 * credential landing here would be re-surfaced indefinitely. Rejection is
 * deliberately blunt: losing a fact that merely mentions the word "password" is
 * cheaper than persisting one real key.
 */
export function factRejectionReason(fact: string | undefined | null, source: FactSource = 'capability'): string | null {
  const t = (fact || '').trim();
  if (!t) return 'empty';
  if (t.length > MAX_FACT_LENGTH) return `too long (max ${MAX_FACT_LENGTH} characters)`;
  if (SECRET_KEY_PATTERN.test(t)) return 'looks like a credential — secrets are never remembered';
  if (OPAQUE_TOKEN_PATTERN.test(t)) return 'contains what looks like a token or key — secrets are never remembered';
  if (source === 'carryover' && UNVERIFIED_METRIC_PATTERN.test(t)) {
    return 'reads as an unverified performance metric from a passive summary — not stored without a verified source';
  }
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
export async function recordFact(accountId: string, f: MemoryFact, source: FactSource = 'capability'): Promise<void> {
  const fact = (f.fact || '').trim();
  if (factRejectionReason(fact, source)) return;
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
      await recordFact(accountId, { fact: f }, 'carryover');
    } catch { /* best-effort */ }
  }
}

/**
 * Semantic recall: facts closest in MEANING to `query` for this account.
 * Returns `[]` when embeddings are unavailable, the table lacks the vector
 * column (migration 036 not applied), or nothing clears `minSimilarity`. Never
 * throws. `minSimilarity` filters the RAW similarity floor — which facts are
 * relevant at all. Which of those relevant facts actually make the top-`limit`
 * cut is recency-aware (migration 049's decayed_similarity ranking in
 * match_agent_memory): a stale fact can still pass the floor here but lose its
 * ranking slot to a fresher, similarly-relevant one. Purely a ranking change on
 * the DB side — nothing below needed to change to pick it up.
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

    // TIERED PACKING. Previously this returned the top `limit` facts by
    // similarity-then-recency, the same twelve bullets whether the turn was
    // "what's my lead count?" or "plan next quarter". Now the facts are
    // classified by KIND and packed into the budget the request justifies, so
    // a decision the operator made three weeks ago outranks a passing note
    // that happens to share wording with the question. See memory-tiers.ts.
    const tier = tierForRequest(query);
    const packed = packTier(scoreFacts(facts), tier);
    // Never return nothing when facts exist: if the tier admitted none (a
    // terse question with only background on file), fall back to the plain
    // top-N so recall degrades to the old behaviour instead of going blank.
    const chosen = packed.length ? packed : facts.slice(0, Math.min(limit, 6));
    return renderTier(chosen);
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
