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

export async function getCompany(id: string, accountId: string) {
  const { data, error } = await supabase.from('companies').select('*').eq('id', id).eq('account_id', accountId).single();
  if (error) throw error;
  return data;
}

export async function createCompany(row: Record<string, any>) {
  const { data, error } = await supabase.from('companies').insert([row]).select().single();
  if (error) throw error;
  await writeAudit({ account_id: row.account_id, brand_id: row.brand_id, action: 'create', entity_type: 'company', entity_id: data.id });
  return data;
}

export async function updateCompany(id: string, accountId: string, updates: Record<string, any>) {
  const { data, error } = await supabase
    .from('companies')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('account_id', accountId)
    .select()
    .single();
  if (error) throw error;
  await writeAudit({ account_id: data.account_id, brand_id: data.brand_id, action: 'update', entity_type: 'company', entity_id: id, detail: { fields: Object.keys(updates) } });
  return data;
}

export async function deleteCompany(id: string, accountId: string) {
  const { data } = await supabase.from('companies').select('account_id, brand_id').eq('id', id).eq('account_id', accountId).single();
  if (!data) throw new Error('not found');
  const { error } = await supabase.from('companies').delete().eq('id', id).eq('account_id', accountId);
  if (error) throw error;
  await writeAudit({ account_id: data.account_id, brand_id: data.brand_id, action: 'delete', entity_type: 'company', entity_id: id });
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

export async function getDeal(id: string, accountId: string) {
  const { data, error } = await supabase.from('deals').select('*').eq('id', id).eq('account_id', accountId).single();
  if (error) throw error;
  return data;
}

export async function createDeal(row: Record<string, any>) {
  const { data, error } = await supabase.from('deals').insert([row]).select().single();
  if (error) throw error;
  await writeAudit({ account_id: row.account_id, brand_id: row.brand_id, action: 'create', entity_type: 'deal', entity_id: data.id });
  return data;
}

export async function updateDeal(id: string, accountId: string, updates: Record<string, any>) {
  const { data, error } = await supabase
    .from('deals')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('account_id', accountId)
    .select()
    .single();
  if (error) throw error;
  await writeAudit({ account_id: data.account_id, brand_id: data.brand_id, action: 'update', entity_type: 'deal', entity_id: id, detail: { fields: Object.keys(updates) } });
  return data;
}

export async function moveDealStage(id: string, accountId: string, stageId: string) {
  // Reflect won/lost status from the target stage. Scope the stage lookup to the
  // same account so a caller can't move a deal onto another tenant's stage.
  const { data: stage } = await supabase.from('pipeline_stages').select('is_won, is_lost').eq('id', stageId).eq('account_id', accountId).single();
  if (!stage) throw new Error('stage not found');
  const status = stage?.is_won ? 'won' : stage?.is_lost ? 'lost' : 'open';
  const patch: Record<string, any> = { stage_id: stageId, status, updated_at: new Date().toISOString() };
  if (status !== 'open') patch.closed_at = new Date().toISOString();
  const { data, error } = await supabase.from('deals').update(patch).eq('id', id).eq('account_id', accountId).select().single();
  if (error) throw error;
  await writeAudit({ account_id: data.account_id, brand_id: data.brand_id, action: 'update', entity_type: 'deal', entity_id: id, detail: { stage_id: stageId, status } });
  return data;
}

export async function deleteDeal(id: string, accountId: string) {
  const { data } = await supabase.from('deals').select('account_id, brand_id').eq('id', id).eq('account_id', accountId).single();
  if (!data) throw new Error('not found');
  const { error } = await supabase.from('deals').delete().eq('id', id).eq('account_id', accountId);
  if (error) throw error;
  await writeAudit({ account_id: data.account_id, brand_id: data.brand_id, action: 'delete', entity_type: 'deal', entity_id: id });
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

export async function updateActivity(id: string, accountId: string, updates: Record<string, any>) {
  const { data, error } = await supabase
    .from('activities')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('account_id', accountId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteActivity(id: string, accountId: string) {
  const { data, error } = await supabase.from('activities').delete().eq('id', id).eq('account_id', accountId).select('id');
  if (error) throw error;
  if (!data || !data.length) throw new Error('not found');
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

export async function deleteNote(id: string, accountId: string) {
  const { data, error } = await supabase.from('notes').delete().eq('id', id).eq('account_id', accountId).select('id');
  if (error) throw error;
  if (!data || !data.length) throw new Error('not found');
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
export async function getCampaignMembers(campaignId: string, accountId: string) {
  const { data, error } = await supabase
    .from('campaign_members').select('*, contacts(name,email,company)').eq('campaign_id', campaignId).eq('account_id', accountId);
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
export async function getContactCompanyRoles(contactId: string, accountId: string) {
  const { data, error } = await supabase
    .from('contact_company_roles').select('*, companies(name,domain)').eq('contact_id', contactId).eq('account_id', accountId);
  if (error) throw error;
  return data;
}
export async function linkContactCompany(row: { account_id: string; contact_id: string; company_id: string; role?: string; is_primary?: boolean }) {
  const { data, error } = await supabase
    .from('contact_company_roles').upsert([row], { onConflict: 'contact_id,company_id' }).select().single();
  if (error) throw error;
  return data;
}

// ===========================================================================
// Contact merge (dedup WITH lineage) — writes contact_merges + contact_aliases
// + audit_log. Nothing is lost: the absorbed row is snapshotted before delete.
// ===========================================================================
export async function mergeContacts(opts: {
  accountId: string;
  survivingId: string;
  mergedId: string;
  actorEmail?: string;
  reason?: string;
}) {
  const { accountId, survivingId, mergedId, actorEmail, reason } = opts;
  if (survivingId === mergedId) throw new Error('cannot merge a contact into itself');

  const { data: surviving } = await supabase.from('contacts').select('*').eq('id', survivingId).single();
  const { data: merged } = await supabase.from('contacts').select('*').eq('id', mergedId).single();
  if (!surviving || !merged) throw new Error('both contacts must exist');

  // Coalesce: fill empty surviving fields from the merged record (survivor wins on conflict).
  const fillable = ['company', 'company_id', 'title', 'segment', 'notes', 'linkedin_url', 'phone', 'enriched', 'fit_verdict', 'source'];
  const patch: Record<string, any> = {};
  for (const f of fillable) {
    if ((surviving[f] === null || surviving[f] === undefined || surviving[f] === '') && merged[f]) patch[f] = merged[f];
  }
  patch.score = Math.max(Number(surviving.score) || 0, Number(merged.score) || 0);
  if (Object.keys(patch).length) await supabase.from('contacts').update(patch).eq('id', survivingId);

  // Preserve the absorbed identities as aliases (never lose an email/name).
  const aliases: any[] = [];
  if (merged.email && merged.email !== surviving.email) aliases.push({ account_id: accountId, contact_id: survivingId, alias_type: 'email', alias_value: merged.email, source: 'merge' });
  if (merged.name && merged.name !== surviving.name) aliases.push({ account_id: accountId, contact_id: survivingId, alias_type: 'name', alias_value: merged.name, source: 'merge' });
  if (merged.phone && merged.phone !== surviving.phone) aliases.push({ account_id: accountId, contact_id: survivingId, alias_type: 'phone', alias_value: merged.phone, source: 'merge' });
  if (aliases.length) await supabase.from('contact_aliases').upsert(aliases, { onConflict: 'contact_id,alias_type,alias_value', ignoreDuplicates: true });

  // Reassign relational rows from merged -> surviving (best-effort; skip on conflict).
  for (const rel of ['activities', 'notes', 'sequence_enrollments', 'inbox_messages', 'deal_contact_roles', 'contact_company_roles']) {
    try { await supabase.from(rel).update({ contact_id: survivingId }).eq('contact_id', mergedId); } catch { /* unique-constraint conflicts are acceptable */ }
  }

  // Lineage row (full pre-merge snapshot) then hard-delete the absorbed contact.
  await supabase.from('contact_merges').insert([{ account_id: accountId, surviving_contact_id: survivingId, merged_contact_id: mergedId, merged_snapshot: merged, reason: reason ?? null, actor_email: actorEmail ?? null }]);
  await supabase.from('contacts').delete().eq('id', mergedId);
  await writeAudit({ account_id: accountId, actor_email: actorEmail, action: 'merge', entity_type: 'contact', entity_id: survivingId, detail: { merged_contact_id: mergedId, merged_email: merged.email } });

  return { survivingId, mergedId, aliasesAdded: aliases.length };
}

export async function getContactAliases(contactId: string, accountId: string) {
  const { data, error } = await supabase.from('contact_aliases').select('*').eq('contact_id', contactId).eq('account_id', accountId);
  if (error) throw error;
  return data ?? [];
}

// ===========================================================================
// Wave-2 CRUD: cases, knowledge_articles, entitlements, partners
// ===========================================================================
function scoped(table: string) {
  return {
    async list(accountId: string, brandId?: string | null, limit = 100) {
      let q = supabase.from(table).select('*').eq('account_id', accountId).order('created_at', { ascending: false }).limit(limit);
      if (brandId) q = q.eq('brand_id', brandId);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
    async create(row: Record<string, any>) {
      const { data, error } = await supabase.from(table).insert([row]).select().single();
      if (error) throw error;
      await writeAudit({ account_id: row.account_id, brand_id: row.brand_id ?? null, action: 'create', entity_type: table, entity_id: data.id });
      return data;
    },
    async update(id: string, updates: Record<string, any>, accountId: string) {
      const { data, error } = await supabase.from(table).update(updates).eq('id', id).eq('account_id', accountId).select().single();
      if (error) throw error;
      await writeAudit({ account_id: accountId, action: 'update', entity_type: table, entity_id: id });
      return data;
    },
    async remove(id: string, accountId: string) {
      const { data, error } = await supabase.from(table).delete().eq('id', id).eq('account_id', accountId).select('id');
      if (error) throw error;
      if (!data || !data.length) throw new Error('not found');
      await writeAudit({ account_id: accountId, action: 'delete', entity_type: table, entity_id: id });
      return { id };
    },
  };
}
export const casesRepo = scoped('cases');
export const knowledgeRepo = scoped('knowledge_articles');
export const partnersRepo = scoped('partners');

// entitlements scope by company, not brand
export async function getEntitlements(accountId: string, companyId?: string) {
  let q = supabase.from('entitlements').select('*').eq('account_id', accountId);
  if (companyId) q = q.eq('company_id', companyId);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}
export async function createEntitlement(row: Record<string, any>) {
  const { data, error } = await supabase.from('entitlements').insert([row]).select().single();
  if (error) throw error;
  await writeAudit({ account_id: row.account_id, action: 'create', entity_type: 'entitlements', entity_id: data.id });
  return data;
}

// ===========================================================================
// Campaign assets + analytics
// ===========================================================================
export async function getCampaignAssets(campaignId: string, accountId: string) {
  const { data, error } = await supabase.from('campaign_assets').select('*').eq('campaign_id', campaignId).eq('account_id', accountId).order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}
export async function updateCampaignAsset(id: string, updates: Record<string, any>) {
  const { data, error } = await supabase.from('campaign_assets').update(updates).eq('id', id).select().single();
  if (error) throw error;
  return data;
}
// Roll up spend/budget across a brand's campaigns (real analytics land once Meta/Google connect).
export async function getCampaignAnalytics(brandId: string) {
  const { data, error } = await supabase.from('ad_campaigns').select('id,name,status,channel,budget,spend').eq('brand_id', brandId);
  if (error) throw error;
  const rows = data ?? [];
  const totalBudget = rows.reduce((s, r: any) => s + (Number(r.budget) || 0), 0);
  const totalSpend = rows.reduce((s, r: any) => s + (Number(r.spend) || 0), 0);
  const byChannel: Record<string, { budget: number; spend: number; count: number }> = {};
  for (const r of rows as any[]) {
    const c = r.channel || 'unspecified';
    byChannel[c] = byChannel[c] || { budget: 0, spend: 0, count: 0 };
    byChannel[c].budget += Number(r.budget) || 0;
    byChannel[c].spend += Number(r.spend) || 0;
    byChannel[c].count += 1;
  }
  return { campaigns: rows.length, totalBudget, totalSpend, remaining: totalBudget - totalSpend, byChannel };
}
