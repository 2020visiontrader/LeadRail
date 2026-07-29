// CRM data layer — Wave 1 objects (companies, deals/pipeline, activities, notes).
// Every mutation records an audit_log row via writeAudit(). Server-side only
// (uses the service-role Supabase client from db.ts). Admin/account-scoped.
import { supabase } from '@/lib/db';

// ---------------------------------------------------------------------------
// Audit log — best-effort, never fails the caller's operation.
// ---------------------------------------------------------------------------
export async function writeAudit(row: {
  account_id: string;
  brand_id?: string | null;
  actor_email?: string;
  action: 'import' | 'enrich' | 'merge' | 'create' | 'update' | 'delete';
  entity_type?: string;
  entity_id?: string;
  detail?: Record<string, any>;
}) {
  try {
    await supabase.from('audit_log').insert([row]);
  } catch (e: any) {
    console.error('[audit]', e?.message || e);
  }
}

export async function getAuditLog(accountId: string, limit = 100) {
  const { data, error } = await supabase
    .from('audit_log')
    .select('*')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------
export async function getCompanies(accountId: string, brandId?: string | null, limit = 50, offset = 0) {
  let q = supabase.from('companies').select('*').eq('account_id', accountId);
  if (brandId) q = q.eq('brand_id', brandId);
  const { data, error } = await q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  if (error) throw error;
  return data;
}

export async function getCompany(id: string) {
  const { data, error } = await supabase.from('companies').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

export async function createCompany(row: Record<string, any>) {
  const { data, error } = await supabase.from('companies').insert([row]).select().single();
  if (error) throw error;
  await writeAudit({ account_id: row.account_id, brand_id: row.brand_id, action: 'create', entity_type: 'company', entity_id: data.id });
  return data;
}

export async function updateCompany(id: string, updates: Record<string, any>) {
  const { data, error } = await supabase
    .from('companies')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  await writeAudit({ account_id: data.account_id, brand_id: data.brand_id, action: 'update', entity_type: 'company', entity_id: id, detail: { fields: Object.keys(updates) } });
  return data;
}

export async function deleteCompany(id: string) {
  const { data } = await supabase.from('companies').select('account_id, brand_id').eq('id', id).single();
  const { error } = await supabase.from('companies').delete().eq('id', id);
  if (error) throw error;
  if (data) await writeAudit({ account_id: data.account_id, brand_id: data.brand_id, action: 'delete', entity_type: 'company', entity_id: id });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Pipeline stages
// ---------------------------------------------------------------------------
export async function getPipelineStages(accountId: string, brandId?: string | null) {
  let q = supabase.from('pipeline_stages').select('*').eq('account_id', accountId);
  // brand-specific pipeline if present, else the account-wide default (brand_id IS NULL)
  q = brandId ? q.or(`brand_id.eq.${brandId},brand_id.is.null`) : q.is('brand_id', null);
  const { data, error } = await q.order('position', { ascending: true });
  if (error) throw error;
  return data;
}

export async function createPipelineStage(row: Record<string, any>) {
  const { data, error } = await supabase.from('pipeline_stages').insert([row]).select().single();
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------------
// Deals
// ---------------------------------------------------------------------------
export async function getDeals(accountId: string, brandId?: string | null, limit = 100, offset = 0) {
  let q = supabase.from('deals').select('*').eq('account_id', accountId);
  if (brandId) q = q.eq('brand_id', brandId);
  const { data, error } = await q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  if (error) throw error;
  return data;
}

export async function getDeal(id: string) {
  const { data, error } = await supabase.from('deals').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

export async function createDeal(row: Record<string, any>) {
  const { data, error } = await supabase.from('deals').insert([row]).select().single();
  if (error) throw error;
  await writeAudit({ account_id: row.account_id, brand_id: row.brand_id, action: 'create', entity_type: 'deal', entity_id: data.id });
  return data;
}

export async function updateDeal(id: string, updates: Record<string, any>) {
  const { data, error } = await supabase
    .from('deals')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  await writeAudit({ account_id: data.account_id, brand_id: data.brand_id, action: 'update', entity_type: 'deal', entity_id: id, detail: { fields: Object.keys(updates) } });
  return data;
}

export async function moveDealStage(id: string, stageId: string) {
  // Reflect won/lost status from the target stage.
  const { data: stage } = await supabase.from('pipeline_stages').select('is_won, is_lost').eq('id', stageId).single();
  const status = stage?.is_won ? 'won' : stage?.is_lost ? 'lost' : 'open';
  const patch: Record<string, any> = { stage_id: stageId, status, updated_at: new Date().toISOString() };
  if (status !== 'open') patch.closed_at = new Date().toISOString();
  const { data, error } = await supabase.from('deals').update(patch).eq('id', id).select().single();
  if (error) throw error;
  await writeAudit({ account_id: data.account_id, brand_id: data.brand_id, action: 'update', entity_type: 'deal', entity_id: id, detail: { stage_id: stageId, status } });
  return data;
}

export async function deleteDeal(id: string) {
  const { data } = await supabase.from('deals').select('account_id, brand_id').eq('id', id).single();
  const { error } = await supabase.from('deals').delete().eq('id', id);
  if (error) throw error;
  if (data) await writeAudit({ account_id: data.account_id, brand_id: data.brand_id, action: 'delete', entity_type: 'deal', entity_id: id });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------
export async function getActivities(accountId: string, filters: { contactId?: string; dealId?: string; companyId?: string } = {}, limit = 100) {
  let q = supabase.from('activities').select('*').eq('account_id', accountId);
  if (filters.contactId) q = q.eq('contact_id', filters.contactId);
  if (filters.dealId) q = q.eq('deal_id', filters.dealId);
  if (filters.companyId) q = q.eq('company_id', filters.companyId);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return data;
}

export async function createActivity(row: Record<string, any>) {
  const { data, error } = await supabase.from('activities').insert([row]).select().single();
  if (error) throw error;
  await writeAudit({ account_id: row.account_id, brand_id: row.brand_id, action: 'create', entity_type: 'activity', entity_id: data.id });
  return data;
}

export async function updateActivity(id: string, updates: Record<string, any>) {
  const { data, error } = await supabase
    .from('activities')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteActivity(id: string) {
  const { error } = await supabase.from('activities').delete().eq('id', id);
  if (error) throw error;
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------
export async function getNotes(accountId: string, filters: { contactId?: string; dealId?: string; companyId?: string } = {}, limit = 100) {
  let q = supabase.from('notes').select('*').eq('account_id', accountId);
  if (filters.contactId) q = q.eq('contact_id', filters.contactId);
  if (filters.dealId) q = q.eq('deal_id', filters.dealId);
  if (filters.companyId) q = q.eq('company_id', filters.companyId);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return data;
}

export async function createNote(row: Record<string, any>) {
  const { data, error } = await supabase.from('notes').insert([row]).select().single();
  if (error) throw error;
  return data;
}

export async function deleteNote(id: string) {
  const { error } = await supabase.from('notes').delete().eq('id', id);
  if (error) throw error;
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Company upsert-by-name — used by the Apollo import to build the Account layer.
// Idempotent per (account_id, lower(name)); returns the company id or null.
// ---------------------------------------------------------------------------
export async function upsertCompanyByName(
  accountId: string,
  brandId: string | null,
  name: string,
  extra: { domain?: string; industry?: string; website?: string; size?: string } = {}
): Promise<string | null> {
  const clean = (name || '').trim();
  if (!clean) return null;
  const { data: existing } = await supabase
    .from('companies')
    .select('id')
    .eq('account_id', accountId)
    .ilike('name', clean)
    .limit(1);
  if (existing && existing.length) return existing[0].id;
  const { data, error } = await supabase
    .from('companies')
    .insert([{ account_id: accountId, brand_id: brandId, name: clean, ...extra }])
    .select('id')
    .single();
  if (error) { console.error('[upsertCompany]', error.message); return null; }
  await writeAudit({ account_id: accountId, brand_id: brandId, action: 'create', entity_type: 'company', entity_id: data.id, detail: { via: 'apollo_import' } });
  return data.id;
}

// ---------------------------------------------------------------------------
// Territories
// ---------------------------------------------------------------------------
export async function getTerritories(accountId: string, brandId?: string | null) {
  let q = supabase.from('territories').select('*').eq('account_id', accountId);
  if (brandId) q = q.eq('brand_id', brandId);
  const { data, error } = await q.order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}
export async function createTerritory(row: Record<string, any>) {
  const { data, error } = await supabase.from('territories').insert([row]).select().single();
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------------
// Campaign members (ad_campaigns membership)
// ---------------------------------------------------------------------------
export async function getCampaignMembers(campaignId: string) {
  const { data, error } = await supabase
    .from('campaign_members').select('*, contacts(name,email,company)').eq('campaign_id', campaignId);
  if (error) throw error;
  return data;
}
export async function addCampaignMembers(campaignId: string, accountId: string, contactIds: string[]) {
  const rows = contactIds.map((cid) => ({ campaign_id: campaignId, account_id: accountId, contact_id: cid }));
  const { data, error } = await supabase.from('campaign_members').upsert(rows, { onConflict: 'campaign_id,contact_id' }).select();
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------------
// Contact ↔ company roles (multi-org)
// ---------------------------------------------------------------------------
export async function getContactCompanyRoles(contactId: string) {
  const { data, error } = await supabase
    .from('contact_company_roles').select('*, companies(name,domain)').eq('contact_id', contactId);
  if (error) throw error;
  return data;
}
export async function linkContactCompany(row: { account_id: string; contact_id: string; company_id: string; role?: string; is_primary?: boolean }) {
  const { data, error } = await supabase
    .from('contact_company_roles').upsert([row], { onConflict: 'contact_id,company_id' }).select().single();
  if (error) throw error;
  return data;
}
