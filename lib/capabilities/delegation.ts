// Delegation as a tool the model can reach for.
//
// WHAT WAS WRONG WITH DECIDING IT UP FRONT. Fan-out is currently resolved
// BEFORE the turn runs: resolveCoordinatorFanout() inspects the opening
// message, picks two or three personas, and commits. That is a decision made
// with the least information the turn will ever have — before a single tool
// has run, before anything has been read.
//
// So the case it cannot serve is the ordinary one: the agent pulls the numbers,
// sees something odd in the spend, and *now* wants the media buyer's read. By
// then the fan-out decision is long past, and the only options are to answer
// outside its competence or to tell the user to start again with an @mention.
//
// This makes delegation something the agent DOES rather than something that
// happens to it. It can call for a specialist at the point it discovers it
// needs one, hand over the specific question, and carry the answer back into
// the work in progress.
//
// BOUNDS, and why each one is here rather than trusted to the prompt:
//
//   - A delegate is a bounded sub-run: its own small step budget, its own
//     fresh transcript. It cannot see the caller's conversation, so it cannot
//     be steered by anything already in it.
//   - Depth is capped at one. A delegate cannot itself delegate — without
//     that, "ask the analyst" recursing through a roster is a step-budget
//     bomb with no natural floor.
//   - Per-turn count is capped. The model chooses freely up to the cap and
//     then must do the work itself.
//   - A delegate that proposes a sensitive action does NOT get to run it. The
//     proposal surfaces as text to the caller, which then raises it through
//     the normal approval path. Approval belongs to the turn the human is
//     watching, never to a sub-run they never saw.

import { z } from 'zod';
import { AsyncLocalStorage } from 'node:async_hooks';
import { listPersonas, type PersonaRow } from '@/lib/agent/personas';
import { obj, S, type Capability, rowsOf, plural, samples, digestLine } from './types';

/** How many delegate calls one turn may make. Past this the agent is told to
 *  finish the work itself — the cap is a budget, and the refusal says so. */
const MAX_DELEGATIONS_PER_TURN = 3;

/** A delegate's own step budget. Small on purpose: it is answering ONE narrow
 *  question, not running a turn. */
const DELEGATE_STEPS = 4;

// Per-turn delegation counters, keyed by the caller's turn id. Module-level
// rather than threaded through runTool's signature because runTool is the
// shared entry point for the MCP server too, and this cap is a chat-loop
// concern. Entries are removed by the loop when a turn ends; the size bound
// below is the backstop for a turn that dies without cleaning up.
const counters = new Map<string, number>();
const MAX_TRACKED_TURNS = 256;

export function beginDelegationScope(turnId: string): void {
  if (counters.size > MAX_TRACKED_TURNS) counters.clear();
  counters.set(turnId, 0);
}

export function endDelegationScope(turnId: string): void {
  counters.delete(turnId);
}

/** Which turn is running, and whether IT is itself a delegate — read by
 *  askSpecialist below to enforce the depth cap and per-turn counter.
 *
 *  DEFECT (fixed here): this used to be a MODULE-LEVEL SINGLETON variable —
 *  `let activeTurn`. Sub-runs execute CONCURRENTLY, and whichever one finished
 *  first called setDelegationContext(null) in its `finally`, clearing the
 *  context out from under every other turn still in flight. The depth cap and
 *  the per-turn delegation counter were both unreliable as a direct result: a
 *  still-running delegate could read a null or a SIBLING's context depending
 *  on timing. Reproduced before the fix — see
 *  tests/delegation-context-isolation.test.ts, where the long-running turn read
 *  null after a short concurrent turn finished.
 *
 *  AsyncLocalStorage isolates this correctly: each runAgent/runAgentStream
 *  invocation gets its own async execution context, so two concurrent turns
 *  each setting then clearing no longer interfere. */
type DelegationCtx = { id: string; isDelegate: boolean };
const delegationStorage = new AsyncLocalStorage<DelegationCtx | null>();

export function setDelegationContext(ctx: DelegationCtx | null): void {
  delegationStorage.enterWith(ctx);
}

/** The current turn's delegation context, or null outside any tracked turn.
 *  Exported so the isolation itself can be tested directly, without standing
 *  up the full agent loop — see tests/delegation-context-isolation.test.ts. */
export function getDelegationContext(): DelegationCtx | null {
  return delegationStorage.getStore() ?? null;
}

export const DELEGATION_CAPABILITIES: Capability[] = [
  {
    name: 'listSpecialists',
    domain: 'workspace',
    title: 'List the specialists you can consult',
    description: "List the specialist personas available on this account — each one's name, role and what they are for. Call this when you are unsure who to consult, before askSpecialist.",
    gate: 'read',
    inputSchema: obj({}),
    zod: z.object({}),
    run: async (accountId) => {
      const all = await listPersonas(accountId);
      return all
        .filter((p) => p.enabled && !p.is_coordinator)
        .map((p) => ({ id: p.id, name: p.name, role: p.role, focus: (p.instructions || '').slice(0, 200) }));
    },
    digest: (_a, result) => {
      const rows = rowsOf(result);
      if (!rows) return '';
      if (!rows.length) return 'No specialists are set up on this account — answer it yourself.';
      return digestLine(
        `${plural(rows.length, 'specialist')} available.`,
        rows.map((r: any) => `${r.name}${r.role ? ` (${r.role})` : ''}`).join(', '),
      );
    },
  },
  {
    name: 'askSpecialist',
    domain: 'workspace',
    title: 'Consult a specialist',
    description:
      "Dispatch a bounded sub-agent to work ONE specific question, then get its answer back and carry on with your own work. Use it the moment you hit something outside your depth — an odd number in the spend, a positioning call, a deliverability question, or any side task worth running on its own — rather than guessing or telling the user to start again. Give it a personaId to consult a NAMED specialist in that persona's voice (call listSpecialists for the roster), OR give it a brief — written task instructions — to dispatch a plain sub-agent with no persona framing for a general one-off task. At least one of personaId or brief is required; give both to hand a named specialist extra written instructions. Always include the specific question and any context it needs: it cannot see this conversation. It can read data but cannot take actions that need approval; if it recommends one, propose it yourself.",
    gate: 'read',
    inputSchema: obj({ personaId: S.string, question: S.string, context: S.string, brief: S.string }, ['question']),
    zod: z.object({
      personaId: z.string().min(1).optional(),
      question: z.string().min(5).max(4000),
      context: z.string().max(8000).optional(),
      brief: z.string().min(1).max(4000).optional(),
    }),
    run: async (accountId, a, ctx) => {
      // Depth cap. A delegate asking a delegate has no natural floor.
      const turn = getDelegationContext();
      if (turn?.isDelegate) {
        return { error: 'You are already answering as a specialist and cannot consult another. Answer with what you know.' };
      }
      const turnId = turn?.id;
      if (turnId) {
        const used = counters.get(turnId) ?? 0;
        if (used >= MAX_DELEGATIONS_PER_TURN) {
          return {
            error: `You have already consulted ${MAX_DELEGATIONS_PER_TURN} specialists on this request, which is the limit. Finish the work yourself with what you have, and say what you could not resolve.`,
          };
        }
        counters.set(turnId, used + 1);
      }

      // personaId given -> consult that named specialist, exactly as before.
      // No personaId -> a written brief is required, since a persona-less
      // sub-agent has nothing else to frame the task with.
      let persona: PersonaRow | null = null;
      if (a.personaId) {
        const personas = await listPersonas(accountId);
        persona = personas.find((p) => p.id === a.personaId && p.enabled && !p.is_coordinator) ?? null;
        if (!persona) {
          return { error: `No available specialist with id ${a.personaId}. Call listSpecialists for the current roster.` };
        }
      } else if (!a.brief) {
        return {
          error: 'Provide either personaId (to consult a named specialist — call listSpecialists for the roster) or brief (a written task for a plain sub-agent). Neither was given.',
        };
      }
      const label = persona ? persona.name : 'the sub-agent';

      // Imported at call time, not at module load: loop.ts imports the
      // capability registry, so a static import here would close an import
      // cycle through the registry barrel.
      const { runAgent } = await import('@/lib/agent/loop');

      // A WALL-CLOCK BUDGET, because nothing else bounds this.
      //
      // Individual model calls time out, but a delegate runs its OWN loop of up
      // to DELEGATE_STEPS steps, each of which may take the full model timeout.
      // Multiply that by the specialists a coordinator consults and one turn can
      // sit "thinking" for half an hour with the operator watching a spinner and
      // no way to tell a slow answer from a dead one.
      //
      // On expiry the coordinator is TOLD the specialist did not answer in time
      // rather than being left hanging — an unhelpful observation it can work
      // around beats a turn that never returns.
      const budgetMs = Number(process.env.AGENT_DELEGATE_BUDGET_MS) || 90_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), budgetMs);
      });

      // brief, when given, is prepended ahead of the question — the written
      // task for a persona-less sub-agent, or extra instructions on top of a
      // named specialist's own framing. Unchanged construction (question, then
      // context) when brief is absent, so the personaId-only path is
      // byte-for-byte what it always was.
      const message = [a.brief, a.question, a.context ? `Context from the operator:\n${a.context}` : null]
        .filter(Boolean)
        .join('\n\n');

      const result = await Promise.race([runAgent({
        accountId,                 // never a different account
        message,
        personaId: persona?.id,
        maxSteps: DELEGATE_STEPS,
        isDelegate: true,          // blocks further delegation and approvals
        // Inherit the PARENT turn's deadline rather than computing a fresh full
        // budget down here. computeTurnDeadline clamps to whichever is sooner,
        // so this can only tighten the sub-run, never extend it. budgetMs above
        // is a separate wall clock: it bounds how long the CALLER waits, while
        // this bounds the sub-run itself. Without it a sub-run spawned with 10s
        // left on the parent turn would still run its own full budget.
        deadlineAt: ctx?.deadlineAt,
      }), expired]).finally(() => clearTimeout(timer));

      if (result === 'timeout') {
        return {
          specialist: label,
          error: `${label} did not come back within ${Math.round(budgetMs / 1000)}s and was left to finish on their own. Answer with what you have, and say that you could not get their input in time.`,
        };
      }

      if (result.status === 'needs_approval') {
        // Deliberately NOT executed here. The human is watching the caller's
        // turn, not this sub-run; an approval card raised from inside a
        // delegate would be a decision about work the user never saw proposed.
        return {
          specialist: label,
          answer: `${label} recommends an action that needs your approval rather than something they can do themselves: ${result.message}`,
          recommendsAction: true,
        };
      }
      return {
        specialist: label,
        role: persona?.role,
        answer: result.message,
        status: result.status,
      };
    },
    observationLimit: 12_000,
    digest: (_a, result) => {
      const r: any = result;
      if (r?.error) return digestLine(r.error);
      if (!r?.answer) return '';
      return digestLine(
        `${r.specialist}${r.role ? ` (${r.role})` : ''} says: ${String(r.answer).slice(0, 400)}`,
        r.recommendsAction ? 'They are recommending an action — propose it yourself if you agree.' : null,
      );
    },
  },
];
