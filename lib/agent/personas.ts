// Agent persona roster (per account) — migration 024_personas.sql.
//
// A persona is a named system-prompt fragment the agent loop can adopt: its
// own instructions, tone, and an optional model override that plugs into the
// A0 provider/model registry (lib/ai/providers.ts, ai_models.id). NULL
// model_id means "use the account's ai_routing default" — the exact behavior
// every account already has today, so a persona with no override changes
// nothing about which model answers.
//
// This module is intentionally thin CRUD + two small pure helpers
// (parseMentions, buildPersonaSystemBlock) — lib/agent/loop.ts imports it
// rather than growing its own persona logic, keeping the loop's diff small.

import { supabase } from '@/lib/db';

export interface PersonaRow {
  id: string;
  account_id: string;
  name: string;
  role: string | null;
  instructions: string;
  model_id: string | null;
  tone: string | null;
  avatar: string | null;
  is_coordinator: boolean;
  enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface PersonaInput {
  name: string;
  role?: string | null;
  instructions?: string;
  model_id?: string | null;
  tone?: string | null;
  avatar?: string | null;
  is_coordinator?: boolean;
  enabled?: boolean;
  sort_order?: number;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listPersonas(accountId: string): Promise<PersonaRow[]> {
  const { data, error } = await supabase
    .from('personas')
    .select('*')
    .eq('account_id', accountId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function getPersona(accountId: string, id: string): Promise<PersonaRow | null> {
  const { data, error } = await supabase
    .from('personas')
    .select('*')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/** Unset any other enabled coordinator for this account so at most one stays
 *  active — mirrors the partial unique index in 024_personas.sql (belt +
 *  suspenders: the app enforces it too, not just the DB constraint). */
async function clearOtherCoordinators(accountId: string, keepId?: string): Promise<void> {
  let q = supabase.from('personas').update({ is_coordinator: false }).eq('account_id', accountId).eq('is_coordinator', true);
  if (keepId) q = q.neq('id', keepId);
  const { error } = await q;
  if (error) throw error;
}

export async function createPersona(accountId: string, input: PersonaInput): Promise<PersonaRow> {
  const row = {
    account_id: accountId,
    name: input.name,
    role: input.role ?? null,
    instructions: input.instructions ?? '',
    model_id: input.model_id ?? null,
    tone: input.tone ?? null,
    avatar: input.avatar ?? null,
    is_coordinator: Boolean(input.is_coordinator),
    enabled: input.enabled ?? true,
    sort_order: input.sort_order ?? 0,
  };
  if (row.is_coordinator) await clearOtherCoordinators(accountId);
  const { data, error } = await supabase.from('personas').insert([row]).select().single();
  if (error) throw error;
  return data;
}

export async function updatePersona(accountId: string, id: string, patch: Partial<PersonaInput>): Promise<PersonaRow> {
  const row: Record<string, any> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.role !== undefined) row.role = patch.role;
  if (patch.instructions !== undefined) row.instructions = patch.instructions;
  if (patch.model_id !== undefined) row.model_id = patch.model_id;
  if (patch.tone !== undefined) row.tone = patch.tone;
  if (patch.avatar !== undefined) row.avatar = patch.avatar;
  if (patch.enabled !== undefined) row.enabled = patch.enabled;
  if (patch.sort_order !== undefined) row.sort_order = patch.sort_order;
  if (patch.is_coordinator !== undefined) row.is_coordinator = patch.is_coordinator;

  if (patch.is_coordinator === true) await clearOtherCoordinators(accountId, id);

  const { data, error } = await supabase
    .from('personas')
    .update(row)
    .eq('id', id)
    .eq('account_id', accountId)
    .select()
    .single();
  if (error) throw error;
  if (!data) throw new Error('persona not found');
  return data;
}

export async function deletePersona(accountId: string, id: string): Promise<{ id: string; deleted: true }> {
  const { data, error } = await supabase.from('personas').delete().eq('id', id).eq('account_id', accountId).select('id');
  if (error) throw error;
  if (!data || !data.length) throw new Error('persona not found');
  return { id, deleted: true };
}

/** The account's enabled coordinator, if any (at most one by DB constraint). */
export async function getCoordinator(accountId: string): Promise<PersonaRow | null> {
  const { data, error } = await supabase
    .from('personas')
    .select('*')
    .eq('account_id', accountId)
    .eq('is_coordinator', true)
    .eq('enabled', true)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// ---------------------------------------------------------------------------
// Agent-loop helpers
// ---------------------------------------------------------------------------

/** Load a single enabled persona by id, scoped to the account. Returns null
 *  (never throws) so a stale/foreign personaId degrades to default behavior
 *  instead of erroring the whole turn. */
export async function loadPersonaForAgent(accountId: string, personaId: string | undefined | null): Promise<PersonaRow | null> {
  if (!personaId) return null;
  try {
    const persona = await getPersona(accountId, personaId);
    return persona && persona.enabled ? persona : null;
  } catch {
    return null;
  }
}

/** Extract @mention tokens from a user message (e.g. "@Strategist can you…"
 *  -> ["Strategist"]). Matches word characters, spaces, and hyphens after the
 *  @ up to the next punctuation/newline, then trims trailing spaces so
 *  "@Strategist," still resolves to "Strategist". */
export function parseMentions(message: string | undefined | null): string[] {
  if (!message) return [];
  const matches = message.match(/@([A-Za-z0-9][A-Za-z0-9 _-]{0,40})/g) || [];
  return matches
    .map((m) => m.slice(1).trim())
    .filter(Boolean);
}

/** Resolve @mention name tokens to enabled personas for this account
 *  (case-insensitive, whole-name match). Unmatched tokens are ignored. */
export async function resolveMentionedPersonas(accountId: string, mentions: string[]): Promise<PersonaRow[]> {
  if (!mentions.length) return [];
  const all = await listPersonas(accountId);
  const wanted = new Set(mentions.map((m) => m.toLowerCase()));
  return all.filter((p) => p.enabled && wanted.has(p.name.toLowerCase()));
}

/** The minimal shape buildPersonaSystemBlock needs to render a voice. A
 *  PersonaRow satisfies this structurally (it carries every field and more),
 *  and so does a harvested template adapted to it (lib/agent/loop.ts) — ONE
 *  renderer for both a DB-row persona and a template-sourced one (BACKLOG
 *  5b), rather than two divergent blocks drifting apart over time. */
export interface PersonaVoice {
  name: string;
  role: string | null;
  instructions: string;
  tone: string | null;
}

/** Build the system-prompt block for a single active persona: its
 *  instructions framed as an identity override, plus tone if set. Prepended
 *  ahead of the base LeadRail AI system prompt so the persona's voice and
 *  focus take precedence while every tool/grounding rule still applies. */
export function buildPersonaSystemBlock(persona: PersonaVoice): string {
  const lines = [
    `You are currently acting as the persona "${persona.name}"${persona.role ? ` (${persona.role})` : ''}.`,
    persona.instructions?.trim() ? persona.instructions.trim() : '',
    persona.tone ? `Tone: ${persona.tone}.` : '',
    'Stay in this persona\'s voice and focus for the rest of this reply, while still following every platform rule below (tool use, grounding, approval gates, plain-language output).',
  ].filter(Boolean);
  return lines.join('\n');
}

/** Framing block for the coordinator's synthesis pass over one or more
 *  persona replies. Kept separate from buildPersonaSystemBlock so the
 *  coordinator's own instructions are clearly distinguished from the
 *  personas being synthesized. */
export function buildCoordinatorSystemBlock(coordinator: PersonaRow): string {
  const lines = [
    `You are "${coordinator.name}"${coordinator.role ? ` (${coordinator.role})` : ''}, the coordinator for this account's persona roster.`,
    coordinator.instructions?.trim() ? coordinator.instructions.trim() : '',
    coordinator.tone ? `Tone: ${coordinator.tone}.` : '',
    'Synthesize the mentioned personas\' input (provided below) into ONE clear, unified final answer for the user. Do not simply concatenate their replies — reconcile them into a single coherent response in your own voice.',
  ].filter(Boolean);
  return lines.join('\n');
}
