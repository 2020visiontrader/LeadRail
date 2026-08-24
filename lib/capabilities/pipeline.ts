// Content-pipeline capabilities — exposing an engine that already existed.
//
// content_pipeline_runs (migration 032) and lib/pipeline/store.ts have shipped
// a six-stage content engine — Scout, Planner, Creator, Reviewer, Publisher,
// Analyst — reachable over /api/pipeline and from the UI. Nothing in the
// capability registry pointed at it, so the assistant could not run it, could
// not read a past run, and could not even tell the user the feature existed.
// "Write me a piece about X" got a one-shot draft from the chat model while the
// pipeline that researches, plans, drafts, quality-gates and packages it sat
// one function call away.
//
// Nothing here publishes. The Publisher stage produces a publish-ready package
// — final copy, platforms, hashtags, timing — and stops. Actually putting it
// out is publishSocialPost or scheduleSocialPost, each with its own approval.

import { z } from 'zod';
import { runPipeline, listPipelineRuns, getPipelineRun, PIPELINE_STAGES } from '@/lib/pipeline/store';
import { obj, S, type Capability, rowsOf, plural, samples, digestLine } from './types';

const STAGE_LABELS = PIPELINE_STAGES.map((s) => s.label).join(' → ');

export const PIPELINE_CAPABILITIES: Capability[] = [
  {
    name: 'runContentPipeline',
    domain: 'content',
    title: 'Run the content pipeline',
    description:
      `Take a topic through the full content engine (${STAGE_LABELS}) and return the finished, publish-ready package: researched angle, chosen format and platform, the written draft, a quality-gate verdict, hashtags and suggested timing, plus what to measure afterwards. Use this whenever the user wants a real piece of content rather than a quick line — it researches and quality-gates instead of guessing. It takes a while: say you are running it, and do not run two at once. It does NOT publish anything; the user still approves publishing separately.`,
    gate: 'internal_write',
    inputSchema: obj({ topic: S.string }, ['topic']),
    zod: z.object({ topic: z.string().min(3).max(500) }),
    run: (accountId, a) => runPipeline(accountId, a.topic),
    // The final package is the deliverable and it is long — a normal
    // observation budget would clip the Publisher and Analyst stages, which is
    // exactly the half the user asked for.
    observationLimit: 24_000,
    digest: (a, result) => {
      if (!result || typeof result !== 'object') return '';
      const r: any = result;
      const failed = Array.isArray(r.stages) ? r.stages.filter((s: any) => s.status === 'error') : [];
      return digestLine(
        `Content pipeline for "${a?.topic ?? ''}" ${r.status === 'completed' ? 'completed' : r.status}.`,
        failed.length ? `Failed at: ${failed.map((s: any) => s.key).join(', ')}.` : null,
        r.current_stage && r.status !== 'completed' ? `Stopped at ${r.current_stage}.` : null,
      );
    },
  },
  {
    name: 'listContentPipelineRuns',
    domain: 'content',
    title: 'List content pipeline runs',
    description: 'List past runs of the content engine for this account, newest first — topic, status and which stage each reached. Use to find an earlier piece before re-running the work.',
    gate: 'read',
    inputSchema: obj({}),
    zod: z.object({}),
    run: (accountId) => listPipelineRuns(accountId),
    digest: (_a, result) => {
      const rows = rowsOf(result);
      if (!rows) return '';
      if (!rows.length) return 'No content pipeline runs yet.';
      return digestLine(
        `${plural(rows.length, 'pipeline run')}.`,
        `Topics: ${samples(rows, ['topic'], 5).join(', ')}`,
      );
    },
  },
  {
    name: 'getContentPipelineRun',
    domain: 'content',
    title: 'Read a content pipeline run',
    description: 'Read one past content-engine run in full — every stage\'s output and the final package. Needs the run id from listContentPipelineRuns.',
    gate: 'read',
    inputSchema: obj({ runId: S.string }, ['runId']),
    zod: z.object({ runId: z.string().min(1) }),
    run: async (accountId, a) => {
      const row = await getPipelineRun(accountId, a.runId);
      if (!row) throw new Error('No content pipeline run with that id for this account.');
      return row;
    },
    observationLimit: 24_000,
  },
];
