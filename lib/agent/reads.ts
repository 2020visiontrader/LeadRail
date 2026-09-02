// Several DIFFERENT read-only tools in ONE step.
//
// WHAT WAS IMPOSSIBLE BEFORE. The envelope allows exactly one tool per step.
// `calls` (lib/agent/batch.ts) widened that to one tool over MANY argument
// sets, which is the right shape for "reveal these 25 people" — one decision,
// many rows. It is the wrong shape for "what ventures exist, and what is the
// budget" : two independent facts, two different tools, and under the old
// protocol two whole steps and two whole model round-trips out of a budget of
// MAX_STEPS = 16. A turn that needs four unrelated lookups before it can say
// anything spends a quarter of its budget just gathering.
//
// WHY THIS IS READ-ONLY, AND WILL STAY READ-ONLY. The single-tool path is
// where approval lives: a sensitive tool raises a card, the turn stops, a
// person reads what is about to happen and clicks. A step carrying several
// different tools cannot honour that. Per-tool approvals inside one step mean
// a person approves one thing and gets another — the exact failure the card
// exists to prevent — and one card describing several unrelated actions is a
// card nobody can meaningfully consent to.
//
// So the constraint is structural, not a policy that can be relaxed later:
// EVERY tool named in `reads` must declare `gate: 'read'`. Anything else —
// internal_write, spend, external send, or a tool with no first-party
// capability at all (an external-MCP tool, whose gate is undefined) — is
// refused and NOTHING in the step runs. Fails closed: the gate has to say
// 'read', it is never enough for it to fail to say something worse.

/** Hard cap on one multi-read step.
 *
 *  Small on purpose, and NOT MAX_BATCH (25). A batch is one tool's result
 *  repeated, so 25 of them compress; `reads` folds N DIFFERENT tool results
 *  into ONE step's observation, and the observation budget is what actually
 *  bounds a step. The batch path already treats 4 as the point where a single
 *  step stops being allowed to grow (`Math.min(calls.length, 4)` when scaling
 *  its observation limit) — this reuses that same number rather than inventing
 *  a second one. It is also under BATCH_CONCURRENCY (5), so running the whole
 *  set at once still looks like a client rather than a flood.
 *
 *  Four is also enough: "I need several independent facts before I can answer"
 *  is realistically two or three. */
export const MAX_READS = 4;

export interface ReadCall {
  tool: string;
  args: Record<string, any>;
}

export type ReadsParse =
  | { kind: 'none' }
  | { kind: 'reads'; reads: ReadCall[] }
  /** A hallucinated tool name. Separate from 'invalid' so the loop can route it
   *  through its EXISTING unknown-tool correction (unknownToolObservation +
   *  the MAX_UNKNOWN_TOOLS counter) instead of a second, parallel mechanism
   *  that would let a model guess names forever inside a `reads` array. */
  | { kind: 'unknown'; tool: string }
  | { kind: 'invalid'; reason: string };

export interface ReadsResolver {
  /** Does a tool by this name exist at all this turn (catalog + external MCP)? */
  known: (tool: string) => boolean;
  /** The tool's capability gate class, or undefined when it has no first-party
   *  capability. Undefined is NOT a read — see the header. */
  gateOf: (tool: string) => string | undefined;
}

/**
 * Read a multi-tool step off a parsed envelope.
 *
 * Returns 'none' unless the envelope explicitly says `action:"tools"`, so no
 * existing shape can accidentally take this path. Every rejection carries a
 * reason the model can act on: a step refused with no explanation costs the
 * same round-trip as one that ran.
 */
export function parseReads(parsed: any, resolve: ReadsResolver): ReadsParse {
  if (parsed?.action !== 'tools') return { kind: 'none' };
  const raw = parsed?.reads;
  if (!Array.isArray(raw)) {
    return { kind: 'invalid', reason: 'action:"tools" needs a "reads" array of {"tool":"<name>","args":{...}} entries.' };
  }
  if (!raw.length) {
    return { kind: 'invalid', reason: '"reads" was empty — use action:"tool" for a single call.' };
  }
  if (raw.length > MAX_READS) {
    return {
      kind: 'invalid',
      reason: `A "reads" step may name at most ${MAX_READS} tools; you named ${raw.length}. Do ${MAX_READS} now and the rest in the next step.`,
    };
  }

  const reads: ReadCall[] = [];
  for (const [i, entry] of raw.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { kind: 'invalid', reason: `Entry ${i + 1} of "reads" is not an object with "tool" and "args".` };
    }
    const tool = typeof entry.tool === 'string' ? entry.tool.trim() : '';
    if (!tool) {
      return { kind: 'invalid', reason: `Entry ${i + 1} of "reads" has no "tool" name.` };
    }
    if (entry.calls !== undefined) {
      return {
        kind: 'invalid',
        reason: `Entry ${i + 1} of "reads" carries "calls". Running the SAME tool over many argument sets is action:"tool" with "calls" — "reads" is one entry per DIFFERENT tool.`,
      };
    }
    if (!resolve.known(tool)) return { kind: 'unknown', tool };
    // THE SAFETY PROPERTY. Not `!== 'spend'`, not a deny-list: the gate has to
    // BE 'read'. An unrecognised gate class and a tool with no capability at
    // all both land here and are refused.
    if (resolve.gateOf(tool) !== 'read') {
      return {
        kind: 'invalid',
        reason: `"${tool}" is not a read-only tool, so it cannot go in "reads" — only reads may share a step. Call "${tool}" on its own with action:"tool".`,
      };
    }
    const args = entry.args && typeof entry.args === 'object' && !Array.isArray(entry.args)
      ? (entry.args as Record<string, any>)
      : {};
    reads.push({ tool, args });
  }

  // One entry per tool. Two entries for the same tool is the `calls` shape
  // wearing this one's clothes, and letting it through here would quietly
  // route a batch around MAX_BATCH.
  const dupe = reads.map((r) => r.tool).find((t, i, all) => all.indexOf(t) !== i);
  if (dupe) {
    return {
      kind: 'invalid',
      reason: `"${dupe}" appears twice in "reads". One entry per tool — to run one tool over several inputs use action:"tool" with "calls".`,
    };
  }

  return { kind: 'reads', reads };
}

export interface ReadItemResult {
  index: number;
  tool: string;
  args: Record<string, any>;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Run every read concurrently. No concurrency limiter, unlike runBatch: at
 * most MAX_READS (4) calls exist and they are all different tools, so there is
 * no single third-party limiter to flood.
 *
 * Every read is reported, successes and failures alike, in INPUT order. One
 * failure never cancels the rest — a partial result the model can attribute is
 * far more useful than an exception that discards the reads that worked.
 */
export async function runReads(
  reads: ReadCall[],
  run: (tool: string, args: Record<string, any>) => Promise<{ ok: boolean; result?: unknown; error?: string }>,
): Promise<ReadItemResult[]> {
  return Promise.all(
    reads.map(async (r, index): Promise<ReadItemResult> => {
      try {
        const res = await run(r.tool, r.args);
        return { index, tool: r.tool, args: r.args, ok: res.ok, result: res.result, error: res.error };
      } catch (e: any) {
        // runTool is documented never to throw; a multi-read must not be the
        // place that discovers otherwise and loses its siblings' results.
        return { index, tool: r.tool, args: r.args, ok: false, error: String(e?.message || e).slice(0, 300) };
      }
    }),
  );
}

/** One-line tally for the live trace. Names every tool: the whole point of
 *  folding several tools into one observation is that the model can tell which
 *  result came from which, and the summary line is where that starts. */
export function readsSummary(results: ReadItemResult[]): string {
  return `${results.length} reads — ${results.map((r) => `${r.tool}: ${r.ok ? 'ok' : 'FAILED'}`).join(', ')}.`;
}
