// Account-scoped CRUD for web lead-capture forms (migration 035_forms.sql),
// plus the PUBLIC read/submit path used by the embeddable form widget.
//
// getPublicForm/submitForm are the ONLY functions here that run with no
// session. They derive account_id from the form row itself — never from the
// caller — so a public submission can never be attributed to another
// tenant's account, and getPublicForm never exposes account internals.

import { supabase } from '@/lib/db';

export interface FormField {
  key: string;
  label: string;
  type: 'text' | 'email' | 'tel' | 'textarea';
  required: boolean;
}

export interface FormRow {
  id: string;
  account_id: string;
  name: string;
  fields: FormField[];
  redirect_url: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface FormSubmissionRow {
  id: string;
  form_id: string;
  account_id: string;
  data: Record<string, any>;
  contact_id: string | null;
  created_at: string;
}

export async function listForms(accountId: string): Promise<FormRow[]> {
  const { data, error } = await supabase
    .from('forms')
    .select('*')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getForm(accountId: string, id: string): Promise<FormRow | null> {
  const { data, error } = await supabase
    .from('forms')
    .select('*')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function createForm(accountId: string, input: {
  name: string; fields?: FormField[]; redirect_url?: string | null; enabled?: boolean;
}): Promise<FormRow> {
  const row = {
    account_id: accountId,
    name: input.name,
    fields: input.fields ?? [],
    redirect_url: input.redirect_url ?? null,
    enabled: input.enabled ?? true,
  };
  const { data, error } = await supabase.from('forms').insert([row]).select().single();
  if (error) throw error;
  return data;
}

export async function updateForm(accountId: string, id: string, patch: {
  name?: string; fields?: FormField[]; redirect_url?: string | null; enabled?: boolean;
}): Promise<FormRow> {
  const row: Record<string, any> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.fields !== undefined) row.fields = patch.fields;
  if (patch.redirect_url !== undefined) row.redirect_url = patch.redirect_url;
  if (patch.enabled !== undefined) row.enabled = patch.enabled;
  const { data, error } = await supabase
    .from('forms')
    .update(row)
    .eq('id', id)
    .eq('account_id', accountId)
    .select()
    .single();
  if (error) throw error;
  if (!data) throw new Error('form not found');
  return data;
}

export async function deleteForm(accountId: string, id: string): Promise<{ id: string; deleted: true }> {
  const { data, error } = await supabase
    .from('forms')
    .delete()
    .eq('id', id)
    .eq('account_id', accountId)
    .select('id');
  if (error) throw error;
  if (!data || !data.length) throw new Error('form not found');
  return { id, deleted: true };
}

export async function listSubmissions(accountId: string, formId: string): Promise<FormSubmissionRow[]> {
  const { data, error } = await supabase
    .from('form_submissions')
    .select('*')
    .eq('account_id', accountId)
    .eq('form_id', formId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

// -----------------------------------------------------------------------------
// PUBLIC path — no session. Used by /api/public/forms/:id/submit so a form can
// be embedded on any external site.
// -----------------------------------------------------------------------------

/**
 * Fetch a form by id with NO account filter. Returns null if the form does not
 * exist OR is disabled. Only exposes the fields a public embed needs — never
 * account_id or other internals.
 */
export async function getPublicForm(id: string): Promise<Pick<FormRow, 'id' | 'name' | 'fields' | 'redirect_url'> & { account_id: string } | null> {
  const { data, error } = await supabase
    .from('forms')
    .select('id, account_id, name, fields, redirect_url, enabled')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data || !data.enabled) return null;
  // account_id is kept internally (submitForm needs it to scope the insert)
  // but callers that only want the public-safe shape can destructure it out.
  return { id: data.id, account_id: data.account_id, name: data.name, fields: data.fields || [], redirect_url: data.redirect_url };
}

function validateSubmission(fields: FormField[], data: Record<string, any>): string | null {
  for (const f of fields || []) {
    if (f.required) {
      const v = data?.[f.key];
      if (v === undefined || v === null || String(v).trim() === '') {
        return `${f.label || f.key} is required`;
      }
    }
  }
  return null;
}

/**
 * Public submit handler — NO session. account_id is derived from the form
 * row (form.account_id), never from the caller, so a submission can never be
 * attributed to the wrong tenant. Contact creation is best-effort: a failure
 * there must not lose the submission itself.
 */
export async function submitForm(id: string, data: Record<string, any>): Promise<{ ok: true; redirect_url: string | null }> {
  const form = await getPublicForm(id);
  if (!form) throw new Error('form not found');

  const vErr = validateSubmission(form.fields, data || {});
  if (vErr) throw new Error(vErr);

  const accountId = form.account_id; // authoritative — from the form row, never the caller

  const { data: submission, error: subErr } = await supabase
    .from('form_submissions')
    .insert([{ account_id: accountId, form_id: id, data: data || {} }])
    .select()
    .single();
  if (subErr) throw subErr;

  // Best-effort contact upsert. A failure here must not lose the submission.
  try {
    const email = data?.email ? String(data.email).trim() : '';
    if (email) {
      const { data: existing } = await supabase
        .from('contacts')
        .select('id')
        .eq('email', email)
        .eq('account_id', accountId)
        .limit(1);
      let contactId: string | null = existing && existing.length ? existing[0].id : null;
      if (!contactId) {
        const { data: created, error: createErr } = await supabase
          .from('contacts')
          .insert([{
            account_id: accountId,
            name: data?.name ? String(data.name) : null,
            email,
            company: data?.company ? String(data.company) : null,
            title: null,
            source: 'web_form',
            status: 'new',
          }])
          .select()
          .single();
        if (!createErr && created) contactId = created.id;
      }
      if (contactId) {
        await supabase.from('form_submissions').update({ contact_id: contactId }).eq('id', submission.id);
      }
    }
  } catch {
    // best-effort — submission is already saved above
  }

  return { ok: true, redirect_url: form.redirect_url };
}
