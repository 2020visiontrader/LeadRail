// Account-scoped event recording + aggregation for a lightweight CDP
// (migration 031_events.sql). Postgres-only by design — no ClickHouse/Kafka.
// Aggregation is done with plain count/select queries; at LeadRail's current
// scale this is simple and sufficient. // TODO: if event volume grows large,
// consider a materialized daily-rollup table instead of scanning `events`.

import { supabase } from '@/lib/db';

export interface EventRow {
  id: string;
  account_id: string;
  contact_id: string | null;
  type: string;
  props: Record<string, any>;
  created_at: string;
}

export async function recordEvent(accountId: string, input: {
  type: string; contactId?: string; props?: Record<string, any>;
}): Promise<EventRow> {
  const type = String(input.type || '').trim();
  if (!type) throw new Error('type is required');
  const row = {
    account_id: accountId,
    contact_id: input.contactId ?? null,
    type,
    props: input.props ?? {},
  };
  const { data, error } = await supabase.from('events').insert([row]).select().single();
  if (error) throw error;
  return data;
}

function sinceIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - Math.max(1, days));
  return d.toISOString();
}

/** Count of events per type over the last `days` days, account-scoped. */
export async function getEventCountsByType(
  accountId: string,
  days = 30,
): Promise<{ type: string; count: number }[]> {
  const { data, error } = await supabase
    .from('events')
    .select('type')
    .eq('account_id', accountId)
    .gte('created_at', sinceIso(days));
  if (error) throw error;
  const counts: Record<string, number> = {};
  for (const row of data || []) {
    counts[row.type] = (counts[row.type] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
}

/** Daily event counts over the last `days` days, account-scoped. */
export async function getEventTimeseries(
  accountId: string,
  days = 30,
): Promise<{ date: string; count: number }[]> {
  const { data, error } = await supabase
    .from('events')
    .select('created_at')
    .eq('account_id', accountId)
    .gte('created_at', sinceIso(days));
  if (error) throw error;

  const counts: Record<string, number> = {};
  for (const row of data || []) {
    const date = String(row.created_at).slice(0, 10); // YYYY-MM-DD
    counts[date] = (counts[date] || 0) + 1;
  }

  // Fill every day in the window (including zero-event days) so the UI can
  // render a continuous timeseries instead of a sparse one.
  const out: { date: string; count: number }[] = [];
  const n = Math.max(1, days);
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const date = d.toISOString().slice(0, 10);
    out.push({ date, count: counts[date] || 0 });
  }
  return out;
}

/** High-level totals for the account: contacts, all-time events, events in the last 7 days. */
export async function getTotals(accountId: string): Promise<{
  contacts: number; events: number; events7d: number;
}> {
  const [contactsRes, eventsRes, events7dRes] = await Promise.all([
    supabase.from('contacts').select('id', { count: 'exact', head: true }).eq('account_id', accountId).is('deleted_at', null),
    supabase.from('events').select('id', { count: 'exact', head: true }).eq('account_id', accountId),
    supabase.from('events').select('id', { count: 'exact', head: true }).eq('account_id', accountId).gte('created_at', sinceIso(7)),
  ]);
  if (contactsRes.error) throw contactsRes.error;
  if (eventsRes.error) throw eventsRes.error;
  if (events7dRes.error) throw events7dRes.error;
  return {
    contacts: contactsRes.count || 0,
    events: eventsRes.count || 0,
    events7d: events7dRes.count || 0,
  };
}
