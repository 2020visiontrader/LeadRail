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

export async function getContacts(brandId: string, limit = 30, offset = 0) {
  const { data, error } = await supabase
    .from('contacts')
    .select('*')
    .eq('brand_id', brandId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return data;
}

export async function getContact(id: string) {
  const { data, error } = await supabase.from('contacts').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

export async function createContact(contact: Record<string, any>) {
  const { data, error } = await supabase.from('contacts').insert([contact]).select();
  if (error) throw error;
  return data[0];
}

export async function updateContact(id: string, updates: Record<string, any>) {
  const { data, error } = await supabase
    .from('contacts')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select();
  if (error) throw error;
  return data[0];
}

export async function deleteContact(id: string) {
  const { error } = await supabase.from('contacts').delete().eq('id', id);
  if (error) throw error;
  return { id, deleted: true };
}

export async function findContactByEmail(email: string) {
  const { data } = await supabase.from('contacts').select('id').eq('email', email).limit(1);
  return data && data.length ? data[0] : null;
}
