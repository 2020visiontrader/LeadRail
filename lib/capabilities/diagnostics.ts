// Diagnostics domain — the assistant's first grounded analysis capability.
//
// Emits structured finding/claim/verdict/evidence events (see
// lib/capabilities/types.ts's `Analysis`) instead of leaving the model to
// narrate the pipeline in prose. Every number here is read straight off
// `deals`/`pipeline_stages` rows already returned by getDeals/getPipelineStages
// — no business logic reimplemented, no invented data, no benchmark corpus
// LeadRail does not have. That is a deliberate scope limit: this ships
// `direct_observation` and `crm_history` claims only. A capability that
// claimed a `benchmark` basis without a benchmark corpus to back it would be
// exactly the "evidence UI implying rigor it doesn't have" failure mode this
// was built to avoid.
import { z } from 'zod';
import { getDeals, getPipelineStages } from '@/lib/crm';
import { obj, S, type Capability, type Analysis, type Claim, type Finding, type Evidence } from './types';

// A stage needs at least this many open deals before a stall claim is even
// considered — below this, "average days stalled" is noise, not a measurement.
const MIN_STAGE_N = 3;
// A stage's median days-since-touched must clear this before the claim is
// promoted to a finding. Chosen to match the CRM's own follow-up cadence
// language elsewhere in the product (a few days, not weeks).
const STALL_DAYS_THRESHOLD = 4;

export const DIAGNOSTICS_CAPABILITIES: Capability[] = [
  {
    name: 'diagnosePipeline',
    domain: 'diagnostics',
    title: 'Diagnose pipeline stalls',
    description:
      'Analyze the deal pipeline for stages where deals are piling up and going untouched. Returns which stages ' +
      'are stalled, how many deals and how long, grounded in real deal data (not a guess). Use when the user asks ' +
      'why deals aren\'t closing, where the pipeline is stuck, or wants a diagnostic read on pipeline health.',
    gate: 'read',
    inputSchema: obj({ brandId: S.string }),
    zod: z.object({ brandId: z.string().optional() }),
    run: async (accountId, { brandId }: { brandId?: string }) => {
      const [deals, stages] = await Promise.all([
        getDeals(accountId, brandId ?? null, 500, 0),
        getPipelineStages(accountId, brandId ?? null),
      ]);
      const stageById = new Map((stages || []).map((s: any) => [s.id, s]));
      const now = Date.now();
      const byStage = new Map<string, any[]>();
      for (const d of deals || []) {
        const stage = stageById.get(d.stage_id);
        if (!stage || stage.is_won || stage.is_lost) continue; // only open, real stages
        const list = byStage.get(d.stage_id) || [];
        list.push(d);
        byStage.set(d.stage_id, list);
      }
      const stageStats = [...byStage.entries()].map(([stageId, rows]) => {
        const ageDays = rows
          .map((d) => (now - new Date(d.updated_at || d.created_at).getTime()) / 86_400_000)
          .sort((a, b) => a - b);
        const median = ageDays[Math.floor(ageDays.length / 2)];
        return {
          stageId,
          stageName: stageById.get(stageId)?.name || stageId,
          count: rows.length,
          medianDaysStalled: Math.round(median * 10) / 10,
          sampleDealIds: rows.slice(0, 5).map((d) => d.id),
          sampleDealNames: rows.slice(0, 5).map((d) => d.name).filter(Boolean),
        };
      });
      return { stages: stageStats };
    },
    digest: (_args, result) => {
      // A null/undefined result means "we don't know" — say nothing, per the
      // house rule (tests/capability-contract.test.ts). Only an ACTUAL empty
      // `stages` array (the real shape run() always returns) is truthfully
      // "no open deals" — those are different facts and must not collapse.
      if (!result || typeof result !== 'object' || !Array.isArray(result.stages)) return '';
      const stages: any[] = result.stages;
      if (!stages.length) return 'No open deals in any pipeline stage.';
      const parts = stages
        .slice()
        .sort((a: any, b: any) => b.count - a.count)
        .map((s: any) => `${s.stageName}: ${s.count} deal${s.count === 1 ? '' : 's'}, median ${s.medianDaysStalled}d untouched`);
      return `Open pipeline by stage — ${parts.join('; ')}.`;
    },
    // The grounded analysis. Every claim's `n` and every finding's evidence
    // come straight from `result.stages`, which itself came straight from
    // `run()` above — nothing here re-derives or estimates.
    findings: (_args, result): Analysis | null => {
      const stages = result?.stages;
      if (!Array.isArray(stages) || !stages.length) return { evidence: [], claims: [], findings: [] };

      const evidence: Evidence[] = [];
      const claims: Claim[] = [];
      const findings: Finding[] = [];

      for (const s of stages) {
        if (typeof s.count !== 'number' || typeof s.medianDaysStalled !== 'number') continue;
        if (s.count < MIN_STAGE_N) continue; // not enough rows to say anything

        const evId = `ev_${s.stageId}`;
        const sampleNames: string[] = Array.isArray(s.sampleDealNames) ? s.sampleDealNames.slice(0, 3) : [];
        evidence.push({
          id: evId,
          label: sampleNames.length
            ? `${s.count} deals in "${s.stageName}", e.g. ${sampleNames.join(', ')}`
            : `${s.count} deals in "${s.stageName}"`,
        });

        const claimId = `claim_${s.stageId}`;
        claims.push({
          id: claimId,
          text: `Deals in "${s.stageName}" sit a median of ${s.medianDaysStalled} day${s.medianDaysStalled === 1 ? '' : 's'} without an update.`,
          basis: { kind: 'crm_history', n: s.count },
          evidenceIds: [evId],
        });

        if (s.medianDaysStalled >= STALL_DAYS_THRESHOLD) {
          findings.push({
            id: `finding_${s.stageId}`,
            claimId,
            severity: s.medianDaysStalled >= STALL_DAYS_THRESHOLD * 2 ? 'high' : 'medium',
            recommendation: `Review the ${s.count} deal${s.count === 1 ? '' : 's'} in "${s.stageName}" — follow up or move them to reflect reality.`,
          });
        }
      }

      const verdict = findings.length
        ? {
            summary:
              findings.length === 1
                ? 'One pipeline stage is stalled and worth a look.'
                : `${findings.length} pipeline stages are stalled and worth a look.`,
            findingIds: findings.map((f) => f.id),
          }
        : undefined;

      return { evidence, claims, findings, verdict };
    },
  },
];
