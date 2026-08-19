import { z } from 'zod';
import { supabase, getVenture, getVentures } from '@/lib/db';
import { obj, S, type Capability } from './types';

// Cross-session goals (migration 048).
//
// Everything else the assistant can do is single-turn: ask, get an artefact,
// done. A goal outlives the conversation — it is worked across sessions until a
// criterion says the floor was met. This is the kai-goal pattern.
//
// Two rules hold the design together:
//
//  1. OBJECTIVE vs SUCCESS CRITERION. The objective is what the operator wants;
//     the criterion is how anyone can tell it happened. Without a checkable
//     criterion a goal is a wish and the loop never terminates — so the criterion
//     is required at creation, not optional.
//
//  2. THE ACTOR MAY NOT MOVE ITS OWN GOALPOSTS. logGoalProgress can append work
//     and can mark a goal met, but it CANNOT rewrite the criterion. Same
//     separation of powers as the content gate. If the criterion turns out to be
//     wrong, a human edits it — otherwise a struggling agent could quietly
//     redefine success as whatever it managed to achieve.

async function resolveBrand(accountId: string, brandId?: string) {
  const v: any = brandId ? await getVenture(brandId) : (await getVentures(accountId))[0];
  if (!v) return { error: 'No brand found. Create one first.' as const };
  if (v.account_id && v.account_id !== accountId) return { error: 'Brand not found' as const };
  return { brand: v };
}

export const GOAL_CAPABILITIES: Capability[] = [
  {
    name: 'createGoal',
    domain: 'goals',
    title: 'Set a marketing goal',
    description:
      'Create a goal that persists across sessions. Needs BOTH an objective (what the operator wants) and a success criterion (how anyone can tell it happened — a number, a date, or a decision). If the user has not given you a checkable criterion, ask for one rather than inventing it.',
    gate: 'internal_write',
    inputSchema: obj({ brandId: S.string, objective: S.string, successCriterion: S.string }, ['objective', 'successCriterion']),
    zod: z.object({
      brandId: z.string().optional(),
      objective: z.string().min(3),
      successCriterion: z.string().min(3),
    }),
    run: async (accountId, a) => {
      const r = await resolveBrand(accountId, a.brandId);
      if ('error' in r) return r;
      const { data, error } = await supabase
        .from('brand_goals')
        .insert({
          account_id: accountId,
          brand_id: r.brand.id,
          objective: a.objective,
          success_criterion: a.successCriterion,
        })
        .select('id, objective, success_criterion, status')
        .single();
      if (error) return { error: error.message };
      return { goal: data, brand: r.brand.name };
    },
    digest: (_a, result: any) =>
      result?.goal ? `Goal set for ${result.brand}: ${result.goal.objective} (met when: ${result.goal.success_criterion}).` : '',
  },
  {
    name: 'listGoals',
    domain: 'goals',
    title: 'List goals',
    description:
      'List goals for the account, active first. Call this at the START of a session when the user refers to ongoing work, or asks what you are meant to be doing — it is how you pick up where the last session left off.',
    gate: 'read',
    inputSchema: obj({ brandId: S.string, status: S.string }, []),
    zod: z.object({ brandId: z.string().optional(), status: z.enum(['active', 'paused', 'met', 'abandoned']).optional() }),
    run: async (accountId, a) => {
      let q = supabase
        .from('brand_goals')
        .select('id, brand_id, objective, success_criterion, status, progress_log, last_worked_at, met_at')
        .eq('account_id', accountId)
        // Oldest-worked first so nothing starves while newer goals get attention.
        .order('status', { ascending: true })
        .order('last_worked_at', { ascending: true, nullsFirst: true })
        .limit(50);
      if (a.brandId) q = q.eq('brand_id', a.brandId);
      if (a.status) q = q.eq('status', a.status);
      const { data, error } = await q;
      if (error) return { error: error.message };
      return (data || []).map((g: any) => ({
        ...g,
        // The log can grow unbounded; the model only needs the recent shape of it.
        progress_log: Array.isArray(g.progress_log) ? g.progress_log.slice(-5) : [],
        progressEntries: Array.isArray(g.progress_log) ? g.progress_log.length : 0,
      }));
    },
    digest: (_a, result: any) => {
      const rows = Array.isArray(result) ? result : [];
      if (!rows.length) return 'No goals set.';
      const active = rows.filter((g) => g.status === 'active');
      const met = rows.filter((g) => g.status === 'met').length;
      const names = active.slice(0, 3).map((g) => g.objective);
      return [
        `${rows.length} goal${rows.length === 1 ? '' : 's'} (${active.length} active${met ? `, ${met} met` : ''}).`,
        names.length ? `Active: ${names.join(' · ')}` : null,
      ].filter(Boolean).join(' ');
    },
  },
  {
    name: 'logGoalProgress',
    domain: 'goals',
    title: 'Record progress on a goal',
    description:
      'Append what was done toward a goal, and optionally mark it met. Record progress whenever you complete work that serves a goal — that log is what a LATER session reads to continue instead of starting over. You may mark a goal met only when the stored success criterion is genuinely satisfied; you cannot change the criterion.',
    gate: 'internal_write',
    inputSchema: obj({ goalId: S.string, note: S.string, markMet: { type: 'boolean' } }, ['goalId', 'note']),
    zod: z.object({ goalId: z.string().min(1), note: z.string().min(1), markMet: z.boolean().optional() }),
    run: async (accountId, a) => {
      const { data: goal, error: readErr } = await supabase
        .from('brand_goals')
        .select('id, objective, success_criterion, status, progress_log')
        .eq('account_id', accountId)
        .eq('id', a.goalId)
        .maybeSingle();
      if (readErr) return { error: readErr.message };
      if (!goal) return { error: 'Goal not found' };

      const log = Array.isArray((goal as any).progress_log) ? (goal as any).progress_log : [];
      log.push({ at: new Date().toISOString(), note: a.note });

      const patch: Record<string, any> = {
        progress_log: log,
        last_worked_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      // NOTE: success_criterion is deliberately absent from this patch. The
      // actor records work and may declare the bar cleared; it may not lower it.
      if (a.markMet) {
        patch.status = 'met';
        patch.met_at = new Date().toISOString();
      }

      const { error } = await supabase.from('brand_goals').update(patch).eq('account_id', accountId).eq('id', a.goalId);
      if (error) return { error: error.message };
      return {
        goalId: a.goalId,
        objective: (goal as any).objective,
        status: a.markMet ? 'met' : (goal as any).status,
        entries: log.length,
        criterion: (goal as any).success_criterion,
      };
    },
    digest: (_a, result: any) =>
      result?.goalId
        ? result.status === 'met'
          ? `Marked met: ${result.objective} (criterion: ${result.criterion}).`
          : `Logged progress on: ${result.objective} (${result.entries} entries).`
        : '',
  },
];
