// CRM automation capabilities — the general automations engine (migration 012).
//
// This is a DIFFERENT engine from social-automations.ts. That one watches
// comments and DMs on connected social accounts; this one fires on CRM events
// ("a lead was created", "a lead replied") and acts on the contact — enrol them
// in a sequence, tag them, move their score, set status, raise a task, suppress
// them, or fan the event out to a registered webhook.
//
// It has been shipped and reachable over /api/automations since Phase D, and
// the assistant could not see it at all: asked "can you set up an automation?",
// the only thing in the catalog was createSocialAutomation, so a CRM automation
// request either got the social rule by mistake or a flat no.
//
// SAFETY — deliberately identical to social-automations.ts, because the risk is
// identical. An automation is a STANDING RULE: approving one authorises an
// unbounded stream of future actions with no human in the loop, and one of
// those actions (enrol_sequence) sends real email to real people. So:
//
//   1. A rule is ALWAYS created switched OFF. createAutomation hard-codes
//      is_active:false and takes no `active` argument, so no single approval can
//      produce a live automation.
//   2. Switching it on is its own capability with its own approval wording.
//   3. Switching it off is not sensitive — stopping a rule is always safe, the
//      same reasoning that leaves pauseCampaign ungated.

import { z } from 'zod';
import { listAutomations, createAutomation, updateAutomation, deleteAutomation } from '@/lib/automations';
import { obj, S, type Capability, rowsOf, present, clip, plural, samples, digestLine } from './types';

// ONLY the triggers something actually emits. evaluateAutomations is called
// from exactly two places in the codebase; a rule on any other trigger string
// would be stored, look correct in the UI, and never once fire. Enumerating
// them here means the model cannot invent one — the same failure class as a
// guessed tool name, but silent instead of loud.
const TRIGGERS = ['contact.created', 'email.replied'] as const;

// Mirrors the switch in runAction(). An unknown action type is stored happily
// and then skipped at run time with "unknown action", so it is bounded here.
const ACTIONS = [
  'enroll_sequence', 'add_tag', 'update_score', 'set_status',
  'create_task', 'suppress', 'send_webhook',
] as const;

const OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'in', 'exists', 'not_exists'] as const;

const conditionSchema = z.object({
  field: z.string().min(1),
  op: z.enum(OPS),
  value: z.any().optional(),
});

/** Plain-language rendering of a rule, for approval cards and digests. A
 *  reviewer cannot judge `{"type":"add_tag","config":{"tag":"hot"}}`; they can
 *  judge "tag them 'hot'". */
function describeAction(action: string, config: Record<string, any> = {}): string {
  switch (action) {
    case 'enroll_sequence': return `enrol them in sequence ${config.sequenceId ?? '(unspecified)'} — this sends them real email`;
    case 'add_tag': return `tag them "${config.tag ?? '(unspecified)'}"`;
    case 'update_score': return `change their score by ${config.amount ?? 0}`;
    case 'set_status': return `set their status to "${config.status ?? '(unspecified)'}"`;
    case 'create_task': return `raise a task: "${config.title || 'Automation follow-up'}"`;
    case 'suppress': return 'add them to the suppression list so nothing else is sent to them';
    case 'send_webhook': return `send a webhook (${config.event || 'automation event'}) to the account's registered endpoints`;
    default: return action;
  }
}

function describeConditions(filter?: { match?: string; conditions?: { field: string; op: string; value?: any }[] }): string {
  const conds = filter?.conditions;
  if (!conds?.length) return 'every time';
  const joined = conds.map((c) => `${c.field} ${c.op} ${JSON.stringify(c.value ?? '')}`).join(filter?.match === 'any' ? ' OR ' : ' AND ');
  return `only when ${joined}`;
}

export const CRM_AUTOMATION_CAPABILITIES: Capability[] = [
  {
    name: 'listAutomations',
    domain: 'automations',
    title: 'List CRM automations',
    description: 'List this account\'s CRM automations — the standing rules that fire when a lead is created or replies. Shows each rule\'s name, trigger, action, whether it is switched on, and how many times it has run. Call before switching one on or off, to get its id.',
    gate: 'read',
    inputSchema: obj({}),
    zod: z.object({}),
    run: (accountId) => listAutomations(accountId),
    digest: (_a, result) => {
      const rows = rowsOf(result);
      if (!rows) return '';
      if (!rows.length) return 'No CRM automations exist yet.';
      const active = rows.filter((r: any) => r.is_active).length;
      return digestLine(
        `${plural(rows.length, 'CRM automation')}, ${active} switched on.`,
        `Rules: ${samples(rows, ['name'], 5).join(', ')}`,
      );
    },
  },
  {
    name: 'createAutomation',
    domain: 'automations',
    title: 'Create a CRM automation',
    description:
      `Create a standing rule that runs by itself when a CRM event happens. Triggers: ${TRIGGERS.join(', ')} — those are the only events that exist, so never invent another. Actions: ${ACTIONS.join(', ')}. An optional filter narrows it (e.g. only leads whose score is above 50). The rule is created switched OFF and does nothing until it is separately turned on with enableAutomation.`,
    gate: 'standing_rule',
    inputSchema: obj({
      name: S.string,
      trigger: S.string,
      action: S.string,
      config: { type: 'object' },
      match: S.string,
      conditions: { type: 'array', items: { type: 'object' } },
      brandId: S.string,
    }, ['name', 'trigger', 'action']),
    zod: z.object({
      name: z.string().min(1).max(200),
      trigger: z.enum(TRIGGERS),
      action: z.enum(ACTIONS),
      config: z.record(z.string(), z.any()).optional(),
      match: z.enum(['all', 'any']).optional(),
      conditions: z.array(conditionSchema).optional(),
      brandId: z.string().optional(),
    }).refine((a) => a.action !== 'enroll_sequence' || Boolean(a.config?.sequenceId), {
      message: 'A rule that enrols people in a sequence needs config.sequenceId.',
    }).refine((a) => a.action !== 'add_tag' || Boolean(a.config?.tag), {
      message: 'A rule that tags people needs config.tag.',
    }).refine((a) => a.action !== 'set_status' || Boolean(a.config?.status), {
      message: 'A rule that sets status needs config.status.',
    }),
    run: (accountId, a) => createAutomation(accountId, {
      name: a.name,
      brand_id: a.brandId ?? null,
      trigger: { type: a.trigger },
      filter: { match: a.match ?? 'all', conditions: a.conditions ?? [] },
      action: { type: a.action, config: a.config ?? {} },
      // NEVER from an argument — see the header. Creating a rule and arming it
      // are two separate approvals.
      is_active: false,
    } as any),
    summarize: (a) => `Create a CRM automation (switched OFF) called "${a.name}": when ${a.trigger} fires, ${describeConditions({ match: a.match, conditions: a.conditions })}, ${describeAction(a.action, a.config)}. It does nothing until it is separately switched on.`,
    // Read off the INSERTED ROW. createAutomation (lib/automations.ts) applies
    // its own `is_active: input.is_active ?? true` default, so the armed state
    // is a property of the row and not of the arguments this capability sent —
    // and it is the difference between a rule that does nothing and one that
    // starts enrolling real people in a sequence.
    //
    // describeAction is reused so the stored action reads the same way in the
    // digest as it does on the approval card the user already saw.
    digest: (_a, result) => {
      const r: any = result;
      if (!r || typeof r !== 'object' || Array.isArray(r) || !present(r, 'id')) return '';
      const name = present(r, 'name') ? ` "${clip(String(r.name), 80)}"` : '';
      const trig = r.trigger && present(r.trigger, 'type') ? String(r.trigger.type) : null;
      const act = r.action && present(r.action, 'type')
        ? describeAction(String(r.action.type), (r.action.config && typeof r.action.config === 'object') ? r.action.config : {})
        : null;
      return digestLine(
        `Stored CRM automation ${clip(String(r.id), 60)}${name}${trig ? `: when ${trig} fires` : ''}${act ? `, ${act}` : ''}.`,
        r.is_active === true
          ? 'The stored row says is_active=true — it fires by itself from now on, including after this turn ends, with no approval per firing.'
          : 'The stored row says is_active=false: it does NOTHING yet, and nothing runs after this turn until enableAutomation is separately approved.',
      );
    },
  },
  {
    name: 'enableAutomation',
    domain: 'automations',
    title: 'Switch on a CRM automation',
    description: 'Switch on an existing CRM automation so it starts acting on its own, with no further approval each time it fires. Only do this when the user clearly asks for it to be turned on. Call listAutomations first for the id.',
    gate: 'standing_rule',
    inputSchema: obj({ automationId: S.string }, ['automationId']),
    zod: z.object({ automationId: z.string().min(1) }),
    run: (accountId, a) => updateAutomation(a.automationId, accountId, { is_active: true }),
    summarize: (a) => `Switch ON automation ${a.automationId}. From then on it acts by itself every time its trigger fires, without asking again.`,
    // updateAutomation throws 'not found' when the patch matches no row, so a
    // result at all means the rule exists. What is still not implied is that it
    // is ON: that is read from `is_active` on the row that came back, never
    // from the fact that an enable was requested.
    digest: (_a, result) => {
      const r: any = result;
      if (!r || typeof r !== 'object' || Array.isArray(r) || typeof r.is_active !== 'boolean') return '';
      const id = present(r, 'id') ? ` ${clip(String(r.id), 60)}` : '';
      const name = present(r, 'name') ? ` "${clip(String(r.name), 80)}"` : '';
      if (r.is_active !== true) {
        return digestLine(`CRM automation${id}${name} came back with is_active=false — it is NOT switched on and will not fire.`);
      }
      const trig = r.trigger && present(r.trigger, 'type') ? String(r.trigger.type) : null;
      const act = r.action && present(r.action, 'type')
        ? describeAction(String(r.action.type), (r.action.config && typeof r.action.config === 'object') ? r.action.config : {})
        : null;
      return digestLine(
        `CRM automation${id}${name} is now SWITCHED ON.`,
        trig ? `Every time ${trig} fires${act ? ` it will ${act}` : ''},` : 'It now fires on its own,',
        'without asking again — and it keeps doing so after this turn ends, until it is switched off with disableAutomation.',
      );
    },
  },
  {
    name: 'disableAutomation',
    domain: 'automations',
    title: 'Switch off a CRM automation',
    description: 'Switch off a CRM automation so it stops acting. The rule is kept and can be switched on again later.',
    // Stopping a rule is always safe — same reasoning that leaves pauseCampaign
    // ungated. If you are tempted to make this sensitive, change that first.
    gate: 'internal_write',
    inputSchema: obj({ automationId: S.string }, ['automationId']),
    zod: z.object({ automationId: z.string().min(1) }),
    run: (accountId, a) => updateAutomation(a.automationId, accountId, { is_active: false }),
  },
  {
    name: 'deleteAutomation',
    domain: 'automations',
    title: 'Delete a CRM automation',
    description: 'Permanently delete a CRM automation. Prefer switching it off unless the user specifically asks to delete it.',
    gate: 'destructive',
    inputSchema: obj({ automationId: S.string }, ['automationId']),
    zod: z.object({ automationId: z.string().min(1) }),
    run: (accountId, a) => deleteAutomation(a.automationId, accountId),
    summarize: (a) => `Permanently delete automation ${a.automationId}. This cannot be undone.`,
    // deleteAutomation (lib/automations.ts) deletes with .select('id') and
    // THROWS 'not found' when the delete matched no row, so a returned
    // `{ id, deleted: true }` is real evidence: exactly one rule existed under
    // this account and no longer does. (The `id` field is the argument echoed
    // back, but the throw is what makes the deletion itself a fact — the id is
    // reported as the target, never as the proof.)
    //
    // What the result does NOT carry is the rule's name, trigger, or whether it
    // was switched on. Deleting a live rule stops a standing behaviour and
    // deleting a dormant one does not; since the return cannot tell those
    // apart, the line says so instead of guessing.
    digest: (_a, result) => {
      const r: any = result;
      if (!r || typeof r !== 'object' || Array.isArray(r) || r.deleted !== true) return '';
      const id = present(r, 'id') ? clip(String(r.id), 60) : null;
      return digestLine(
        `Permanently deleted ${plural(1, 'CRM automation')}${id ? ` (${id})` : ''} — the delete matched a row, since deleteAutomation throws when it matches none.`,
        'The result carries no name, trigger or active flag, so whether this rule had been firing on its own is not known from here.',
      );
    },
  },
];
