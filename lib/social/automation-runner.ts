// Packet 7.3 — the automation runner.
//
// This is the ONLY place in the whole remediation plan where the platform
// sends a message to a real person with no human in the loop. Every other
// packet could ship a wrong answer; this one can ship a wrong answer AND put
// it in a stranger's inbox on the customer's brand account. Read this file
// like it's the failure being prevented, not the feature being shipped.
//
// social_automations (migration 040) rows are created disabled; enabling is
// a separate approval (lib/capabilities/social-automations.ts). Until this
// file existed, rules never fired — the safe failure mode. This file is what
// makes them fire, and every non-negotiable from
// COPILOT_REMEDIATION_PLAN.md Packet 7.3 is enforced at one specific,
// commented point below:
//
//   1. daily_cap enforced AT SEND TIME, atomically  -> claimSend()
//   2. Disabled rules never fire                     -> the .eq('enabled', true) in loadMatchingRules()
//   3. Suppression respected                          -> executeAction()'s 'reply' case
//   4. Tenant scope never widens                      -> every query below filters account_id IN the query
//   5. Idempotency                                    -> recordEventOnce()
//   6. Fail closed on any gate error                  -> every try/catch below defaults to "do not send"
//   7. Two-step approval untouched                    -> this file only ever READS `enabled`, never writes it
//
// Triggered from the existing inbound webhook (lib/integrations/meta.ts
// handleMetaWebhook), not a polling loop — see the plan. Today that webhook
// only handles `object === 'instagram'` events, so in practice this only
// fires for platform: 'instagram'. Extending to other platforms is future
// work gated on their own inbound webhooks existing, not a gap in this file.
//
// NOTE on 'mention': the migration/capability layer defines 'mention' as a
// valid trigger, but no inbound webhook in this codebase currently extracts
// mention events from the Meta payload. A rule with trigger:'mention' is
// therefore inert today — the same safe failure mode the whole table shipped
// in. Wiring mention extraction is a webhook-parsing change, out of this
// packet's scope, and is called out here so a reviewer doesn't assume it
// already works.

import { supabase } from '@/lib/db';
import { getConnections } from '@/lib/db';
import { isSocialSuppressed } from '@/lib/suppressions';
import { createNotification } from '@/lib/notifications/store';
import { recordExecutedApproval } from '@/lib/approvals/store';

export interface InboundSocialEvent {
  platform: 'instagram' | 'facebook';
  trigger: 'comment_received' | 'dm_received' | 'mention';
  /** The connected account (Page/IG business id) this event arrived on —
   * i.e. integration_connections.external_id / social_automations.external_id.
   * Comes from the webhook's own resolved connection, NEVER from the payload
   * pretending to be someone else's account. */
  externalId: string;
  /** Platform message/comment id — the idempotency key. */
  externalEventId: string;
  authorId: string;
  authorUsername?: string | null;
  text: string;
}

function truncate(s: string | null | undefined, n: number): string {
  const t = String(s || '');
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** {keywords:[], regex?} match, same semantics as describeMatch() in
 * lib/capabilities/social-automations.ts — no keywords AND no regex means
 * "anything" matches, mirroring how that capability describes an empty rule
 * to the user. An invalid user-authored regex never matches (and never
 * throws) rather than taking the rule down. */
function matchesRule(rule: any, text: string): boolean {
  const kw: string[] = Array.isArray(rule?.match?.keywords) ? rule.match.keywords : [];
  const regex: string | undefined = rule?.match?.regex;
  const hay = String(text || '').toLowerCase();
  if (kw.length && kw.some((k) => hay.includes(String(k).toLowerCase()))) return true;
  if (regex) {
    try {
      if (new RegExp(regex, 'i').test(String(text || ''))) return true;
    } catch {
      // Malformed regex authored by the user — never a match, never a crash.
    }
  }
  return !kw.length && !regex;
}

/** Non-negotiable #6 (fail closed) applied to the account-level kill switch.
 * A lookup error is treated as "paused" — never as "not paused". */
async function isAutomationsPaused(accountId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('accounts')
      .select('social_automations_paused')
      .eq('id', accountId)
      .single();
    if (error) throw error;
    return Boolean(data?.social_automations_paused);
  } catch (e) {
    console.error('automation-runner: kill-switch lookup failed, failing closed (treating as paused)', e);
    return true;
  }
}

/** Non-negotiable #6 applied to loop protection: "never auto-reply to an
 * auto-reply" (plan §7.3.5). A lookup error is treated as "author is our own
 * account" — never as "safe to send". The event's own externalId (the
 * connected account it arrived on) is always included even if the
 * connections lookup fails partially, since it is already known-safe. */
async function isOwnIdentity(accountId: string, platform: string, event: InboundSocialEvent): Promise<boolean> {
  const own = new Set<string>([String(event.externalId)]);
  try {
    const conns = await getConnections(accountId);
    for (const c of conns || []) {
      if (c.provider === platform || c.provider === 'meta') own.add(String(c.external_id));
    }
  } catch (e) {
    console.error('automation-runner: connection lookup for loop-guard failed, failing closed', e);
    return true; // cannot verify this ISN'T our own identity — treat as our own, skip
  }
  return own.has(String(event.authorId));
}

/** Non-negotiable #2 + #4: enabled filter and account_id filter both live IN
 * this query, never applied after fetching. */
async function loadMatchingRules(accountId: string, event: InboundSocialEvent) {
  const { data, error } = await supabase
    .from('social_automations')
    .select('*')
    .eq('account_id', accountId)
    .eq('platform', event.platform)
    .eq('external_id', event.externalId)
    .eq('trigger', event.trigger)
    .eq('enabled', true);
  if (error) throw error;
  return (data || []).filter((rule) => matchesRule(rule, event.text));
}

/** Non-negotiable #5: idempotency. UNIQUE (automation_id, external_event_id)
 * (migration 045) means a redelivered webhook hits a unique-violation here
 * and is treated as already-processed. A lookup/insert error that ISN'T a
 * unique-violation fails closed — without this row we cannot prove the event
 * hasn't already been actioned, so we do not proceed. */
async function recordEventOnce(accountId: string, ruleId: string, externalEventId: string): Promise<boolean> {
  const { error } = await supabase
    .from('social_automation_events')
    .insert({ account_id: accountId, automation_id: ruleId, external_event_id: externalEventId });
  if (!error) return true;
  if ((error as any).code === '23505') return false; // duplicate — already processed, not an error
  console.error('automation-runner: idempotency insert failed, failing closed (no send)', error);
  return false;
}

/** Non-negotiable #1: the cap, enforced atomically in the DB via
 * claim_social_automation_send() (migration 045). A SELECT...FOR UPDATE
 * inside that single function call locks the rule row for the duration of
 * the check-and-increment, so two concurrent webhook deliveries (or two
 * overlapping /api/hermes/tick-adjacent triggers) racing on the SAME rule
 * serialize on that lock instead of both reading a stale sends_today and
 * both sending — exactly the class of race lib/sequences.ts
 * processDueEnrollments() fixes with claim_due_enrollments()/FOR UPDATE SKIP
 * LOCKED. An RPC error fails closed: no claim, no send. */
async function claimSend(ruleId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('claim_social_automation_send', { p_automation_id: ruleId });
    if (error) throw error;
    return Boolean(data?.[0]?.claimed);
  } catch (e) {
    console.error('automation-runner: cap claim failed, failing closed (no send)', e);
    return false;
  }
}

const cappedNotifiedToday = new Set<string>(); // per-process, best-effort de-noise only — never a gate

async function notifyCapReached(accountId: string, rule: any): Promise<void> {
  const key = `${rule.id}:${new Date().toISOString().slice(0, 10)}`;
  if (cappedNotifiedToday.has(key)) return;
  cappedNotifiedToday.add(key);
  await createNotification(accountId, {
    type: 'social_automation_capped',
    title: 'An automatic rule hit its daily limit',
    body: `Rule ${rule.id} (${rule.trigger} → ${rule.action}) reached its cap of ${rule.daily_cap} sends today and will resume tomorrow.`,
  }).catch((e) => console.error('automation-runner: cap notification failed (best-effort, non-blocking)', e));
}

interface ActionResult { ok: boolean; detail: string; }

/** Executes the rule's action. Non-negotiable #3 (suppression) is enforced
 * here, immediately before the ONLY branch that reaches a person: 'reply'.
 * hide/notify/tag_lead never message the commenter, so suppression does not
 * apply to them. */
async function executeAction(accountId: string, rule: any, event: InboundSocialEvent): Promise<ActionResult> {
  switch (rule.action) {
    case 'reply': {
      if (!rule.template) return { ok: false, detail: 'rule has no reply template configured' };
      // Fail-closed suppression check — isSocialSuppressed() itself never
      // throws and treats its own read errors as "suppressed" (see
      // lib/suppressions.ts). This is the CASL-critical gate.
      const suppressed = await isSocialSuppressed(accountId, rule.platform, event.authorId);
      if (suppressed) return { ok: false, detail: `recipient ${event.authorId} is suppressed — reply blocked` };
      // Dynamic import breaks the static cycle: meta.ts calls into this
      // module to trigger the runner, and meta-engagement.ts (this call)
      // depends on meta.ts's getMetaCreds — resolving it at call time instead
      // of at module-load time means neither file has to statically import
      // the other's dependent. Same pattern already used for best-effort
      // fan-out in lib/notifications/store.ts.
      const { replyToComment, sendInstagramMessage } = await import('@/lib/social/meta-engagement');
      if (event.trigger === 'dm_received') {
        await sendInstagramMessage(accountId, event.authorId, rule.template, rule.external_id);
      } else {
        await replyToComment(accountId, event.externalEventId, rule.template, 'instagram', rule.external_id);
      }
      return { ok: true, detail: 'replied' };
    }
    case 'hide': {
      if (event.trigger !== 'comment_received') return { ok: false, detail: 'hide only applies to comments' };
      const { hideComment } = await import('@/lib/social/meta-engagement');
      await hideComment(accountId, event.externalEventId, true);
      return { ok: true, detail: 'comment hidden' };
    }
    case 'notify': {
      await createNotification(accountId, {
        type: 'social_automation',
        title: `Automatic rule matched (${rule.trigger})`,
        body: `${event.authorUsername || event.authorId} on ${rule.platform}: ${truncate(event.text, 200)}`,
      });
      return { ok: true, detail: 'notified' };
    }
    case 'tag_lead': {
      // contacts.email is NOT NULL (001_schema.sql) and no inbound social
      // webhook in this codebase ever carries an email — there is no
      // existing social-identity -> contact resolution path to hang a lead
      // off of. Rather than invent placeholder contact data, this raises a
      // notification for a human to tag manually. Documented as a known
      // limitation, not silently faked.
      await createNotification(accountId, {
        type: 'social_automation',
        title: 'Lead-worthy social activity — needs manual tagging',
        body: `${event.authorUsername || event.authorId} on ${rule.platform}: ${truncate(event.text, 200)}`,
      });
      return { ok: true, detail: 'flagged for manual lead tagging (no email available from social identity)' };
    }
    default:
      return { ok: false, detail: `unknown action "${rule.action}"` };
  }
}

async function runOneRule(accountId: string, rule: any, event: InboundSocialEvent): Promise<void> {
  const isNew = await recordEventOnce(accountId, rule.id, event.externalEventId);
  if (!isNew) return; // already processed this rule+event, or the idempotency check itself failed closed

  const claimed = await claimSend(rule.id);
  if (!claimed) {
    await notifyCapReached(accountId, rule);
    return;
  }

  const result = await executeAction(accountId, rule, event).catch((e) => ({ ok: false, detail: String(e?.message || e) }));

  // Non-negotiable audit trail: every claimed-and-attempted action — success
  // or failure — gets a row. This is best-effort at the storage level (the
  // action already happened and cannot be undone if this write fails) but
  // must never be silently swallowed.
  await recordExecutedApproval(accountId, {
    tool: `socialAutomation:${rule.action}`,
    title: `Automatic ${rule.action} on ${rule.platform}`,
    summary: `Rule ${rule.id} (${rule.trigger} → ${rule.action}) ${result.ok ? 'executed' : 'attempted and failed'}: ${result.detail}.`,
    args: {
      ruleId: rule.id,
      platform: rule.platform,
      externalId: rule.external_id,
      trigger: rule.trigger,
      action: rule.action,
      externalEventId: event.externalEventId,
      authorId: event.authorId,
      authorUsername: event.authorUsername ?? null,
    },
    requestedBy: `automation:${rule.id}`,
  }).catch((e) => console.error('automation-runner: audit write failed (send already happened, not retried)', e));
}

/**
 * Entry point — called from the inbound webhook handler for every event that
 * could match a rule. Never throws: a failure anywhere in this pipeline must
 * not take down the webhook response, and every internal gate already fails
 * closed on its own (see the module header). Safe to `await` directly from a
 * webhook handler.
 */
export async function runSocialAutomationsForEvent(accountId: string, event: InboundSocialEvent): Promise<void> {
  if (!accountId || !event?.externalId || !event?.externalEventId || !event?.authorId) return;
  try {
    if (await isAutomationsPaused(accountId)) return;
    if (await isOwnIdentity(accountId, event.platform, event)) return; // loop guard — never reply to ourselves

    let rules: any[];
    try {
      rules = await loadMatchingRules(accountId, event);
    } catch (e) {
      console.error('automation-runner: rule lookup failed, failing closed (no send)', e);
      return;
    }

    for (const rule of rules) {
      await runOneRule(accountId, rule, event);
    }
  } catch (e) {
    console.error('automation-runner: unexpected error, no send attempted', e);
  }
}
