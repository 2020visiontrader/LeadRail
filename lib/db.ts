import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

export const supabase = createClient(supabaseUrl, supabaseKey);

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

export async function createContact(contact: any) {
  const { data, error } = await supabase
    .from('contacts')
    .insert([contact])
    .select();
  if (error) throw error;
  return data[0];
}

export async function updateContact(id: string, updates: any) {
  const { data, error } = await supabase
    .from('contacts')
    .update(updates)
    .eq('id', id)
    .select();
  if (error) throw error;
  return data[0];
}