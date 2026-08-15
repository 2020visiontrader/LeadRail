// Content-creation pipeline (migration 032_content_pipeline.sql).
//
// The "Scout -> Planner -> Creator -> Reviewer -> Publisher -> Analyst" flow
// (socialflow-style). Each run is a row in content_pipeline_runs; each stage
// is ONE runAgent call against the EXISTING agent loop (lib/agent/loop.ts —
// imported and called here, never edited). The Reviewer stage is a quality
// gate: a "needs revision" verdict stops the run before Publisher/Analyst.
//
// Bounded by construction: STAGE_DEFS below is a fixed, finite array (6
// entries) iterated with a plain for-loop — no while/recursion, no unbounded
// retries. Every stage is wrapped in its own try/catch so a single failure
// records an error and stops the run gracefully instead of crashing.

import { supabase } from '@/lib/db';
import { runAgent } from '@/lib/agent/loop';

export type PipelineStageKey = 'scout' | 'planner' | 'creator' | 'reviewer' | 'publisher' | 'analyst';
export type PipelineStatus = 'running' | 'completed' | 'failed';
export type StageStatus = 'pending' | 'running' | 'done' | 'failed';

export interface PipelineStageResult {
  key: PipelineStageKey;
  status: StageStatus;
  output?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface ContentPipelineRunRow {
  id: string;
  account_id: string;
  topic: string;
  status: PipelineStatus;
  current_stage: PipelineStageKey | null;
  stages: PipelineStageResult[];
  output: any;
  created_at: string;
  updated_at: string;
}

const RESULT_TRUNCATE_LEN = 8000;
const CONTEXT_TRUNCATE_LEN = 6000;

/** Fixed stage order + human labels, shared with the UI (rendering) and the
 *  orchestrator (iteration). This is the single source of truth for order. */
export const PIPELINE_STAGES: { key: PipelineStageKey; label: string }[] = [
  { key: 'scout', label: 'Scout' },
  { key: 'planner', label: 'Planner' },
  { key: 'creator', label: 'Creator' },
  { key: 'reviewer', label: 'Reviewer' },
  { key: 'publisher', label: 'Publisher' },
  { key: 'analyst', label: 'Analyst' },
];

interface StageDef {
  key: PipelineStageKey;
  instruction: (topic: string, prior: string) => string;
}

const STAGE_DEFS: StageDef[] = [
  {
    key: 'scout',
    instruction: (topic) =>
      `You are the Scout stage of a content pipeline. Topic: "${topic}". ` +
      `Research and report, in plain language: the target audience, the most promising angles and hooks, ` +
      `relevant competitor/industry context, and 3 concrete content directions. Do not write the content yet — just scout.`,
  },
  {
    key: 'planner',
    instruction: (topic, prior) =>
      `You are the Planner stage of a content pipeline. Topic: "${topic}". ` +
      `Using this scout research:\n${prior}\n\nProduce a concise content plan: the chosen angle, format, ` +
      `platform, headline/hook, and a 3-5 point outline.`,
  },
  {
    key: 'creator',
    instruction: (topic, prior) =>
      `You are the Creator stage of a content pipeline. Topic: "${topic}". ` +
      `Using this plan:\n${prior}\n\nWrite the full draft content (hook, body, and call to action).`,
  },
  {
    key: 'reviewer',
    instruction: (topic, prior) =>
      `You are the Reviewer stage of a content pipeline — a quality gate. Topic: "${topic}". ` +
      `Review this draft for accuracy, clarity, tone, and brand safety:\n${prior}\n\n` +
      `Reply with EXACTLY "APPROVED" if it is publish-ready, or "NEEDS_REVISION: <specific reasons>" if it is not.`,
  },
  {
    key: 'publisher',
    instruction: (topic, prior) =>
      `You are the Publisher stage of a content pipeline. Topic: "${topic}". ` +
      `Using this approved draft:\n${prior}\n\nProduce the final publish-ready package: final copy, ` +
      `suggested platform(s), hashtags, and the best posting time.`,
  },
  {
    key: 'analyst',
    instruction: (topic, prior) =>
      `You are the Analyst stage of a content pipeline. Topic: "${topic}". ` +
      `Using this published content:\n${prior}\n\nProvide a short post-mortem: expected performance, ` +
      `the metrics to watch, and 2-3 follow-up content ideas.`,
  },
];

/** Compact running context from all completed stages, fed to the next stage so
 *  later steps (Creator/Reviewer/Publisher/Analyst) see prior output. */
function buildContext(doneStages: PipelineStageResult[]): string {
  const labelFor = (key: PipelineStageKey) =>
    PIPELINE_STAGES.find((s) => s.key === key)?.label || key;
  return doneStages
    .filter((s) => s.status === 'done' && s.output)
    .map((s) => `${labelFor(s.key)}:\n${s.output}`)
    .join('\n\n')
    .slice(0, CONTEXT_TRUNCATE_LEN);
}

// --- Account-scoped CRUD ---------------------------------------------------

export async function listPipelineRuns(accountId: string): Promise<ContentPipelineRunRow[]> {
  const { data, error } = await supabase
    .from('content_pipeline_runs')
    .select('*')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []) as ContentPipelineRunRow[];
}

export async function getPipelineRun(accountId: string, id: string): Promise<ContentPipelineRunRow | null> {
  const { data, error } = await supabase
    .from('content_pipeline_runs')
    .select('*')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw error;
  return (data as ContentPipelineRunRow) || null;
}

export async function createPipelineRun(accountId: string, topic: string): Promise<ContentPipelineRunRow> {
  const row = {
    account_id: accountId,
    topic,
    status: 'running' as PipelineStatus,
    current_stage: PIPELINE_STAGES[0].key as PipelineStageKey,
    stages: [] as PipelineStageResult[],
    output: null,
  };
  const { data, error } = await supabase.from('content_pipeline_runs').insert([row]).select().single();
  if (error) throw error;
  return data as ContentPipelineRunRow;
}

/** Persist in-progress state (status/current_stage/stages/output). Always
 *  scoped by account_id so a caller can never mutate another tenant's run. */
async function persistRun(accountId: string, id: string, patch: {
  status?: PipelineStatus;
  current_stage?: PipelineStageKey | null;
  stages?: PipelineStageResult[];
  output?: any;
}): Promise<void> {
  const { error } = await supabase
    .from('content_pipeline_runs')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('account_id', accountId);
  if (error) throw error;
}

// --- Orchestrator ----------------------------------------------------------

/**
 * Walk the 6 stages sequentially for a topic, calling runAgent once per stage
 * and persisting each stage's result. The Reviewer stage gates the run: a
 * "needs revision" verdict (or any stage error) marks the run `failed` and
 * stops before Publisher/Analyst. Returns the fully-updated run row.
 *
 * TODO(wiring): this awaits all 6 agent calls inline, so POST /api/pipeline
 * holds the request for the full run. If the host's function timeout is
 * shorter than a worst-case 6-call run, split POST into "create row + return
 * immediately" and run the pipeline in a background process/service (the
 * per-stage persistence here already supports polling progress via GET).
 */
export async function runPipeline(accountId: string, topic: string): Promise<ContentPipelineRunRow> {
  const run = await createPipelineRun(accountId, topic);
  let stages: PipelineStageResult[] = PIPELINE_STAGES.map((s) => ({ key: s.key, status: 'pending' }));
  let prior = '';
  let failed = false;

  for (let i = 0; i < STAGE_DEFS.length; i++) {
    const def = STAGE_DEFS[i];

    stages[i] = { ...stages[i], status: 'running', startedAt: new Date().toISOString() };
    await persistRun(accountId, run.id, { current_stage: def.key, stages });

    try {
      const instruction = def.instruction(topic, prior);
      const result = await runAgent({ accountId, message: instruction });
      const text = String(result?.message || '').trim() || '(no output)';
      const output = text.slice(0, RESULT_TRUNCATE_LEN);

      // Quality gate: only the Reviewer stage can hold a run. Treat an explicit
      // "needs revision / not approved / reject" signal as a failed gate;
      // anything else (including a bare "APPROVED") passes.
      if (def.key === 'reviewer') {
        const needsRevision = /needs_revision|revision\s*needed|not\s+approved|reject/i.test(text);
        if (needsRevision) {
          stages[i] = {
            ...stages[i],
            status: 'failed',
            output,
            error: 'Quality gate: revision requested',
            finishedAt: new Date().toISOString(),
          };
          await persistRun(accountId, run.id, {
            status: 'failed',
            current_stage: def.key,
            stages,
            output: { error: 'Quality gate: revision requested', stage: def.key },
          });
          failed = true;
          break;
        }
      }

      stages[i] = { ...stages[i], status: 'done', output, finishedAt: new Date().toISOString() };
      prior = buildContext(stages.slice(0, i + 1));
      await persistRun(accountId, run.id, { current_stage: def.key, stages });
    } catch (e: any) {
      const err = String(e?.message || e).slice(0, RESULT_TRUNCATE_LEN);
      stages[i] = { ...stages[i], status: 'failed', error: err, finishedAt: new Date().toISOString() };
      await persistRun(accountId, run.id, {
        status: 'failed',
        current_stage: def.key,
        stages,
        output: { error: err, stage: def.key },
      });
      failed = true;
      break;
    }
  }

  if (!failed) {
    const analyst = stages[stages.length - 1]?.output || '';
    await persistRun(accountId, run.id, {
      status: 'completed',
      current_stage: null,
      stages,
      output: { text: analyst, completed: true },
    });
  }

  const final = await getPipelineRun(accountId, run.id);
  if (!final) throw new Error('pipeline run not found after completion');
  return final;
}
