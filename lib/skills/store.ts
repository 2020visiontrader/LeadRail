// Skills catalog + per-account enable-state CRUD — migration 025_skills.sql.
//
// Mirrors lib/agent/personas.ts: a thin data-access module the API routes and
// lib/agent/loop.ts import, keeping the loop's diff small. Two tables:
//   - skills: account_id NULL rows are the shared/global catalog (seeded from
//     the harvested OSS set, see lib/skills/registry.ts getCombinedCatalog);
//     account_id NOT NULL rows are one account's own custom skills.
//   - account_skills: which catalog skill ids an account has turned on, with
//     an optional per-account instructions override.
//
// dbReady() gates every call the same way the rest of lib/db.ts consumers do
// — if Supabase isn't configured, callers get an empty/no-op result instead
// of throwing, so a missing DB config never breaks the default agent path.

import { supabase, dbReady } from '@/lib/db';

export interface SkillRow {
  id: string;
  account_id: string | null;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  instructions: string;
  source: string | null;
  license: string | null;
  inspired_by: string | null;
  quality_flags: string[];
  created_at: string;
  updated_at: string;
}

export interface AccountSkillRow {
  account_id: string;
  skill_id: string;
  enabled: boolean;
  overridden_instructions: string | null;
  created_at: string;
}

export interface SkillInput {
  slug: string;
  name: string;
  description?: string | null;
  category?: string | null;
  instructions?: string;
  source?: string | null;
  license?: string | null;
  inspired_by?: string | null;
  quality_flags?: string[];
}

// ---------------------------------------------------------------------------
// Catalog CRUD (skills table)
// ---------------------------------------------------------------------------

/** Global catalog rows (account_id IS NULL) — visible to every account. */
export async function listGlobalSkills(): Promise<SkillRow[]> {
  if (!dbReady()) return [];
  const { data, error } = await supabase.from('skills').select('*').is('account_id', null).order('name', { ascending: true });
  if (error) throw error;
  return data || [];
}

/** One account's own custom skills (account_id = accountId). */
export async function listAccountCustomSkills(accountId: string): Promise<SkillRow[]> {
  if (!dbReady()) return [];
  const { data, error } = await supabase.from('skills').select('*').eq('account_id', accountId).order('name', { ascending: true });
  if (error) throw error;
  return data || [];
}

/** The catalog an account can see: global rows + that account's own custom rows. */
export async function listVisibleSkills(accountId: string): Promise<SkillRow[]> {
  if (!dbReady()) return [];
  const { data, error } = await supabase
    .from('skills')
    .select('*')
    .or(`account_id.is.null,account_id.eq.${accountId}`)
    .order('name', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function getSkillRow(accountId: string, id: string): Promise<SkillRow | null> {
  if (!dbReady()) return null;
  const { data, error } = await supabase
    .from('skills')
    .select('*')
    .eq('id', id)
    .or(`account_id.is.null,account_id.eq.${accountId}`)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/** Create a custom skill owned by this account. Global (account_id NULL)
 *  catalog rows are seeded separately (see scripts/harvest-skills.ts output /
 *  a future seed step), never created through this API-facing path. */
export async function createCustomSkill(accountId: string, input: SkillInput): Promise<SkillRow> {
  const row = {
    account_id: accountId,
    slug: input.slug,
    name: input.name,
    description: input.description ?? null,
    category: input.category ?? null,
    instructions: input.instructions ?? '',
    source: input.source ?? 'custom',
    license: input.license ?? null,
    inspired_by: input.inspired_by ?? null,
    quality_flags: input.quality_flags ?? [],
  };
  const { data, error } = await supabase.from('skills').insert([row]).select().single();
  if (error) throw error;
  return data;
}

/** Update a custom skill. Only rows owned by this account (account_id =
 *  accountId) can be updated — global catalog rows are read-only here. */
export async function updateCustomSkill(accountId: string, id: string, patch: Partial<SkillInput>): Promise<SkillRow> {
  const row: Record<string, any> = { updated_at: new Date().toISOString() };
  if (patch.slug !== undefined) row.slug = patch.slug;
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.description !== undefined) row.description = patch.description;
  if (patch.category !== undefined) row.category = patch.category;
  if (patch.instructions !== undefined) row.instructions = patch.instructions;
  if (patch.source !== undefined) row.source = patch.source;
  if (patch.license !== undefined) row.license = patch.license;
  if (patch.inspired_by !== undefined) row.inspired_by = patch.inspired_by;
  if (patch.quality_flags !== undefined) row.quality_flags = patch.quality_flags;

  const { data, error } = await supabase
    .from('skills')
    .update(row)
    .eq('id', id)
    .eq('account_id', accountId) // only custom (account-owned) rows are editable
    .select()
    .single();
  if (error) throw error;
  if (!data) throw new Error('skill not found');
  return data;
}

/** Delete a custom skill (account-owned only; global catalog rows can't be
 *  deleted through this path). Cascades to account_skills via FK. */
export async function deleteCustomSkill(accountId: string, id: string): Promise<{ id: string; deleted: true }> {
  const { data, error } = await supabase.from('skills').delete().eq('id', id).eq('account_id', accountId).select('id');
  if (error) throw error;
  if (!data || !data.length) throw new Error('skill not found');
  return { id, deleted: true };
}

// ---------------------------------------------------------------------------
// account_skills — per-account enable state
// ---------------------------------------------------------------------------

export async function listAccountSkillStates(accountId: string): Promise<AccountSkillRow[]> {
  if (!dbReady()) return [];
  const { data, error } = await supabase.from('account_skills').select('*').eq('account_id', accountId);
  if (error) throw error;
  return data || [];
}

/** Set enabled + optional instructions override for one (account, skill) pair.
 *  Upserts so "enable" works whether or not a row already exists. */
export async function setAccountSkillState(
  accountId: string,
  skillId: string,
  patch: { enabled?: boolean; overridden_instructions?: string | null },
): Promise<AccountSkillRow> {
  const row = {
    account_id: accountId,
    skill_id: skillId,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.overridden_instructions !== undefined ? { overridden_instructions: patch.overridden_instructions } : {}),
  };
  const { data, error } = await supabase
    .from('account_skills')
    .upsert([row], { onConflict: 'account_id,skill_id' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function removeAccountSkillState(accountId: string, skillId: string): Promise<void> {
  const { error } = await supabase.from('account_skills').delete().eq('account_id', accountId).eq('skill_id', skillId);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Agent-loop helper — mirrors lib/agent/personas.ts loadPersonaForAgent style:
// never throws, degrades to an empty list on any failure so a DB hiccup can
// never break the default (no-skills) agent turn.
// ---------------------------------------------------------------------------

export interface EnabledSkillInstruction {
  /** Catalog slug — the id Hermes routes on (lib/skills/registry.ts ids are the
   *  same strings). Needed so the agent loop can intersect Hermes's chosen
   *  skillIds with what this account actually has enabled. */
  slug: string;
  name: string;
  instructions: string;
}

/** Enabled skills for this account, with any per-account instructions
 *  override applied, joined against the catalog (global + that account's
 *  custom rows). Returns [] on any error or when the DB isn't configured —
 *  the caller (lib/agent/loop.ts) must treat that as "no skills enabled". */
export async function loadEnabledSkillsForAgent(accountId: string): Promise<EnabledSkillInstruction[]> {
  if (!dbReady()) return [];
  try {
    const { data, error } = await supabase
      .from('account_skills')
      .select('enabled, overridden_instructions, skills(slug, name, instructions, account_id)')
      .eq('account_id', accountId)
      .eq('enabled', true);
    if (error) throw error;
    return (data || [])
      .filter((row: any) => row.skills)
      .map((row: any) => ({
        slug: row.skills.slug as string,
        name: row.skills.name as string,
        instructions: (row.overridden_instructions?.trim() || row.skills.instructions || '').trim(),
      }))
      .filter((s: EnabledSkillInstruction) => s.instructions.length > 0);
  } catch {
    return [];
  }
}
