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

/** Record a durable fact about the account. Best-effort. */
export async function recordFact(accountId: string, f: MemoryFact): Promise<void> {
  const fact = (f.fact || '').trim();
  if (!fact) return;
  try {
    await supabase.from('agent_memory').insert({
      account_id: accountId,
      fact,
      subject: f.subject ?? null,
      predicate: f.predicate ?? null,
      object: f.object ?? null,
    });
  } catch { /* best-effort */ }
}

/**
 * Compact digest of recent durable facts for the account, newest first, capped
 * so it never bloats the prompt. Returns '' when there's nothing (or on error).
 */
export async function recallMemoryDigest(accountId: string, limit = 12): Promise<string> {
  try {
    const { data } = await supabase.from('agent_memory')
      .select('fact').eq('account_id', accountId)
      .order('updated_at', { ascending: false }).limit(limit);
    if (!data?.length) return '';
    return data.map((r: any) => `- ${r.fact}`).join('\n');
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
