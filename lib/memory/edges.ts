// Graph operations over memory_edges (migration 061).
//
// The invariant this file exists to hold: an edge is never updated in place and
// never deleted by the write path. A contradicting fact sets `invalid_at` and
// `invalidated_by` on the old edge and inserts a new one, so the history of what
// was believed — and when — survives. That is what makes an autonomous action
// auditable after the fact, which for a system that spends money on campaigns is
// not a nice-to-have.

import { supabase } from '@/lib/db';
import { log } from '@/lib/logger';
import type { MemoryEdge, SubjectRef, Tier } from './types';

function rowToEdge(r: any): MemoryEdge {
  return {
    id: r.id,
    accountId: r.account_id,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    predicate: r.predicate,
    object: r.object,
    fact: r.fact,
    tier: r.tier,
    validFrom: r.valid_from,
    invalidAt: r.invalid_at,
    conversationId: r.conversation_id,
    source: r.source,
    occurrences: r.occurrences,
  };
}

/** Currently-true edges for one subject, strongest first: Tier 1 before Tier 2,
 *  then most recently valid. This ordering is what the projection renders, so
 *  a truncated body keeps the load-bearing facts. */
export async function activeEdges(
  accountId: string,
  subject: SubjectRef,
  limit = 50,
): Promise<MemoryEdge[]> {
  try {
    const { data, error } = await supabase
      .from('memory_edges')
      .select('*')
      .eq('account_id', accountId)
      .eq('subject_type', subject.type)
      .eq('subject_id', subject.id)
      .is('invalid_at', null)
      .order('tier', { ascending: true })
      .order('valid_from', { ascending: false })
      .limit(limit);
    if (error || !Array.isArray(data)) return [];
    return data.map(rowToEdge);
  } catch {
    return [];
  }
}

/** The active edge for this subject+predicate, if any. Contradiction is only
 *  decidable on a normalised predicate — two prose sentences saying different
 *  things about a budget are not comparable, but two `has_budget` edges are. */
async function activeForPredicate(
  accountId: string,
  subject: SubjectRef,
  predicate: string,
): Promise<MemoryEdge | null> {
  try {
    const { data } = await supabase
      .from('memory_edges')
      .select('*')
      .eq('account_id', accountId)
      .eq('subject_type', subject.type)
      .eq('subject_id', subject.id)
      .eq('predicate', predicate)
      .is('invalid_at', null)
      .order('valid_from', { ascending: false })
      .limit(1);
    const row = Array.isArray(data) ? data[0] : null;
    return row ? rowToEdge(row) : null;
  } catch {
    return null;
  }
}

export interface WriteResult {
  outcome: 'written' | 'recurrence' | 'unchanged' | 'failed';
  edgeId?: string;
  supersededEdgeId?: string;
  occurrences?: number;
}

/**
 * Write one fact, resolving it against what is already believed.
 *
 * Three outcomes that matter:
 *  - identical object already active → a RECURRENCE. Bumps `occurrences`
 *    instead of inserting a duplicate, which is what makes the Tier 2
 *    promotion threshold meaningful (a pattern observed three times is three
 *    observations, not three rows saying the same thing once).
 *  - different object for the same predicate → CONTRADICTION. The old edge is
 *    invalidated with a pointer to its successor; both survive.
 *  - nothing active for that predicate → a plain insert.
 */
export async function writeEdge(args: {
  accountId: string;
  subject: SubjectRef;
  predicate: string;
  object: string;
  fact: string;
  tier: Tier;
  conversationId?: string | null;
  source?: 'extraction' | 'capability' | 'import' | 'declared';
  validFrom?: string;
}): Promise<WriteResult> {
  const {
    accountId, subject, predicate, object, fact, tier,
    conversationId = null, source = 'extraction', validFrom,
  } = args;

  const existing = await activeForPredicate(accountId, subject, predicate);

  // DECLARED CONTEXT OUTRANKS INFERENCE. A user-authored fact ("never use
  // exclamation points", "our ICP is seed-stage B2B") is authoritative; an
  // extractor reading a conversation must not quietly overwrite it because
  // somebody said something loosely adjacent in a chat. A person can change
  // their own declared context; the machine cannot.
  if (existing?.source === 'declared' && source === 'extraction') {
    return { outcome: 'unchanged', edgeId: existing.id };
  }

  // Same claim, seen again. Not a new fact — more evidence for an old one.
  if (existing && existing.object.trim().toLowerCase() === object.trim().toLowerCase()) {
    try {
      const next = existing.occurrences + 1;
      const { error } = await supabase
        .from('memory_edges')
        .update({
          occurrences: next,
          last_seen_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id);
      if (error) return { outcome: 'failed' };
      return { outcome: 'recurrence', edgeId: existing.id, occurrences: next };
    } catch {
      return { outcome: 'failed' };
    }
  }

  // New or superseding.
  try {
    const { data, error } = await supabase
      .from('memory_edges')
      .insert([{
        account_id: accountId,
        subject_type: subject.type,
        subject_id: subject.id,
        predicate,
        object,
        fact,
        tier,
        conversation_id: conversationId,
        source,
        valid_from: validFrom || new Date().toISOString(),
      }])
      .select('id')
      .single();
    if (error || !data) return { outcome: 'failed' };
    const newId = (data as any).id as string;

    if (existing) {
      // Invalidate, never delete. `invalidated_by` makes the supersession
      // chain walkable, so "why did we believe X on 1 August" is answerable.
      const { error: invErr } = await supabase
        .from('memory_edges')
        .update({
          invalid_at: new Date().toISOString(),
          invalidated_by: newId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .is('invalid_at', null);
      if (invErr) {
        // The new edge is already in. Leaving the old one active would make the
        // subject read as holding two contradictory facts, so this is worth a
        // loud line rather than a silent swallow.
        log.warn('memory: superseding edge written but predecessor not invalidated', {
          accountId, edgeId: newId, predecessor: existing.id, predicate,
        });
      }
    }
    return { outcome: 'written', edgeId: newId, supersededEdgeId: existing?.id };
  } catch {
    return { outcome: 'failed' };
  }
}

/** Tier 2 edges that have recurred enough to deserve a human decision. This is
 *  the promotion QUEUE — nothing here is operational, and nothing promotes
 *  itself. */
export async function promotionCandidates(
  accountId: string,
  threshold: number,
  limit = 25,
): Promise<MemoryEdge[]> {
  try {
    const { data, error } = await supabase
      .from('memory_edges')
      .select('*')
      .eq('account_id', accountId)
      .eq('tier', 2)
      .is('invalid_at', null)
      .gte('occurrences', threshold)
      .order('occurrences', { ascending: false })
      .limit(limit);
    if (error || !Array.isArray(data)) return [];
    return data.map(rowToEdge);
  } catch {
    return [];
  }
}

/** Every belief ever held about one subject+predicate, newest first — including
 *  invalidated ones. The time-travel query: what did we think, and when. */
export async function beliefHistory(
  accountId: string,
  subject: SubjectRef,
  predicate: string,
): Promise<MemoryEdge[]> {
  try {
    const { data, error } = await supabase
      .from('memory_edges')
      .select('*')
      .eq('account_id', accountId)
      .eq('subject_type', subject.type)
      .eq('subject_id', subject.id)
      .eq('predicate', predicate)
      .order('valid_from', { ascending: false });
    if (error || !Array.isArray(data)) return [];
    return data.map(rowToEdge);
  } catch {
    return [];
  }
}
