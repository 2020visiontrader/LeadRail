// Data protection: account deletion (soft -> grace -> purge), selective
// deletion, GDPR-style export, and the retention purge job. All account-scoped.
import { supabase } from '@/lib/db';
import { DECK_BUCKET, ATTACHMENT_BUCKET, removePrefix } from '@/lib/storage';

export const DEFAULT_GRACE_DAYS = 30;

export type PrivacyAction =
  | 'account_deletion_requested'
  | 'account_deletion_canceled'
  | 'account_purged'
  | 'data_exported'
  | 'venture_deleted';

/** Append to the durable privacy audit trail. Best-effort; never throws. */
export async function logPrivacyEvent(
  accountId: string | null,
  actorEmail: string | null,
  action: PrivacyAction,
  target?: string,
  detail: Record<string, any> = {},
): Promise<void> {
  await supabase
    .from('privacy_events')
    .insert([{ account_id: accountId, actor_email: actorEmail, action, target: target ?? null, detail }])
    .then(() => {}, () => {});
}

export async function getAccount(accountId: string) {
  const { data } = await supabase
    .from('accounts')
    .select('id, name, plan, created_at, deletion_requested_at, deletion_scheduled_for, deletion_reason')
    .eq('id', accountId)
    .maybeSingle();
  return data;
}

/** Owner requests account deletion: schedule it grace days out; data stays until then. */
export async function requestAccountDeletion(
  accountId: string,
  actorEmail: string,
  graceDays = DEFAULT_GRACE_DAYS,
  reason?: string,
) {
  const now = new Date();
  const scheduled = new Date(now.getTime() + graceDays * 86400_000);
  const { data, error } = await supabase
    .from('accounts')
    .update({
      deletion_requested_at: now.toISOString(),
      deletion_scheduled_for: scheduled.toISOString(),
      deletion_reason: reason || null,
    })
    .eq('id', accountId)
    .select('id, deletion_scheduled_for')
    .single();
  if (error) throw error;
  await logPrivacyEvent(accountId, actorEmail, 'account_deletion_requested', accountId, {
    scheduled_for: scheduled.toISOString(),
    grace_days: graceDays,
  });
  return data;
}

/** Cancel a pending deletion during the grace window. */
export async function cancelAccountDeletion(accountId: string, actorEmail: string) {
  const { data, error } = await supabase
    .from('accounts')
    .update({ deletion_requested_at: null, deletion_scheduled_for: null, deletion_reason: null })
    .eq('id', accountId)
    .select('id')
    .single();
  if (error) throw error;
  await logPrivacyEvent(accountId, actorEmail, 'account_deletion_canceled', accountId);
  return data;
}

/** Soft-delete one venture (brand). Its contacts cascade-hide via their own purge. */
export async function softDeleteVenture(brandId: string, accountId: string, actorEmail: string) {
  const { data, error } = await supabase
    .from('brands')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', brandId)
    .eq('account_id', accountId)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (data) await logPrivacyEvent(accountId, actorEmail, 'venture_deleted', brandId);
  return data;
}

// Tables exported for "download my data". Each is filtered by account_id.
// Sensitive columns (secrets, password hashes) are scrubbed below.
const EXPORT_TABLES = [
  'accounts', 'account_members', 'brands', 'contacts', 'companies', 'deals',
  'message_templates', 'sequences', 'sequence_enrollments', 'inbox_messages',
  'conversations', 'conversation_messages', 'apollo_searches', 'content_calendar',
  'campaign_assets', 'integration_connections', 'referral_codes', 'referrals',
  'referral_rewards', 'privacy_events',
];
const SCRUB = ['password_hash', 'secret', 'secret_ref'];

function scrub(rows: any[]): any[] {
  return rows.map((r) => {
    const c = { ...r };
    for (const k of SCRUB) if (k in c) c[k] = '[redacted]';
    return c;
  });
}

/** Gather the account's data across all tenant tables into one JSON bundle. */
export async function exportAccountData(accountId: string): Promise<Record<string, any>> {
  const bundle: Record<string, any> = {
    _meta: { account_id: accountId, exported_at: new Date().toISOString(), format: 'leadrail-export-v1' },
  };
  for (const table of EXPORT_TABLES) {
    const col = table === 'accounts' ? 'id' : 'account_id';
    const { data, error } = await supabase.from(table).select('*').eq(col, accountId).limit(50000);
    bundle[table] = error ? { error: error.message } : scrub(data || []);
  }
  return bundle;
}

/**
 * Hard-purge accounts whose grace window has elapsed. For each: remove all
 * storage objects under its prefix, record the purge in the surviving audit
 * trail, then DELETE the account row (FK ON DELETE CASCADE erases every
 * tenant-scoped table). Returns the list of purged account ids.
 */
export async function purgeDueAccounts(limit = 25): Promise<string[]> {
  const { data: due } = await supabase
    .from('accounts')
    .select('id')
    .not('deletion_scheduled_for', 'is', null)
    .lte('deletion_scheduled_for', new Date().toISOString())
    .limit(limit);
  const ids = (due || []).map((a: any) => a.id);
  const purged: string[] = [];
  for (const id of ids) {
    const decks = await removePrefix(DECK_BUCKET, id).catch(() => 0);
    const atts = await removePrefix(ATTACHMENT_BUCKET, id).catch(() => 0);
    // Log BEFORE delete; store the id in `target` (text) so the record survives
    // the FK SET NULL that fires when the account row is removed.
    await logPrivacyEvent(id, null, 'account_purged', id, { storage_removed: decks + atts });
    const { error } = await supabase.from('accounts').delete().eq('id', id);
    if (!error) purged.push(id);
  }
  return purged;
}
