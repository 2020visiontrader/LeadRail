// ============================================================
// Phase D #19 — data-driven automations engine (trigger / filter / action).
// Supersedes the hardcoded hermes trigger conditions with a product surface:
// an automation fires on a named trigger, evaluates a JSON filter against the
// event context, and runs an action. Also exports the condition evaluator that
// the sequence `branch` step reuses (Phase C left branch as a no-op).
// ============================================================
import { supabase } from '@/lib/db';

export type Condition = { field: string; op: string; value?: any };
export type Filter = { match?: 'all' | 'any'; conditions?: Condition[] };
export type ActionSpec = { type: string; config?: Record<string, any> };

// Dot-path lookup into the event context, e.g. "contact.score" or "outcome".
function pick(ctx: any, path: string): any {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), ctx);
}

function testCondition(ctx: any, c: Condition): boolean {
  const actual = pick(ctx, c.field);
  const expected = c.value;
  switch (c.op) {
    case 'eq': return actual === expected;
    case 'neq': return actual !== expected;
    case 'gt': return Number(actual) > Number(expected);
    case 'gte': return Number(actual) >= Number(expected);
    case 'lt': return Number(actual) < Number(expected);
    case 'lte': return Number(actual) <= Number(expected);
    case 'contains': return String(actual ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase());
    case 'in': return Array.isArray(expected) && expected.includes(actual);
    case 'exists': return actual !== undefined && actual !== null && actual !== '';
    case 'not_exists': return actual === undefined || actual === null || actual === '';
    default: return false;
  }
}

/** Evaluate a filter against a context. Empty filter (no conditions) = match. */
export function evaluateConditions(filter: Filter | null | undefined, ctx: any): boolean {
  const conds = filter?.conditions;
  if (!conds || !conds.length) return true;
  const match = filter?.match ?? 'all';
  return match === 'any' ? conds.some((c) => testCondition(ctx, c)) : conds.every((c) => testCondition(ctx, c));
}

// -----------------------------------------------------------------------------
// Actions. `contactId` in ctx is the subject where applicable.
// -----------------------------------------------------------------------------
async function runAction(accountId: string, action: ActionSpec, ctx: any): Promise<string> {
  const cfg = action.config || {};
  const contactId: string | undefined = ctx?.contact?.id || ctx?.contactId;
  switch (action.type) {
    case 'enroll_sequence': {
      if (!cfg.sequenceId || !contactId) return 'skipped: missing sequenceId/contact';
      const { enrollContacts } = await import('@/lib/sequences'); // dynamic: break cycle
      await enrollContacts(cfg.sequenceId, accountId, [contactId]);
      return `enrolled in ${cfg.sequenceId}`;
    }
    case 'add_tag': {
      if (!cfg.tag || !contactId) return 'skipped: missing tag/contact';
      const { addTagToContact } = await import('@/lib/tags');
      await addTagToContact(accountId, contactId, { name: cfg.tag, color: cfg.color });
      return `tagged ${cfg.tag}`;
    }
    case 'update_score': {
      if (!contactId) return 'skipped: missing contact';
      await supabase.rpc('increment_contact_score', { contact_id: contactId, increment: Number(cfg.amount) || 0 });
      return `score ${cfg.amount >= 0 ? '+' : ''}${cfg.amount}`;
    }
    case 'set_status': {
      if (!contactId || !cfg.status) return 'skipped: missing contact/status';
      await supabase.from('contacts').update({ status: cfg.status }).eq('id', contactId).eq('account_id', accountId);
      return `status → ${cfg.status}`;
    }
    case 'create_task': {
      if (!contactId) return 'skipped: missing contact';
      const { createActivity } = await import('@/lib/crm');
      await createActivity({
        account_id: accountId,
        brand_id: ctx?.contact?.brand_id || null,
        type: 'task',
        subject: cfg.title || 'Automation follow-up',
        body: cfg.body || null,
        status: 'open',
        due_at: new Date().toISOString(),
        contact_id: contactId,
      }).catch(() => {});
      return 'task created';
    }
    case 'suppress': {
      const email = ctx?.contact?.email || cfg.email;
      if (!email) return 'skipped: missing email';
      const { addSuppression } = await import('@/lib/suppressions');
      await addSuppression({ accountId, email, reason: cfg.reason || 'automation', source: 'automation' });
      return `suppressed ${email}`;
    }
    case 'send_webhook': {
      // Fan the event out to the account's registered outbound webhooks.
      const { emitEvent } = await import('@/lib/webhooks-out');
      await emitEvent(accountId, cfg.event || `automation.${ctx?.trigger || 'fired'}`, { ...ctx });
      return 'webhook emitted';
    }
    default:
      return `skipped: unknown action ${action.type}`;
  }
}

/**
 * Fire all active automations for `accountId` whose trigger.type matches, whose
 * brand (if set) matches, and whose filter passes against `ctx`. Best-effort:
 * a single automation failure is logged and never throws to the caller.
 */
export async function evaluateAutomations(accountId: string, triggerType: string, ctx: any): Promise<void> {
  if (!accountId) return;
  let rows: any[] = [];
  try {
    const { data } = await supabase
      .from('automations')
      .select('*')
      .eq('account_id', accountId)
      .eq('is_active', true);
    rows = data || [];
  } catch {
    return; // table not present yet (012 unapplied) — no-op
  }
  const brandId = ctx?.contact?.brand_id || ctx?.brandId;
  for (const a of rows) {
    if ((a.trigger?.type || a.trigger) !== triggerType) continue;
    if (a.brand_id && brandId && a.brand_id !== brandId) continue;
    const enriched = { ...ctx, trigger: triggerType };
    const matched = evaluateConditions(a.filter, enriched);
    let outcome = 'skipped';
    let detail = 'filter not matched';
    if (matched) {
      try {
        detail = await runAction(accountId, a.action || {}, enriched);
        outcome = 'ran';
      } catch (e: any) {
        outcome = 'error';
        detail = String(e?.message || e).slice(0, 300);
      }
      await supabase.from('automations')
        .update({ run_count: (a.run_count || 0) + 1, last_run_at: new Date().toISOString() })
        .eq('id', a.id).then(() => {}, () => {});
    }
    await supabase.from('automation_runs').insert([{
      account_id: accountId, automation_id: a.id, trigger_type: triggerType,
      context: enriched, matched, outcome, detail,
    }]).then(() => {}, () => {});
  }
}

// -----------------------------------------------------------------------------
// CRUD — account-scoped.
// -----------------------------------------------------------------------------
export async function listAutomations(accountId: string) {
  const { data, error } = await supabase
    .from('automations').select('*').eq('account_id', accountId).order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function getAutomation(id: string, accountId: string) {
  const { data, error } = await supabase
    .from('automations').select('*').eq('id', id).eq('account_id', accountId).single();
  if (error) throw error;
  return data;
}

export async function createAutomation(accountId: string, input: {
  name: string; trigger: any; filter?: any; action: any; brand_id?: string | null; is_active?: boolean;
}) {
  const { data, error } = await supabase.from('automations').insert([{
    account_id: accountId,
    name: input.name,
    trigger: input.trigger ?? {},
    filter: input.filter ?? {},
    action: input.action ?? {},
    brand_id: input.brand_id ?? null,
    is_active: input.is_active ?? true,
  }]).select().single();
  if (error) throw error;
  return data;
}

export async function updateAutomation(id: string, accountId: string, updates: Record<string, any>) {
  const allowed = ['name', 'trigger', 'filter', 'action', 'brand_id', 'is_active'];
  const patch: Record<string, any> = { updated_at: new Date().toISOString() };
  for (const k of allowed) if (k in updates) patch[k] = updates[k];
  const { data, error } = await supabase
    .from('automations').update(patch).eq('id', id).eq('account_id', accountId).select();
  if (error) throw error;
  if (!data || !data.length) throw new Error('not found');
  return data[0];
}

export async function deleteAutomation(id: string, accountId: string) {
  const { data, error } = await supabase
    .from('automations').delete().eq('id', id).eq('account_id', accountId).select('id');
  if (error) throw error;
  if (!data || !data.length) throw new Error('not found');
  return { id, deleted: true };
}
