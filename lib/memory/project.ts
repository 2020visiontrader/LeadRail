// Projection: render a subject's active edges into the block a live turn reads.
//
// WHY A TABLE AND NOT FILES. The architecture this implements describes one
// markdown file per subject (/memory/contacts/<id>.md). That shape is right —
// one keyed fetch, human-readable, no traversal on the hot path — but this app
// runs on serverless Next.js, where there is no writable disk that survives a
// request. LeadRail's only file storage is Supabase Storage (private buckets for
// venture decks and outreach attachments), which is object storage for binary
// artifacts and would cost a network round-trip per subject per turn. So the
// projection lives in `memory_subjects`: same one-fetch access pattern, same
// human-readable body, no filesystem.
//
// The body is DERIVED. Nothing should ever write it by hand, and losing the
// table entirely costs only a re-projection from memory_edges.

import { BUDGET } from '@/lib/ai/context-budget';
import { supabase } from '@/lib/db';
import { log } from '@/lib/logger';
import { activeEdges } from './edges';
import type { MemoryEdge, SubjectRef } from './types';

/** Ceiling on a rendered body. A subject block joins the grounding section of
 *  every turn about it, so it competes with the tool catalog and the transcript
 *  for the same window. Tier 1 renders first, so truncation drops observations
 *  before it drops commitments. */
export const MAX_BODY_CHARS = Number(process.env.MEMORY_BODY_CHARS) || BUDGET.memoryBodyChars;

function renderValidity(e: MemoryEdge): string {
  const from = e.validFrom ? e.validFrom.slice(0, 10) : null;
  const seen = e.occurrences > 1 ? `, seen ${e.occurrences}×` : '';
  return from ? ` (since ${from}${seen})` : seen ? ` (${seen.slice(2)})` : '';
}

/** One line per edge, tier-tagged. The tag is not decoration: it tells the
 *  model which facts it may act on and which are merely observed, and it is the
 *  same distinction the promotion gate enforces downstream. */
export function renderBody(edges: MemoryEdge[]): string {
  if (!edges.length) return '';
  const lines: string[] = [];
  let used = 0;
  for (const e of edges) {
    const tag = e.tier === 1 ? '[established]' : '[observed]';
    const line = `- ${tag} ${e.fact}${renderValidity(e)}`;
    if (used + line.length + 1 > MAX_BODY_CHARS) {
      lines.push(`- … ${edges.length - lines.length} further fact(s) not shown`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

/**
 * Rebuild one subject's projection from its currently-active edges.
 *
 * Read-before-write with a version check. Two extraction runs touching the same
 * subject concurrently must not clobber each other, and a live read must never
 * observe a half-written body. On a version mismatch this returns
 * `{ ok: false, reason: 'conflict' }` — the caller re-projects rather than
 * overwriting, because the other writer saw edges this one did not.
 *
 * Note this is real optimistic concurrency, unlike the deliberately-lossy
 * `onUsageRow` callback in the router: there, losing a write undercounts a
 * metric; here, losing a write leaves the assistant reading stale memory.
 */
export async function projectSubject(
  accountId: string,
  subject: SubjectRef,
): Promise<{ ok: boolean; reason?: string; edgeCount?: number }> {
  const edges = await activeEdges(accountId, subject);
  const body = renderBody(edges);

  try {
    const { data: current } = await supabase
      .from('memory_subjects')
      .select('version')
      .eq('account_id', accountId)
      .eq('subject_type', subject.type)
      .eq('subject_id', subject.id)
      .maybeSingle();

    const now = new Date().toISOString();

    if (!current) {
      const { error } = await supabase.from('memory_subjects').insert([{
        account_id: accountId,
        subject_type: subject.type,
        subject_id: subject.id,
        label: subject.label ?? null,
        body,
        edge_count: edges.length,
        version: 1,
        last_synced_at: now,
      }]);
      // A concurrent insert loses the primary-key race. That is a conflict, not
      // a failure — the winner projected the same edges.
      if (error) return { ok: false, reason: 'conflict' };
      return { ok: true, edgeCount: edges.length };
    }

    const expected = (current as any).version as number;
    const { data: updated, error } = await supabase
      .from('memory_subjects')
      .update({
        label: subject.label ?? null,
        body,
        edge_count: edges.length,
        version: expected + 1,
        last_synced_at: now,
      })
      .eq('account_id', accountId)
      .eq('subject_type', subject.type)
      .eq('subject_id', subject.id)
      .eq('version', expected)   // the guard
      .select('version');

    if (error) return { ok: false, reason: 'error' };
    if (!Array.isArray(updated) || updated.length === 0) {
      return { ok: false, reason: 'conflict' };
    }
    return { ok: true, edgeCount: edges.length };
  } catch (e) {
    log.warn('memory: projection failed', {
      accountId, subject: `${subject.type}:${subject.id}`, error: String((e as any)?.message || e),
    });
    return { ok: false, reason: 'error' };
  }
}

/** Project with one retry on conflict. A conflict means someone else just
 *  wrote; re-reading and re-rendering converges, because both writers derive
 *  from the same edge table. */
export async function projectSubjectWithRetry(
  accountId: string,
  subject: SubjectRef,
): Promise<{ ok: boolean; edgeCount?: number }> {
  const first = await projectSubject(accountId, subject);
  if (first.ok || first.reason !== 'conflict') return first;
  const second = await projectSubject(accountId, subject);
  return second;
}

/** The block a live turn splices into its grounding section. One keyed read,
 *  no traversal. Returns '' when the subject has no memory yet, so callers can
 *  concatenate unconditionally. */
export async function loadSubjectMemory(
  accountId: string,
  subjects: SubjectRef[],
): Promise<string> {
  if (!subjects.length) return '';
  try {
    const blocks: string[] = [];
    for (const s of subjects) {
      const { data } = await supabase
        .from('memory_subjects')
        .select('label, body')
        .eq('account_id', accountId)
        .eq('subject_type', s.type)
        .eq('subject_id', s.id)
        .maybeSingle();
      const body = (data as any)?.body?.trim();
      if (!body) continue;
      const label = (data as any)?.label || s.label || s.id;
      blocks.push(`${s.type.toUpperCase()} — ${label}:\n${body}`);
    }
    if (!blocks.length) return '';
    return [
      'WHAT YOU KNOW ABOUT WHAT THIS TURN IS ABOUT (durable memory).',
      '[established] = stated or measured; you may rely on it and act on it.',
      '[observed] = a pattern seen more than once but NOT confirmed — you may mention it, you may NOT act on it as if it were a rule.',
      'If any of this conflicts with live data above, the live data is correct.',
      '',
      blocks.join('\n\n'),
    ].join('\n');
  } catch {
    return '';
  }
}
