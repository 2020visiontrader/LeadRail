// Saved ICP profiles (Phase C, item 16).
// A named, reusable Apollo query so an operator defines an ideal-customer
// profile once and re-runs it. Same JSON shape as apollo_searches.query.

import { supabase } from '@/lib/db';
import type { ApolloQuery } from '@/lib/types';

export async function listIcpProfiles(accountId: string, brandId?: string | null) {
  let q = supabase.from('icp_profiles').select('*').eq('account_id', accountId).order('updated_at', { ascending: false });
  if (brandId) q = q.eq('brand_id', brandId);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

export async function getIcpProfile(id: string, accountId: string) {
  const { data, error } = await supabase.from('icp_profiles').select('*').eq('id', id).eq('account_id', accountId).single();
  if (error) throw error;
  return data;
}

export async function createIcpProfile(input: {
  account_id: string;
  brand_id?: string | null;
  name: string;
  query: ApolloQuery;
}) {
  const { data, error } = await supabase
    .from('icp_profiles')
    .insert([{ account_id: input.account_id, brand_id: input.brand_id ?? null, name: input.name, query: input.query }])
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateIcpProfile(id: string, accountId: string, updates: { name?: string; query?: ApolloQuery; brand_id?: string | null }) {
  const patch: Record<string, any> = { updated_at: new Date().toISOString() };
  if (updates.name != null) patch.name = updates.name;
  if (updates.query != null) patch.query = updates.query;
  if (updates.brand_id !== undefined) patch.brand_id = updates.brand_id;
  const { data, error } = await supabase.from('icp_profiles').update(patch).eq('id', id).eq('account_id', accountId).select().single();
  if (error) throw error;
  return data;
}

export async function deleteIcpProfile(id: string, accountId: string) {
  const { data, error } = await supabase.from('icp_profiles').delete().eq('id', id).eq('account_id', accountId).select('id');
  if (error) throw error;
  if (!data || !data.length) throw new Error('not found');
  return { id, deleted: true };
}

/** Stamp a run onto the profile (called after an Apollo search fired from it). */
export async function recordIcpRun(id: string, accountId: string, resultCount: number) {
  await supabase
    .from('icp_profiles')
    .update({ last_run_at: new Date().toISOString(), last_result_count: resultCount })
    .eq('id', id)
    .eq('account_id', accountId)
    .then(() => {}, () => {});
}
