import { supabase } from '@/lib/db';

// ============================================================
// Unified timeline (gap #9). Append-only feed for any entity. Write from the
// key mutation points (notes, activities, status changes); reads merge the
// table with email_events so opens/clicks appear inline without double-writes
// on the hot send path.
// ============================================================

export interface TimelineRow {
  account_id: string;
  entity_type: 'contact' | 'company' | 'deal';
  entity_id: string;
  contact_id?: string | null;
  type: string;
  title?: string | null;
  body?: string | null;
  meta?: Record<string, any>;
  actor_email?: string | null;
}

/** Best-effort: a timeline write must never fail the caller's real operation. */
export async function recordTimeline(row: TimelineRow): Promise<void> {
  try {
    await supabase.from('timeline_activities').insert([{
      account_id: row.account_id,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      contact_id: row.contact_id ?? (row.entity_type === 'contact' ? row.entity_id : null),
      type: row.type,
      title: row.title ?? null,
      body: row.body ?? null,
      meta: row.meta ?? {},
      actor_email: row.actor_email ?? null,
    }]);
  } catch (e: any) {
    console.error('[timeline]', e?.message || e);
  }
}

/** Merged, reverse-chron feed for a single contact (timeline + email events). */
export async function getContactTimeline(accountId: string, contactId: string, limit = 100) {
  const [tl, events] = await Promise.all([
    supabase
      .from('timeline_activities')
      .select('*')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false })
      .limit(limit),
    supabase
      .from('email_events')
      .select('id, type, url, created_at')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false })
      .limit(limit),
  ]);

  const rows = [
    ...(tl.data || []).map((r: any) => ({
      id: r.id,
      kind: r.type,
      title: r.title,
      body: r.body,
      meta: r.meta,
      at: r.created_at,
    })),
    ...(events.data || []).map((e: any) => ({
      id: e.id,
      kind: `email_${e.type}`,
      title: e.type === 'click' ? 'Clicked a link' : 'Opened email',
      body: e.url || null,
      meta: {},
      at: e.created_at,
    })),
  ];
  rows.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return rows.slice(0, limit);
}
