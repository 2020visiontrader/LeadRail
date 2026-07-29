import { supabase } from '@/lib/db';

// ============================================================
// Tags (gap #11). Account-scoped, reusable labels + a contact join.
// ============================================================

export async function listTags(accountId: string) {
  const { data, error } = await supabase
    .from('tags')
    .select('*')
    .eq('account_id', accountId)
    .order('name', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/** Create-or-return a tag by name (idempotent per account). */
export async function upsertTag(accountId: string, name: string, color?: string) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('tag name is required');
  const { data, error } = await supabase
    .from('tags')
    .upsert([{ account_id: accountId, name: clean, color: color ?? null }], { onConflict: 'account_id,name' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteTag(accountId: string, id: string) {
  const { data, error } = await supabase.from('tags').delete().eq('account_id', accountId).eq('id', id).select('id');
  if (error) throw error;
  if (!data || !data.length) throw new Error('not found');
  return { id };
}

/** Tags currently on a contact (contact must belong to the account). */
export async function tagsForContact(accountId: string, contactId: string) {
  const { data: owns } = await supabase.from('contacts').select('id').eq('id', contactId).eq('account_id', accountId).maybeSingle();
  if (!owns) throw new Error('not found');
  const { data, error } = await supabase
    .from('contact_tags')
    .select('tag_id, tags(id, name, color)')
    .eq('contact_id', contactId);
  if (error) throw error;
  return (data ?? []).map((r: any) => r.tags).filter(Boolean);
}

/** Attach a tag (by id or name) to a contact. Both must be in the account. */
export async function addTagToContact(accountId: string, contactId: string, opts: { tagId?: string; name?: string; color?: string }) {
  const { data: owns } = await supabase.from('contacts').select('id').eq('id', contactId).eq('account_id', accountId).maybeSingle();
  if (!owns) throw new Error('not found');

  let tagId = opts.tagId;
  if (!tagId) {
    const tag = await upsertTag(accountId, opts.name || '', opts.color);
    tagId = tag.id;
  } else {
    const { data: t } = await supabase.from('tags').select('id').eq('id', tagId).eq('account_id', accountId).maybeSingle();
    if (!t) throw new Error('unknown tag');
  }
  const { error } = await supabase.from('contact_tags').upsert([{ contact_id: contactId, tag_id: tagId }], { onConflict: 'contact_id,tag_id', ignoreDuplicates: true });
  if (error) throw error;
  return { contactId, tagId };
}

export async function removeTagFromContact(accountId: string, contactId: string, tagId: string) {
  const { data: owns } = await supabase.from('contacts').select('id').eq('id', contactId).eq('account_id', accountId).maybeSingle();
  if (!owns) throw new Error('not found');
  const { error } = await supabase.from('contact_tags').delete().eq('contact_id', contactId).eq('tag_id', tagId);
  if (error) throw error;
  return { contactId, tagId };
}
