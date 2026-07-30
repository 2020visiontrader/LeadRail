import { createClient } from '@supabase/supabase-js';

// Server-side Supabase client.
// Prefer the service-role key (bypasses RLS) for all API-route data access.
// Falls back to the anon key only in local dev where no service key is set.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  '';

// Placeholders keep createClient from throwing at build/import time when env is
// absent. Real readiness is gated by dbReady(); queries fail gracefully otherwise.
const clientUrl = supabaseUrl || 'http://localhost:54321';
const clientKey = serviceKey || 'placeholder-key';

export const supabase = createClient(clientUrl, clientKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export function dbReady(): boolean {
  return Boolean(supabaseUrl && serviceKey);
}

/**
 * Verify a brand belongs to the given account. Returns true only when the brand
 * exists AND is owned by accountId. Callers use this to reject client-supplied
 * brandId values that belong to another tenant.
 */
export async function assertBrandOwned(brandId: string, accountId: string): Promise<boolean> {
  const { data } = await supabase
    .from('brands')
    .select('id')
    .eq('id', brandId)
    .eq('account_id', accountId)
    .maybeSingle();
  return Boolean(data);
}

export async function getContacts(accountId: string, brandId: string, limit = 30, offset = 0) {
  const { data, error } = await supabase
    .from('contacts')
    .select('*')
    .eq('account_id', accountId)
    .eq('brand_id', brandId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return data;
}

export async function getContact(id: string, accountId: string) {
  const { data, error } = await supabase
    .from('contacts')
    .select('*')
    .eq('id', id)
    .eq('account_id', accountId)
    .is('deleted_at', null)
    .single();
  if (error) throw error;
  return data;
}

export async function createContact(contact: Record<string, any>) {
  const { data, error } = await supabase.from('contacts').insert([contact]).select();
  if (error) throw error;
  return data[0];
}

export async function updateContact(id: string, accountId: string, updates: Record<string, any>) {
  const { data, error } = await supabase
    .from('contacts')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('account_id', accountId)
    .select();
  if (error) throw error;
  if (!data || !data.length) throw new Error('not found');
  return data[0];
}

export async function deleteContact(id: string, accountId: string) {
  // Soft delete: mark deleted_at so the row is recoverable until the purge cron
  // (purge_soft_deleted) hard-removes it after the retention window.
  const { data, error } = await supabase
    .from('contacts')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .eq('account_id', accountId)
    .is('deleted_at', null)
    .select('id');
  if (error) throw error;
  if (!data || !data.length) throw new Error('not found');
  return { id, deleted: true };
}

export async function findContactByEmail(email: string, accountId: string) {
  const { data } = await supabase
    .from('contacts')
    .select('id')
    .eq('email', email)
    .eq('account_id', accountId)
    .limit(1);
  return data && data.length ? data[0] : null;
}

// -----------------------------------------------------------------------------
// TRUSTED INTERNAL-ONLY fetchers. Not tenant-scoped. Use ONLY from server-side
// automation (sequence/hermes runners) or provider webhooks where the id/email
// originates from the platform's own data, never from an end-user HTTP request.
// Never call these directly from a user-facing route handler.
// -----------------------------------------------------------------------------
export async function getContactUnscoped(id: string) {
  const { data, error } = await supabase.from('contacts').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

export async function findContactByEmailUnscoped(email: string) {
  const { data } = await supabase.from('contacts').select('id, account_id').eq('email', email).limit(1);
  return data && data.length ? data[0] : null;
}

// ============================================================
// Ventures (brands) — account-scoped
// ============================================================
export async function getVentures(accountId?: string) {
  let q = supabase.from('brands').select('*').order('created_at', { ascending: true });
  if (accountId) q = q.eq('account_id', accountId);
  const { data, error } = await q;
  if (error) throw error;
  const brands = data || [];
  // Attach a contact_count per brand so the UI can default to a brand that has
  // leads instead of an arbitrary insertion-first brand that may be empty.
  const counts: Record<string, number> = {};
  await Promise.all(
    brands.map(async (b: any) => {
      let cq = supabase.from('contacts').select('id', { count: 'exact', head: true }).eq('brand_id', b.id);
      if (accountId) cq = cq.eq('account_id', accountId);
      const { count } = await cq;
      counts[b.id] = count || 0;
    })
  );
  return brands.map((b: any) => ({ ...b, contact_count: counts[b.id] ?? 0 }));
}

export async function getVenture(brandId: string) {
  const { data, error } = await supabase.from('brands').select('*').eq('id', brandId).single();
  if (error) throw error;
  return data;
}

/**
 * Create a venture (brand) for an account. brands.id is a TEXT slug PK, so we
 * derive a URL-safe slug from the name and disambiguate on collision. Scoped to
 * the caller's account_id (authoritative from session, never the client body).
 */
export async function createVenture(accountId: string, name: string) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('name is required');
  const base = clean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'venture';
  let slug = base;
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const { data: exists } = await supabase.from('brands').select('id').eq('id', candidate).maybeSingle();
    if (!exists) { slug = candidate; break; }
  }
  const { data, error } = await supabase
    .from('brands')
    .insert([{ id: slug, name: clean, active: true, account_id: accountId }])
    .select()
    .single();
  if (error) throw error;
  return { ...data, contact_count: 0 };
}

// ============================================================
// Integration connections — account-scoped, one row per provider
// ============================================================
export async function getConnections(accountId: string) {
  const { data, error } = await supabase
    .from('integration_connections')
    .select('*')
    .eq('account_id', accountId)
    .order('provider', { ascending: true });
  if (error) throw error;
  return data;
}

export async function upsertConnection(row: {
  account_id: string;
  provider: string;
  status?: string;
  secret_ref?: string | null;
  meta?: Record<string, any>;
}) {
  const payload = {
    account_id: row.account_id,
    provider: row.provider,
    status: row.status ?? 'connected',
    secret_ref: row.secret_ref ?? null,
    meta: row.meta ?? {},
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from('integration_connections')
    .upsert(payload, { onConflict: 'account_id,provider' })
    .select();
  if (error) throw error;
  return data[0];
}

export async function deleteConnection(accountId: string, provider: string) {
  const { error } = await supabase
    .from('integration_connections')
    .delete()
    .eq('account_id', accountId)
    .eq('provider', provider);
  if (error) throw error;
  return { provider, deleted: true };
}

// ============================================================
// Apollo searches — audit log of ICP pulls
// ============================================================
export async function logApolloSearch(row: {
  account_id: string;
  brand_id: string;
  query: Record<string, any>;
  status?: string;
  result_count?: number;
}) {
  const { data, error } = await supabase
    .from('apollo_searches')
    .insert([{
      account_id: row.account_id,
      brand_id: row.brand_id,
      query: row.query,
      status: row.status ?? 'done',
      result_count: row.result_count ?? 0,
    }])
    .select();
  if (error) throw error;
  return data[0];
}

/** Bulk insert imported leads (dedupe by email handled by caller). */
export async function insertContacts(rows: Record<string, any>[]) {
  if (!rows.length) return [];
  const { data, error } = await supabase.from('contacts').insert(rows).select();
  if (error) throw error;
  return data;
}

// ============================================================
// Message templates — account-scoped, optional brand scope
// ============================================================
export async function getTemplates(accountId: string, brandId?: string) {
  let q = supabase.from('message_templates').select('*').eq('account_id', accountId);
  if (brandId) q = q.or(`brand_id.eq.${brandId},brand_id.is.null`);
  const { data, error } = await q.order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function createTemplate(row: {
  account_id: string; brand_id?: string | null; name: string;
  category?: string | null; subject?: string | null; body: string;
}) {
  const { data, error } = await supabase.from('message_templates').insert([{
    account_id: row.account_id,
    brand_id: row.brand_id ?? null,
    name: row.name,
    category: row.category ?? null,
    subject: row.subject ?? null,
    body: row.body,
  }]).select().single();
  if (error) throw error;
  return data;
}

export async function deleteTemplate(id: string, accountId: string) {
  const { data, error } = await supabase.from('message_templates').delete().eq('id', id).eq('account_id', accountId).select('id');
  if (error) throw error;
  if (!data || !data.length) throw new Error('not found');
  return { id, deleted: true };
}

// ============================================================
// Inbox — account-scoped
// ============================================================
export async function getInbox(accountId: string, limit = 50) {
  const { data, error } = await supabase
    .from('inbox_messages')
    .select('*')
    .eq('account_id', accountId)
    .order('received_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

export async function markInboxRead(id: string, accountId: string, isRead = true) {
  const { data, error } = await supabase
    .from('inbox_messages')
    .update({ is_read: isRead })
    .eq('id', id)
    .eq('account_id', accountId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ============================================================
// Campaign assets (generated static images) — account-scoped
// ============================================================
export async function insertCampaignAsset(row: {
  campaign_id: string;
  account_id: string;
  kind?: string;
  url: string;
  ai_analysis?: Record<string, any>;
  status?: string;
}) {
  const { data, error } = await supabase
    .from('campaign_assets')
    .insert([{ kind: 'image', status: 'raw', ...row }])
    .select()
    .single();
  if (error) throw error;
  return data;
}
