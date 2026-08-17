// Packet 2.2 — budgets domain. Thin wrappers over lib/budgets/store.ts.
//
// DEVIATION FROM THE PLAN (reported, not silently fixed): the plan names
// the read capability `listBudgets`, but the data model is one budget row
// per account (lib/budgets/store.ts's getBudget(accountId) -> single row or
// null), not a list. Naming it `listBudgets` while it returns a single
// object would be untruthful to the model, so it is named `getBudget`
// instead — same backing function, name matches its actual shape.
import { z } from 'zod';
import { getBudget, getBudgetStatus, upsertBudget } from '@/lib/budgets/store';
import { obj, S, type Capability, present, digestLine } from './types';

export const BUDGET_CAPABILITIES: Capability[] = [
  {
    name: 'getBudget',
    domain: 'budgets',
    title: 'Get budget settings',
    description: 'Get the account\'s monthly spend budget settings (limit, alert threshold, hard stop).',
    gate: 'read',
    inputSchema: obj({}),
    zod: z.object({}),
    run: (accountId) => getBudget(accountId),
  },
  {
    name: 'getBudgetStatus',
    domain: 'budgets',
    title: 'Get budget status',
    description: 'Get the account\'s current spend against its monthly budget: amount spent, remaining, percent used, and whether it is over the alert threshold or the limit.',
    gate: 'read',
    inputSchema: obj({}),
    zod: z.object({}),
    run: (accountId) => getBudgetStatus(accountId),
    digest: (_args, result) => {
      if (!result || typeof result !== 'object') return '';
      return digestLine(
        present(result, 'spent') ? `Spent ${result.spent} this month.` : null,
        present(result, 'limit') && result.limit !== null ? `Limit ${result.limit}.` : null,
        present(result, 'remaining') && result.remaining !== null ? `Remaining ${result.remaining}.` : null,
        result.overLimit ? 'Over limit.' : result.alert ? 'Near the alert threshold.' : null,
      );
    },
  },
  {
    name: 'setBudget',
    domain: 'budgets',
    title: 'Set budget',
    description: 'Update the account\'s monthly spend budget: the credit limit, alert threshold percent, whether to hard-stop spend over the limit, and whether budgeting is enabled.',
    gate: 'internal_write',
    inputSchema: obj({ monthlyLimitCredits: S.number, alertThresholdPct: S.number, hardStop: { type: 'boolean' }, enabled: { type: 'boolean' } }),
    zod: z.object({
      monthlyLimitCredits: z.number().nullable().optional(),
      alertThresholdPct: z.number().optional(),
      hardStop: z.boolean().optional(),
      enabled: z.boolean().optional(),
    }),
    run: (accountId, a) => upsertBudget(accountId, {
      monthly_limit_credits: a.monthlyLimitCredits, alert_threshold_pct: a.alertThresholdPct, hard_stop: a.hardStop, enabled: a.enabled,
    }),
  },
];
