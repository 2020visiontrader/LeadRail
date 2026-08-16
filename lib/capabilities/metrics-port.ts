/**
 * Temporary reference file (Packet 2.1 step 5).
 *
 * Ported `deriveMetrics` logic from lib/agent/loop.ts. For each capability
 * name, this maps to the metrics function that must be attached to it.
 *
 * IMPORTANT: Values must be derived from REAL results and never fabricated.
 * This drives the assistant dock's "This run" KPI tiles.
 */

export const arrLen = (v: any): number | undefined =>
  Array.isArray(v)
    ? v.length
    : Array.isArray(v?.people)
      ? v.people.length
      : Array.isArray(v?.leads)
        ? v.leads.length
        : Array.isArray(v?.results)
          ? v.results.length
          : undefined;

export type MetricsFn = (args: any, result: any) => Record<string, number>;

// Each entry is annotated with MetricsFn so the `cond ? {k:1} : {}` shape is
// checked against Record<string, number> rather than inferred as a union that
// TS strict rejects ({k?: undefined} is not assignable to an index signature).
export const METRICS_BY_NAME: Record<string, MetricsFn> = {
  sourceLeads: ((_args, result) => {
    const n = arrLen(result);
    return n != null ? { leadsFound: n } : {};
  }) as MetricsFn,
  enrichLead: ((_args, result) => (result ? { revealed: 1 } : {})) as MetricsFn,
  draftOutreach: ((_args, result) => (result ? { drafts: 1 } : {})) as MetricsFn,
  generateAdCopy: ((_args, result) => (result ? { copy: 1 } : {})) as MetricsFn,
  sendEmail: ((_args, _result) => ({ emailsSent: 1 })) as MetricsFn,
  enrollInSequence: ((args, _result) => {
    const n = Array.isArray(args?.contactIds) ? args.contactIds.length : 1;
    return { enrolled: n };
  }) as MetricsFn,
  updateLeadStatus: ((args, _result) =>
    args?.status === 'qualified' ? { qualified: 1 } : {}) as MetricsFn,
  createDeal: ((_args, result) => (result ? { deals: 1 } : {})) as MetricsFn,
};
