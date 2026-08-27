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

// Tables exported for "download my data". Each is filtered by account_id
// (accounts itself is filtered by id). Sensitive columns are scrubbed below.
//
// This list is a hand-maintained allow-list, and hand-maintained allow-lists
// rot silently: every account-scoped table added since this file was written
// (68 of them, at last audit) was invisibly omitted from the export until
// someone went and diffed it against the schema. There is no way to make an
// allow-list self-updating, so instead it is made self-POLICING: every
// account-scoped table in migrations/*.sql must appear in EXPORT_TABLES or in
// EXPORT_EXCLUDED below, and tests/account-export.test.ts derives that table
// list straight from the migrations on disk and fails the moment the two
// diverge. Adding a table without touching one of these two now fails a test
// instead of shipping an invisible compliance gap.
export const EXPORT_TABLES = [
  'accounts', 'account_members', 'brands', 'contacts', 'companies', 'deals',
  'message_templates', 'sequences', 'sequence_enrollments', 'inbox_messages',
  'conversations', 'conversation_messages', 'apollo_searches', 'content_calendar',
  'campaign_assets', 'integration_connections', 'referral_codes', 'referrals',
  'referral_rewards', 'privacy_events',
  // Agent/assistant memory and history — this is the entire assistant chat
  // history omitted by the original allow-list.
  'agent_conversations', 'agent_memory', 'memory_edges', 'memory_subjects',
  'agent_plans', 'approvals', 'approval_grants', 'assistant_attachments',
  'attachments',
  // CRM / venture content and workflow.
  'notes', 'activities', 'timeline_activities', 'tags', 'segments', 'personas',
  'skills', 'notifications', 'audit_log', 'cases', 'support_tickets', 'forms',
  'form_submissions', 'journeys', 'automations', 'credit_transactions',
  'entitlements', 'account_budgets', 'icp_profiles', 'content_items',
  'content_pillars', 'research_findings', 'knowledge_articles', 'partners',
  'territories', 'suppressions', 'events', 'contact_aliases',
  'contact_company_roles', 'contact_merges', 'campaign_members',
  'pipeline_stages', 'enrichment_jobs', 'webhook_deliveries', 'scheduled_tasks',
  'brand_goals', 'brand_intakes', 'brand_strategies', 'ad_campaigns',
  'video_analyses', 'character_refs', 'platform_specs', 'account_skills',
  'ai_routing', 'social_automations',
];

// Account-scoped tables deliberately left out of the export, and why. A bare
// exclusion with no reason is exactly what let the omissions above go
// unnoticed for so long, so every entry here must justify itself.
export const EXPORT_EXCLUDED: Record<string, string> = {
  // Credential / secret stores: the row's entire purpose is to hold auth
  // material for a third-party integration. Excluding the table beats trying
  // to scrub every column in it down to something meaningful to export.
  mcp_api_keys: 'credential store — hashed MCP API keys, not user content',
  mcp_clients: 'credential store — encrypted OAuth client secrets and tokens for external MCP servers',
  mcp_oauth_states: 'transient OAuth handshake state, not user content or a credential worth retaining',
  ai_providers: 'credential store — encrypted third-party AI provider API keys',
  email_accounts: 'credential store — mailbox auth secrets for connected inboxes',
  webhook_endpoints: 'credential store — webhook signing secrets',
  // Operational/system noise: internal telemetry and run logs the account
  // holder did not author and would not recognize as "their data".
  app_logs: 'internal application/system log, not user-authored content',
  ai_usage: 'internal usage/billing telemetry, not user-authored content',
  automation_runs: 'internal automation execution log, not user-authored content',
  content_pipeline_runs: 'internal content pipeline execution log, not user-authored content',
  social_automation_events: 'internal social automation event log, not user-authored content',
  email_events: 'internal email delivery/engagement event log, not user-authored content',
  skill_repairs: 'internal agent self-repair diagnostic log, not user-authored content',
};

// Secret-shaped column names are scrubbed by pattern, not by an exact-match
// list. An exact list (the previous implementation) has the same rot problem
// as a hand-maintained table allow-list: integration_connections gained a
// secret_encrypted column and it was never added, so encrypted OAuth/API
// credentials were shipped straight into a user-downloadable export.
//
// A pattern is over-inclusive by nature (max_output_tokens, tokens_in/out,
// token_estimate, oauth_token_url all contain "token" but hold nothing
// secret), so SCRUB_ALLOW documents every known false positive explicitly —
// same self-policing shape as EXPORT_EXCLUDED above. New secret-shaped columns
// are redacted automatically the moment they appear in a migration; only
// deliberately-safe columns need an entry here, and every one must be
// justified by name matching a real column, not guessed in advance.
const SECRET_COLUMN_PATTERN = /secret|token|api_key|password|credential|key_hash|private|refresh/i;

export const SCRUB_ALLOW: ReadonlySet<string> = new Set([
  'token_estimate',      // agent_conversations — a token count, not a secret
  'tokens_in',            // ai_usage — a token count, not a secret
  'tokens_out',           // ai_usage — a token count, not a secret
  'max_output_tokens',    // ai_models / model config — a limit, not a secret
  'oauth_token_url',      // mcp_clients — a public OAuth endpoint URL, not a secret
]);

export function isSecretColumn(key: string): boolean {
  return SECRET_COLUMN_PATTERN.test(key) && !SCRUB_ALLOW.has(key);
}

export function scrub(rows: any[]): any[] {
  return rows.map((r) => {
    const c: Record<string, any> = { ...r };
    for (const k of Object.keys(c)) {
      if (isSecretColumn(k)) c[k] = '[redacted]';
    }
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
