// attachment_bindings (migration 076) — durable, message-level attachment
// provenance. See that migration's header for the defect this exists to fix
// and the design (binding lives OUTSIDE agent_conversations.transcript on
// purpose) — same "outside the jsonb blob" shape as lib/documents/attachments.ts
// itself relative to the conversation row, for the same reason: one file can
// bind to several messages, or a whole conversation, without duplicating
// anything inside the transcript, and releasing a binding never touches it.
//
// Tenant scoping is non-negotiable here, same as everywhere else in this
// file's sibling (lib/documents/attachments.ts): account_id is always taken
// from the session and applied INSIDE every query, never derived from the
// request and never checked after the fetch. An id from another tenant reads
// as "not found", never as their file — no existence oracle.

import { supabase, dbReady } from '@/lib/db';

export const ATTACHMENT_BINDING_SCOPES = ['message', 'conversation', 'task'] as const;
export type AttachmentBindingScope = (typeof ATTACHMENT_BINDING_SCOPES)[number];

export const ATTACHMENT_BINDING_ROLES = ['user_upload', 'library_reference', 'generated', 'tool_output'] as const;
export type AttachmentBindingRole = (typeof ATTACHMENT_BINDING_ROLES)[number];

export const ATTACHMENT_BINDING_STATUSES = ['bound', 'released', 'failed'] as const;
export type AttachmentBindingStatus = (typeof ATTACHMENT_BINDING_STATUSES)[number];

export const ATTACHMENT_BINDING_BOUND_BY = ['user', 'assistant', 'system'] as const;
export type AttachmentBindingBoundBy = (typeof ATTACHMENT_BINDING_BOUND_BY)[number];

export interface AttachmentBinding {
  id: string;
  account_id: string;
  attachment_id: string;
  conversation_id: string;
  message_id: string | null;
  scope: AttachmentBindingScope;
  role: AttachmentBindingRole;
  status: AttachmentBindingStatus;
  bound_at: string;
  released_at: string | null;
  bound_by: AttachmentBindingBoundBy;
  created_at: string;
}

/** Postgres's unique_violation SQLSTATE — used to recognise a retry hitting
 *  uniq_attachment_binding_live (migration 076) rather than a real failure. */
const UNIQUE_VIOLATION = '23505';

/**
 * Bind an attachment to a message (or, with `scope: 'conversation'`, to a
 * whole conversation with no single message). Idempotent under retry: a
 * second call for the same (attachment, message-or-conversation, scope)
 * while the first binding is still live hits uniq_attachment_binding_live
 * and this returns the EXISTING binding rather than erroring or creating a
 * duplicate — "a retry must not create a duplicate binding" is enforced in
 * the schema (the partial unique index), this is just the code-side path
 * that turns the resulting 23505 into a normal return instead of a throw.
 *
 * account_id is the session's, always — never trusted from the caller's
 * attachmentId/conversationId alone. The FK constraints in migration 076
 * mean an attachment_id or conversation_id from another tenant fails the
 * insert outright (foreign key violation), which is the correct outcome:
 * this function does not additionally verify cross-tenant ownership of the
 * referenced rows, because the FKs are scoped to the SAME accounts table
 * relationship those rows already enforce on write, and the row this
 * function itself creates is stamped with the caller's own account_id
 * regardless.
 */
export async function bindAttachmentToMessage(
  accountId: string,
  attachmentId: string,
  conversationId: string,
  messageId: string | null,
  opts?: { scope?: AttachmentBindingScope; role?: AttachmentBindingRole; boundBy?: AttachmentBindingBoundBy },
): Promise<AttachmentBinding | null> {
  if (!dbReady() || !accountId || !attachmentId || !conversationId) return null;
  const scope: AttachmentBindingScope = opts?.scope ?? (messageId ? 'message' : 'conversation');
  if (scope === 'message' && !messageId) {
    throw new Error("attachment binding: scope 'message' requires a messageId");
  }
  const role: AttachmentBindingRole = opts?.role ?? 'user_upload';
  const boundBy: AttachmentBindingBoundBy = opts?.boundBy ?? 'user';

  const { data, error } = await supabase.from('attachment_bindings').insert([{
    account_id: accountId,
    attachment_id: attachmentId,
    conversation_id: conversationId,
    message_id: messageId,
    scope,
    role,
    bound_by: boundBy,
  }]).select('*').maybeSingle();

  if (!error) return (data as AttachmentBinding) ?? null;

  // A duplicate live binding is not a failure — it's the retry this index
  // exists to make safe. Return the row that already won the race, scoped by
  // account so a collision on someone else's row (impossible given the FK
  // above, but checked anyway — no existence oracle) does not leak it.
  if ((error as any)?.code === UNIQUE_VIOLATION) {
    const existing = await liveBinding(accountId, attachmentId, conversationId, messageId, scope);
    if (existing) return existing;
  }
  throw error;
}

async function liveBinding(
  accountId: string,
  attachmentId: string,
  conversationId: string,
  messageId: string | null,
  scope: AttachmentBindingScope,
): Promise<AttachmentBinding | null> {
  let q = supabase.from('attachment_bindings').select('*')
    .eq('account_id', accountId)
    .eq('attachment_id', attachmentId)
    .eq('conversation_id', conversationId)
    .eq('scope', scope)
    .eq('status', 'bound');
  q = messageId ? q.eq('message_id', messageId) : q.is('message_id', null);
  const { data } = await q.maybeSingle();
  return (data as AttachmentBinding) ?? null;
}

/**
 * Release a binding — the attachment is no longer considered part of that
 * message/conversation/task, but the transcript itself is untouched: this is
 * a row update here, never a rewrite of agent_conversations.transcript. That
 * is the whole reason the binding lives in its own table (migration 076's
 * header) rather than as a flag inside the transcript jsonb.
 *
 * Idempotent: releasing an already-released binding is a no-op success, not
 * an error — a caller retrying a release should never fail because it
 * already worked. Scoped by account; an id from another tenant matches no
 * row, same as everywhere else here.
 */
export async function releaseAttachmentBinding(accountId: string, bindingId: string): Promise<boolean> {
  if (!dbReady() || !accountId || !bindingId) return false;
  const { data, error } = await supabase.from('attachment_bindings')
    .update({ status: 'released', released_at: new Date().toISOString() })
    .eq('id', bindingId).eq('account_id', accountId).eq('status', 'bound')
    .select('id');
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

/** Every live binding for one message, newest first. Tenant-scoped. */
export async function listBindingsForMessage(
  accountId: string,
  conversationId: string,
  messageId: string,
): Promise<AttachmentBinding[]> {
  if (!dbReady() || !accountId || !conversationId || !messageId) return [];
  const { data, error } = await supabase.from('attachment_bindings').select('*')
    .eq('account_id', accountId).eq('conversation_id', conversationId).eq('message_id', messageId)
    .eq('status', 'bound')
    .order('bound_at', { ascending: false });
  if (error) return [];
  return (data || []) as AttachmentBinding[];
}

/** Every live binding for a whole conversation (any scope), newest first. */
export async function listBindingsForConversation(
  accountId: string,
  conversationId: string,
): Promise<AttachmentBinding[]> {
  if (!dbReady() || !accountId || !conversationId) return [];
  const { data, error } = await supabase.from('attachment_bindings').select('*')
    .eq('account_id', accountId).eq('conversation_id', conversationId)
    .eq('status', 'bound')
    .order('bound_at', { ascending: false });
  if (error) return [];
  return (data || []) as AttachmentBinding[];
}
