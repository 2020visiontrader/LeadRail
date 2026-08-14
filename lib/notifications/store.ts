// Account-scoped in-app notifications (migration 034_notifications.sql).
// Flat feed backing the header bell — no push/email fan-out here.

import { supabase } from '@/lib/db';

export interface NotificationRow {
  id: string;
  account_id: string;
  type: string | null;
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
  created_at: string;
}

export async function createNotification(accountId: string, input: {
  type?: string; title: string; body?: string; link?: string;
}): Promise<NotificationRow> {
  const row = {
    account_id: accountId,
    type: input.type ?? null,
    title: input.title,
    body: input.body ?? null,
    link: input.link ?? null,
  };
  const { data, error } = await supabase.from('notifications').insert([row]).select().single();
  if (error) throw error;
  return data;
}

export async function listNotifications(
  accountId: string,
  opts: { unreadOnly?: boolean; limit?: number } = {},
): Promise<NotificationRow[]> {
  let q = supabase
    .from('notifications')
    .select('*')
    .eq('account_id', accountId);
  if (opts.unreadOnly) q = q.eq('read', false);
  const { data, error } = await q
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 30);
  if (error) throw error;
  return data || [];
}

export async function markRead(accountId: string, id: string): Promise<NotificationRow> {
  const { data, error } = await supabase
    .from('notifications')
    .update({ read: true })
    .eq('id', id)
    .eq('account_id', accountId)
    .select()
    .single();
  if (error) throw error;
  if (!data) throw new Error('notification not found');
  return data;
}

export async function markAllRead(accountId: string): Promise<{ updated: true }> {
  const { error } = await supabase
    .from('notifications')
    .update({ read: true })
    .eq('account_id', accountId)
    .eq('read', false);
  if (error) throw error;
  return { updated: true };
}

export async function unreadCount(accountId: string): Promise<number> {
  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .eq('read', false);
  if (error) throw error;
  return count || 0;
}
