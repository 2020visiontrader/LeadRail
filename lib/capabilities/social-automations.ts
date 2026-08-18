// Social automation capabilities (Packet 2.2-S) — managing STANDING RULES.
//
// A row in social_automations (migration 040_social_automations.sql) says "when
// a comment matching X arrives on this connected account, reply with this
// template". That is a different risk class from a single send: approving one
// post authorises one action, while approving a rule authorises an unbounded
// stream of future sends with no further human in the loop. Hence the
// `standing_rule` gate — sensitive like external_send, but its summaries must
// state the ongoing nature and the cap.
//
// TWO SAFETY PROPERTIES, both load-bearing:
//
//   1. A rule is ALWAYS created disabled. createSocialAutomation hard-codes
//      enabled:false and never accepts an `enabled` argument, so no single
//      approval can ever produce a live auto-sender. Switching it on is
//      enableSocialAutomation — its own, separately-worded approval.
//   2. daily_cap is bounded by a DB-level CHECK (<= 200) as well as validated
//      here, so no caller — capability, MCP client, or the future runner — can
//      store a rule permitted to send more than that per day.
//
// SCOPE: this packet manages rule RECORDS only. The execution runner that
// watches webhooks, honours the cap, increments sends_today and resets it on
// date change is Packet 7.3. A rule that exists but never fires is safe; a rule
// that fires without a cap is not. Nothing here sends anything.
//
// Every query below filters by account_id IN the query, never after fetching.

import { z } from 'zod';
import { supabase } from '@/lib/db';
import { LIVE_SOCIALS } from '@/lib/social/providers';
import { obj, S, type Capability } from './types';

const TRIGGERS = ['comment_received', 'dm_received', 'mention'] as const;
const ACTIONS = ['reply', 'hide', 'notify', 'tag_lead'] as const;

// Registry-driven, read at call time — a platform becoming live in
// lib/social/providers.ts needs no edit here.
const livePlatform = z.string().refine((v) => LIVE_SOCIALS.some((p) => p.key === v), {
  message: 'That platform is not connected yet.',
});

/** Load one rule, scoped — used so enable/disable/delete cannot touch another tenant's row. */
async function ownedRule(accountId: string, id: string) {
  const { data, error } = await supabase
    .from('social_automations')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', id)
    .limit(1);
  if (error) throw error;
  if (!data?.[0]) throw new Error('Automation not found.');
  return data[0];
}

const describeMatch = (m: any): string => {
  const kw = Array.isArray(m?.keywords) ? m.keywords : [];
  if (kw.length) return kw.join(', ');
  if (m?.regex) return String(m.regex);
  return 'anything';
};

export const SOCIAL_AUTOMATION_CAPABILITIES: Capability[] = [
  {
    name: 'listSocialAutomations',
    domain: 'social',
    title: 'List automatic social rules',
    description: 'List the automatic rules set up for this account — what each one watches for, what it does, whether it is currently on, and how many times a day it is allowed to act. Use when the user asks what is running automatically, or before switching one on or off so you have the right id.',
    gate: 'read',
    inputSchema: obj({ enabled: { type: 'boolean' }, limit: S.number }),
    zod: z.object({ enabled: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional() }),
    run: async (accountId, a) => {
      let q = supabase
        .from('social_automations')
        .select('*')
        .eq('account_id', accountId);
      if (typeof a?.enabled === 'boolean') q = q.eq('enabled', a.enabled);
      const { data, error } = await q
        .order('created_at', { ascending: false })
        .limit(a?.limit ?? 50);
      if (error) throw error;
      return data;
    },
  },
  {
    name: 'createSocialAutomation',
    domain: 'social',
    title: 'Create an automatic social rule',
    description: 'Create a rule that can later respond automatically to comments, direct messages or mentions on a connected account — for example replying to comments containing certain words. The rule is created switched OFF and does nothing until the user separately turns it on. Always state the daily limit when you describe it.',
    gate: 'standing_rule',
    inputSchema: obj({
      platform: S.string, externalId: S.string, trigger: S.string,
      keywords: { type: 'array', items: S.string }, regex: S.string,
      action: S.string, template: S.string, dailyCap: S.number,
    }, ['platform', 'externalId', 'trigger', 'action']),
    zod: z.object({
      platform: livePlatform,
      externalId: z.string().min(1),
      trigger: z.enum(TRIGGERS),
      keywords: z.array(z.string()).optional(),
      regex: z.string().optional(),
      action: z.enum(ACTIONS),
      template: z.string().optional(),
      // Mirrors the DB CHECK in migration 040 — the DB is the real bound, this
      // is just a faster, clearer failure.
      dailyCap: z.number().int().min(1).max(200).optional(),
    }).refine((a) => a.action !== 'reply' || !!a.template, {
      message: 'A rule that replies needs the reply text.',
    }),
    run: async (accountId, a) => {
      const { data, error } = await supabase
        .from('social_automations')
        .insert({
          account_id: accountId,
          platform: a.platform,
          external_id: a.externalId,
          trigger: a.trigger,
          match: { keywords: a.keywords ?? [], ...(a.regex ? { regex: a.regex } : {}) },
          action: a.action,
          template: a.template ?? null,
          daily_cap: a.dailyCap ?? 25,
          // NEVER derived from an argument. Creating a rule and switching it on
          // are two separate approvals — see the header.
          enabled: false,
        })
        .select();
      if (error) throw error;
      return data?.[0];
    },
    summarize: (a) => `Create an automatic rule (switched OFF) for ${a.platform}: on ${a.trigger} matching "${describeMatch({ keywords: a.keywords, regex: a.regex })}", ${a.action}. It will not do anything until it is separately turned on, and even then at most ${a.dailyCap ?? 25} times a day.`,
  },
  {
    name: 'enableSocialAutomation',
    domain: 'social',
    title: 'Switch on an automatic rule',
    description: 'Switch on an existing automatic rule so it starts acting on its own, without asking again each time. Only do this when the user clearly asks for it to be turned on. Call listSocialAutomations first to get the id.',
    gate: 'standing_rule',
    inputSchema: obj({ id: S.string }, ['id']),
    zod: z.object({ id: z.string().min(1) }),
    run: async (accountId, a) => {
      // Confirms ownership before the update, and the update itself is still
      // scoped by account_id — no read-then-write gap another tenant can use.
      await ownedRule(accountId, a.id);
      const { data, error } = await supabase
        .from('social_automations')
        .update({ enabled: true, updated_at: new Date().toISOString() })
        .eq('account_id', accountId)
        .eq('id', a.id)
        .select();
      if (error) throw error;
      return data?.[0];
    },
    summarize: (a) => `Turn ON an automatic rule (${a.id}). Once on, it sends on its own without asking you again, up to its daily limit. Check listSocialAutomations for exactly what it watches for and its cap.`,
  },
  {
    name: 'disableSocialAutomation',
    domain: 'social',
    title: 'Switch off an automatic rule',
    // Turning something OFF only ever reduces what happens without a human, so
    // it is a plain internal write and deliberately NOT sensitive: making the
    // user approve a stop would be the wrong default in an emergency.
    description: 'Switch off an automatic rule so it stops acting on its own. Safe to do at any time — it only stops things happening.',
    gate: 'internal_write',
    inputSchema: obj({ id: S.string }, ['id']),
    zod: z.object({ id: z.string().min(1) }),
    run: async (accountId, a) => {
      await ownedRule(accountId, a.id);
      const { data, error } = await supabase
        .from('social_automations')
        .update({ enabled: false, updated_at: new Date().toISOString() })
        .eq('account_id', accountId)
        .eq('id', a.id)
        .select();
      if (error) throw error;
      return data?.[0];
    },
  },
  {
    name: 'deleteSocialAutomation',
    domain: 'social',
    title: 'Delete an automatic rule',
    description: 'Permanently delete an automatic rule. This cannot be undone — if the user only wants it to stop for now, switch it off instead.',
    gate: 'destructive',
    inputSchema: obj({ id: S.string }, ['id']),
    zod: z.object({ id: z.string().min(1) }),
    run: async (accountId, a) => {
      const rule = await ownedRule(accountId, a.id);
      const { error } = await supabase
        .from('social_automations')
        .delete()
        .eq('account_id', accountId)
        .eq('id', a.id);
      if (error) throw error;
      return { deleted: true, id: a.id, was: { trigger: rule.trigger, action: rule.action, enabled: rule.enabled } };
    },
    summarize: (a) => `Permanently delete automatic rule ${a.id}. This cannot be undone.`,
  },
  {
    // Packet 7.3 kill switch — one account-level flag that stops every
    // enabled rule at once (accounts.social_automations_paused, migration
    // 045), on top of the per-rule enabled bit. This is the "stop everything
    // right now" lever; it does not touch any individual rule's enabled
    // state, so turning it back off (resumeAllSocialAutomations) does not by
    // itself re-arm anything that wasn't already enabled.
    name: 'pauseAllSocialAutomations',
    domain: 'social',
    title: 'Pause all automatic social rules',
    // Mirrors disableSocialAutomation's reasoning: pausing only ever reduces
    // what happens without a human, so it is ungated — an emergency stop
    // should never wait on an approval.
    description: 'Immediately stop every automatic social rule for this account from firing, without changing or deleting any individual rule. Use this as an emergency stop. Turning it back on with resumeAllSocialAutomations does not by itself switch any rule on — rules that were off stay off.',
    gate: 'internal_write',
    inputSchema: obj({}),
    zod: z.object({}),
    run: async (accountId) => {
      const { data, error } = await supabase
        .from('accounts')
        .update({ social_automations_paused: true })
        .eq('id', accountId)
        .select('id, social_automations_paused');
      if (error) throw error;
      return data?.[0];
    },
    summarize: () => 'Pause ALL automatic social rules for this account immediately.',
  },
  {
    name: 'resumeAllSocialAutomations',
    domain: 'social',
    title: 'Resume automatic social rules',
    description: 'Allow automatic social rules to fire again after a pause. Only rules that are individually switched on will actually resume acting — this does not turn any rule back on by itself. Requires explicit confirmation since it restores unattended sending.',
    gate: 'standing_rule',
    inputSchema: obj({}),
    zod: z.object({}),
    run: async (accountId) => {
      const { data, error } = await supabase
        .from('accounts')
        .update({ social_automations_paused: false })
        .eq('id', accountId)
        .select('id, social_automations_paused');
      if (error) throw error;
      return data?.[0];
    },
    summarize: () => 'Resume automatic social rules for this account (only rules that are individually switched on will actually act again).',
  },
];
