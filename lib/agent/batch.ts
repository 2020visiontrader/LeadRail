// Running one tool over many inputs in a single step.
//
// WHAT WAS IMPOSSIBLE BEFORE. The loop protocol allows exactly one tool call
// per step, and two guards sit on top of it: MAX_STEPS caps a turn at 16 steps,
// and the duplicate check refuses a third call to the same tool in one turn.
// Both are right for what they were written for — a runaway loop calling
// listLeads forty times is a real failure, and each of those calls is a
// separate decision the model should not be making repeatedly.
//
// But "reveal these 25 people" is not twenty-five decisions. It is ONE decision
// applied to twenty-five rows, and expressing it as twenty-five steps hit the
// duplicate guard on the third lead and the step cap long before the batch was
// done. The observed failure was an agent enriching leads one at a time and
// running out of turn before it finished — not slow, structurally unable.
//
// So: one tool, many argument sets, one step. The guards keep meaning what they
// meant (this is still ONE decision) and the work happens concurrently.
//
// SAME TOOL ONLY, deliberately. Arbitrary parallel tool calls raise questions
// this does not have to answer — ordering between different tools, one call
// depending on another's result, and a mixed approval card that has to describe
// several unrelated actions at once. A homogeneous batch has one answer to each:
// no ordering, no dependencies, and a card that reads "reveal these 25 people".

import type { AgentTool } from './tools';

/** Concurrent in-flight calls. Small on purpose: these hit third-party APIs
 *  that rate-limit, and twenty-five simultaneous requests to Apollo is the
 *  fastest way to measure their limiter instead of doing the work. Five is
 *  roughly a 5x speedup while still looking like a client rather than a flood. */
export const BATCH_CONCURRENCY = Number(process.env.AGENT_BATCH_CONCURRENCY) || 5;

/** Hard cap on one batch.
 *
 *  This is a SPEND bound as much as a performance one: a sensitive batch is
 *  approved with a single click, so this is the largest number of paid actions
 *  one approval can ever license. It has to be a number a person can hold in
 *  their head while reading the card. */
export const MAX_BATCH = Number(process.env.AGENT_MAX_BATCH) || 25;

export interface BatchCall {
  args: Record<string, any>;
}

export type BatchParse =
  | { kind: 'none' }
  | { kind: 'batch'; calls: BatchCall[] }
  | { kind: 'invalid'; reason: string };

/**
 * Read a `calls` array off a parsed envelope.
 *
 * Returns 'none' when the envelope is an ordinary single call, so a caller can
 * branch without knowing anything about batching. An envelope carrying BOTH
 * `args` and `calls` is invalid rather than silently preferring one: the model
 * meant something specific and guessing which would run work nobody asked for.
 */
export function parseBatch(parsed: any): BatchParse {
  const raw = parsed?.calls;
  if (raw === undefined || raw === null) return { kind: 'none' };
  if (!Array.isArray(raw)) {
    return { kind: 'invalid', reason: '"calls" must be an array of argument objects.' };
  }
  if (!raw.length) {
    return { kind: 'invalid', reason: '"calls" was empty — use "args" for a single call, or omit the step.' };
  }
  if (parsed.args && typeof parsed.args === 'object' && Object.keys(parsed.args).length) {
    return {
      kind: 'invalid',
      reason: 'Use EITHER "args" for one call OR "calls" for a batch, never both.',
    };
  }
  if (raw.length > MAX_BATCH) {
    return {
      kind: 'invalid',
      reason: `A batch may contain at most ${MAX_BATCH} calls; you asked for ${raw.length}. Split it across steps.`,
    };
  }
  const calls: BatchCall[] = [];
  for (const [i, entry] of raw.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { kind: 'invalid', reason: `Entry ${i + 1} of "calls" is not an object of arguments.` };
    }
    calls.push({ args: entry as Record<string, any> });
  }
  return { kind: 'batch', calls };
}

export interface BatchItemResult {
  index: number;
  args: Record<string, any>;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Run one tool over every argument set, at most BATCH_CONCURRENCY at a time.
 *
 * Every call is reported, successes and failures alike, in INPUT order. One
 * failure never cancels the rest: in a batch of reveals, three bad ids should
 * not cost the twenty-two good ones — and a partial result the model can see
 * is far more useful than an exception that discards the work already paid for.
 */
export async function runBatch(
  calls: BatchCall[],
  run: (args: Record<string, any>) => Promise<{ ok: boolean; result?: unknown; error?: string }>,
  concurrency: number = BATCH_CONCURRENCY,
): Promise<BatchItemResult[]> {
  const results: BatchItemResult[] = new Array(calls.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= calls.length) return;
      const { args } = calls[i];
      try {
        const res = await run(args);
        results[i] = { index: i, args, ok: res.ok, result: res.result, error: res.error };
      } catch (e: any) {
        // runTool is documented never to throw, but a batch must not be the
        // place that discovers otherwise — one unexpected throw would lose
        // every result gathered alongside it.
        results[i] = { index: i, args, ok: false, error: String(e?.message || e).slice(0, 300) };
      }
    }
  };

  const lanes = Math.max(1, Math.min(concurrency, calls.length));
  await Promise.all(Array.from({ length: lanes }, worker));
  return results;
}

/** One-line tally for the live trace: what a person needs to know about a batch
 *  at a glance is how many of them worked. */
export function batchSummary(tool: string, results: BatchItemResult[]): string {
  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  return failed
    ? `${tool}: ${ok} of ${results.length} succeeded, ${failed} failed.`
    : `${tool}: all ${results.length} succeeded.`;
}
