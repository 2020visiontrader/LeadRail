// Account-scoped CRUD + safe filter translation for segments (migration
// 030_segments.sql). A segment is a saved, re-runnable filter over `contacts`.
// `filters` is an array of {field, op, value} triples. To prevent SQL
// injection / cross-tenant leakage, ONLY a fixed whitelist of contact fields
// and comparison ops is ever translated into a query — anything else is
// rejected before it reaches Supabase.

import { supabase } from '@/lib/db';

export interface SegmentFilter {
  field: string;
  op: string;
  value?: any;
}

export interface SegmentRow {
  id: string;
  account_id: string;
  name: string;
  description: string | null;
  filters: SegmentFilter[];
  created_at: string;
  updated_at: string;
}

// Whitelisted contact columns a segment filter is allowed to reference.
export const ALLOWED_FIELDS = [
  'name',
  'email',
  'company',
  'title',
  'segment',
  'status',
  'source',
  'enrichment_status',
  'fit_verdict',
  'score',
  'created_at',
] as const;
export type AllowedField = (typeof ALLOWED_FIELDS)[number];

// Whitelisted comparison operators a segment filter is allowed to use.
export const ALLOWED_OPS = ['eq', 'neq', 'contains', 'gt', 'lt', 'is_null', 'not_null'] as const;
export type AllowedOp = (typeof ALLOWED_OPS)[number];

function isAllowedField(field: unknown): field is AllowedField {
  return typeof field === 'string' && (ALLOWED_FIELDS as readonly string[]).includes(field);
}

function isAllowedOp(op: unknown): op is AllowedOp {
  return typeof op === 'string' && (ALLOWED_OPS as readonly string[]).includes(op);
}

/**
 * Validate a filters array against the field/op whitelist. Returns the first
 * error message, or null if every filter is safe to translate. Ops that take
 * a value (eq/neq/contains/gt/lt) require a non-empty value; is_null/not_null
 * take no value.
 */
export function validateFilters(filters: unknown): string | null {
  if (!Array.isArray(filters)) return 'filters must be an array';
  for (const f of filters) {
    if (!f || typeof f !== 'object') return 'each filter must be an object';
    if (!isAllowedField((f as any).field)) {
      return `unknown or disallowed field: ${(f as any).field}`;
    }
    if (!isAllowedOp((f as any).op)) {
      return `unknown or disallowed op: ${(f as any).op}`;
    }
    const op = (f as any).op as AllowedOp;
    if (op !== 'is_null' && op !== 'not_null') {
      const v = (f as any).value;
      if (v === undefined || v === null || v === '') {
        return `filter on ${(f as any).field} (${op}) requires a value`;
      }
    }
  }
  return null;
}

/**
 * Apply a whitelisted filters array onto a Supabase query builder using
 * builder methods ONLY (.eq/.neq/.ilike/.gt/.lt/.is/.not) — never string
 * concatenation. Callers must validate with validateFilters() first; this
 * function also defensively skips anything not on the whitelist.
 */
function applyFilters<T>(query: T, filters: SegmentFilter[]): T {
  let q: any = query;
  for (const f of filters || []) {
    if (!isAllowedField(f.field) || !isAllowedOp(f.op)) continue; // defense in depth
    const field = f.field;
    switch (f.op as AllowedOp) {
      case 'eq':
        q = q.eq(field, f.value);
        break;
      case 'neq':
        q = q.neq(field, f.value);
        break;
      case 'contains':
        q = q.ilike(field, `%${String(f.value).replace(/[%,]/g, ' ')}%`);
        break;
      case 'gt':
        q = q.gt(field, f.value);
        break;
      case 'lt':
        q = q.lt(field, f.value);
        break;
      case 'is_null':
        q = q.is(field, null);
        break;
      case 'not_null':
        q = q.not(field, 'is', null);
        break;
    }
  }
  return q;
}

export async function listSegments(accountId: string): Promise<SegmentRow[]> {
  const { data, error } = await supabase
    .from('segments')
    .select('*')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getSegment(accountId: string, id: string): Promise<SegmentRow | null> {
  const { data, error } = await supabase
    .from('segments')
    .select('*')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function createSegment(accountId: string, input: {
  name: string; description?: string; filters?: SegmentFilter[];
}): Promise<SegmentRow> {
  const filters = input.filters ?? [];
  const fErr = validateFilters(filters);
  if (fErr) throw new Error(fErr);
  const row = {
    account_id: accountId,
    name: input.name,
    description: input.description ?? null,
    filters,
  };
  const { data, error } = await supabase.from('segments').insert([row]).select().single();
  if (error) throw error;
  return data;
}

export async function updateSegment(accountId: string, id: string, patch: {
  name?: string; description?: string; filters?: SegmentFilter[];
}): Promise<SegmentRow> {
  if (patch.filters !== undefined) {
    const fErr = validateFilters(patch.filters);
    if (fErr) throw new Error(fErr);
  }
  const row: Record<string, any> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.description !== undefined) row.description = patch.description;
  if (patch.filters !== undefined) row.filters = patch.filters;
  const { data, error } = await supabase
    .from('segments')
    .update(row)
    .eq('id', id)
    .eq('account_id', accountId)
    .select()
    .single();
  if (error) throw error;
  if (!data) throw new Error('segment not found');
  return data;
}

export async function deleteSegment(accountId: string, id: string): Promise<{ id: string; deleted: true }> {
  const { data, error } = await supabase
    .from('segments')
    .delete()
    .eq('id', id)
    .eq('account_id', accountId)
    .select('id');
  if (error) throw error;
  if (!data || !data.length) throw new Error('segment not found');
  return { id, deleted: true };
}

const PREVIEW_SAMPLE_SIZE = 25;

/**
 * Preview how many contacts match a filters array, plus a small sample.
 * Always account-scoped and excludes soft-deleted contacts, matching the
 * lib/db.ts getContacts() convention.
 */
export async function previewSegment(
  accountId: string,
  filters: SegmentFilter[],
): Promise<{ count: number; sample: any[] }> {
  const fErr = validateFilters(filters);
  if (fErr) throw new Error(fErr);

  let countQuery: any = supabase
    .from('contacts')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .is('deleted_at', null);
  countQuery = applyFilters(countQuery, filters);
  const { count, error: countErr } = await countQuery;
  if (countErr) throw countErr;

  let sampleQuery: any = supabase
    .from('contacts')
    .select('*')
    .eq('account_id', accountId)
    .is('deleted_at', null);
  sampleQuery = applyFilters(sampleQuery, filters);
  const { data: sample, error: sampleErr } = await sampleQuery
    .order('created_at', { ascending: false })
    .limit(PREVIEW_SAMPLE_SIZE);
  if (sampleErr) throw sampleErr;

  return { count: count || 0, sample: sample || [] };
}
