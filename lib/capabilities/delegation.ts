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
import { listPersonas } from '@/lib/agent/personas';
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

/** Set by the loop for the duration of a turn, so the capability knows which
 *  counter it is spending against and whether it is already inside a delegate
 *  (in which case delegation is refused — see the depth cap above). */
let activeTurn: { id: string; isDelegate: boolean } | null = null;

export function setDelegationContext(ctx: { id: string; isDelegate: boolean } | null): void {
  activeTurn = ctx;
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
      "Hand ONE specific question to a specialist persona and get their answer back, then carry on with your own work. Use it the moment you hit something outside your depth — an odd number in the spend, a positioning call, a deliverability question — rather than guessing or telling the user to start again. Give the full question and any context they need: they cannot see this conversation. They can read data but cannot take actions that need approval; if they recommend one, propose it yourself.",
    gate: 'read',
    inputSchema: obj({ personaId: S.string, question: S.string, context: S.string }, ['personaId', 'question']),
    zod: z.object({
      personaId: z.string().min(1),
      question: z.string().min(5).max(4000),
      context: z.string().max(8000).optional(),
    }),
    run: async (accountId, a) => {
      // Depth cap. A delegate asking a delegate has no natural floor.
      if (activeTurn?.isDelegate) {
        return { error: 'You are already answering as a specialist and cannot consult another. Answer with what you know.' };
      }
      const turnId = activeTurn?.id;
      if (turnId) {
        const used = counters.get(turnId) ?? 0;
        if (used >= MAX_DELEGATIONS_PER_TURN) {
          return {
            error: `You have already consulted ${MAX_DELEGATIONS_PER_TURN} specialists on this request, which is the limit. Finish the work yourself with what you have, and say what you could not resolve.`,
          };
        }
        counters.set(turnId, used + 1);
      }

      const personas = await listPersonas(accountId);
      const persona = personas.find((p) => p.id === a.personaId && p.enabled && !p.is_coordinator);
      if (!persona) {
        return { error: `No available specialist with id ${a.personaId}. Call listSpecialists for the current roster.` };
      }

      // Imported at call time, not at module load: loop.ts imports the
      // capability registry, so a static import here would close an import
      // cycle through the registry barrel.
      const { runAgent } = await import('@/lib/agent/loop');
      const result = await runAgent({
        accountId,                 // never a different account
        message: a.context ? `${a.question}\n\nContext from the operator:\n${a.context}` : a.question,
        personaId: persona.id,
        maxSteps: DELEGATE_STEPS,
        isDelegate: true,          // blocks further delegation and approvals
      });

      if (result.status === 'needs_approval') {
        // Deliberately NOT executed here. The human is watching the caller's
        // turn, not this sub-run; an approval card raised from inside a
        // delegate would be a decision about work the user never saw proposed.
        return {
          specialist: persona.name,
          answer: `${persona.name} recommends an action that needs your approval rather than something they can do themselves: ${result.message}`,
          recommendsAction: true,
        };
      }
      return {
        specialist: persona.name,
        role: persona.role,
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
