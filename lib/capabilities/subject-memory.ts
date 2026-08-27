// Subject-scoped memory capabilities.
//
// TWO LAYERS, KEPT APART ON PURPOSE.
//
//   DERIVED memory is what the extractor infers from conversations. It can be
//   wrong, so it carries tiers, provenance and an invalidation history.
//
//   DECLARED context is what a person writes down about themselves, their
//   business, their brand: "our ICP is seed-stage B2B", "never use exclamation
//   points", "we cannot make efficacy claims". It is authoritative by
//   construction — there is nothing to infer and nothing to second-guess.
//
// Conflating them is the mistake. Declared context is written as tier-1 edges
// with source 'declared', and writeEdge refuses to let extraction supersede
// one: a person can change what they declared, the machine cannot.
//
// Declared context also solves the cold start. Derived memory is empty until
// conversations have happened — which is exactly why agent_memory has zero rows
// in production today. Declared context works on turn one, which is what makes
// a brand's voice rules available to the very first generation call rather than
// the fiftieth.

import { z } from 'zod';
import { obj, S, type Capability } from './types';
import { writeEdge, activeEdges, beliefHistory, promotionCandidates, promoteEdge, demoteEdge } from '@/lib/memory/edges';
import { projectSubjectWithRetry } from '@/lib/memory/project';
import { TIER2_PROMOTION_THRESHOLD, exclusionFor } from '@/lib/memory/tiers';
import { isSubjectType, SUBJECT_TYPES, type SubjectRef } from '@/lib/memory/types';

const subjectSchema = {
  subjectType: S.string,
  subjectId: S.string,
};

function toRef(a: any): SubjectRef | null {
  if (!isSubjectType(a.subjectType)) return null;
  const id = String(a.subjectId || '').trim();
  if (!id) return null;
  return { type: a.subjectType, id };
}

export const SUBJECT_MEMORY_CAPABILITIES: Capability[] = [
  {
    name: 'declareContext',
    domain: 'memory',
    title: 'Record declared context',
    description:
      'Record something the user states authoritatively about themselves, a brand, or a record — an ICP, a brand voice rule, a compliance constraint, how they work. Use when the user is TELLING you a standing fact, not when you are inferring one. Declared context outranks anything the assistant later infers.',
    // Internal write: it mutates only LeadRail's own memory. Marking it
    // sensitive would stall the loop on an approval card for the user writing
    // down their own preferences.
    gate: 'internal_write',
    inputSchema: obj(
      { ...subjectSchema, predicate: S.string, object: S.string, fact: S.string },
      ['subjectType', 'subjectId', 'fact'],
    ),
    zod: z.object({
      subjectType: z.enum(SUBJECT_TYPES as unknown as [string, ...string[]]),
      subjectId: z.string().min(1),
      predicate: z.string().min(1).max(60).optional(),
      object: z.string().max(300).optional(),
      fact: z.string().min(3).max(500),
    }),
    run: async (accountId, a) => {
      const subject = toRef(a);
      if (!subject) return { declared: false, reason: 'unknown subject' };
      // The exclusion list applies to declared content too. A user typing a
      // card number into a brand note is still a card number in durable memory.
      const excluded = exclusionFor({ subject, predicate: a.predicate || 'declared', object: a.object || '', fact: a.fact });
      if (excluded) return { declared: false, reason: `not stored (${excluded})` };
      const res = await writeEdge({
        accountId, subject,
        predicate: (a.predicate || 'declared').toLowerCase().trim(),
        object: a.object || a.fact,
        fact: a.fact,
        tier: 1,
        source: 'declared',
      });
      if (res.outcome === 'failed') return { declared: false, reason: 'write failed' };
      await projectSubjectWithRetry(accountId, subject);
      return { declared: a.fact, supersededPrevious: Boolean(res.supersededEdgeId) };
    },
  },
  {
    name: 'recallSubject',
    domain: 'memory',
    title: 'Recall what is known about a record',
    description:
      'Read everything currently known about one contact, company, deal, campaign, segment or brand. Use before acting on a record when the conversation has not already told you about it.',
    gate: 'read',
    inputSchema: obj(subjectSchema, ['subjectType', 'subjectId']),
    zod: z.object({
      subjectType: z.enum(SUBJECT_TYPES as unknown as [string, ...string[]]),
      subjectId: z.string().min(1),
    }),
    run: async (accountId, a) => {
      const subject = toRef(a);
      if (!subject) return { facts: [] };
      const edges = await activeEdges(accountId, subject);
      return {
        subject: `${subject.type}:${subject.id}`,
        facts: edges.map((e) => ({
          fact: e.fact,
          status: e.tier === 1 ? 'established' : 'observed',
          since: e.validFrom?.slice(0, 10) ?? null,
          timesSeen: e.occurrences,
        })),
      };
    },
    // A null result means the tool did not return — not that the record is
    // empty. Only a REAL result may say "nothing on record".
    digest: (_a, r: any) => {
      if (!r) return '';
      return r.facts?.length ? `${r.facts.length} fact(s) on record for ${r.subject}.` : 'Nothing on record yet.';
    },
  },
  {
    name: 'recallHistory',
    domain: 'memory',
    title: 'What did we believe, and when',
    description:
      'Show how one thing about a record changed over time — every value ever held for a property, including superseded ones, with the dates they were true. Use when the user asks what changed, or why an earlier decision was made.',
    gate: 'read',
    inputSchema: obj({ ...subjectSchema, predicate: S.string }, ['subjectType', 'subjectId', 'predicate']),
    zod: z.object({
      subjectType: z.enum(SUBJECT_TYPES as unknown as [string, ...string[]]),
      subjectId: z.string().min(1),
      predicate: z.string().min(1),
    }),
    run: async (accountId, a) => {
      const subject = toRef(a);
      if (!subject) return { history: [] };
      const edges = await beliefHistory(accountId, subject, a.predicate.toLowerCase().trim());
      return {
        history: edges.map((e) => ({
          value: e.object,
          fact: e.fact,
          from: e.validFrom?.slice(0, 10) ?? null,
          until: e.invalidAt ? e.invalidAt.slice(0, 10) : 'still true',
        })),
      };
    },
  },
  {
    name: 'promoteObservation',
    domain: 'memory',
    title: 'Approve a pattern as a rule',
    description:
      'Turn an observed pattern into something the assistant may act on by itself. Use ONLY when the user explicitly approves a specific observation — never to tidy up the queue, and never on your own reading of the evidence. Call listObservedPatterns first to get the id.',
    // `standing_rule`, and this is the whole point: it creates something that
    // later runs WITHOUT a human in the loop, so it raises an approval card
    // rather than executing. That is the promotion gate — not a separate
    // mechanism, the one the platform already has.
    //
    // Deliberately NOT grantable for a session either (GRANTABLE_GATES in
    // lib/approvals/grants.ts excludes standing_rule): a blanket "approve all
    // promotions this chat" would be precisely the compounding failure the
    // tier split exists to prevent.
    gate: 'standing_rule',
    inputSchema: obj({ observationId: S.string }, ['observationId']),
    zod: z.object({ observationId: z.string().min(1) }),
    run: async (accountId, a, ctx?: any) => {
      const res = await promoteEdge(accountId, a.observationId, ctx?.requestedBy || 'unknown');
      if (!res.promoted) return { promoted: false, reason: res.reason };
      return {
        promoted: true,
        fact: res.fact,
        note: 'The assistant may now act on this. Ask it to stop at any time and it becomes an observation again.',
      };
    },
    summarize: (a: any) =>
      `Make an observed pattern into a standing rule. From now on the assistant will act on it on its own, in every future campaign, until you withdraw it.`,
  },
  {
    name: 'demoteObservation',
    domain: 'memory',
    title: 'Stop acting on a pattern',
    description:
      'Withdraw a pattern the assistant was allowed to act on, returning it to a mere observation. Use the moment the user says to stop relying on something.',
    // Never sensitive: withdrawing the system's permission to act must not
    // itself wait on permission.
    gate: 'internal_write',
    inputSchema: obj({ observationId: S.string }, ['observationId']),
    zod: z.object({ observationId: z.string().min(1) }),
    run: async (accountId, a) => ({ demoted: await demoteEdge(accountId, a.observationId) }),
    digest: (_a, r: any) => {
      if (!r) return '';
      return r.demoted ? 'That is an observation again — I will not act on it.' : 'Nothing to withdraw.';
    },
  },
  {
    name: 'listObservedPatterns',
    domain: 'memory',
    title: 'List observed patterns awaiting review',
    description:
      'List patterns the system has observed repeatedly but which have NOT been approved as rules. Use when the user asks what the assistant has noticed, or what is waiting for their sign-off.',
    gate: 'read',
    inputSchema: obj({}, []),
    zod: z.object({}),
    run: async (accountId) => {
      const rows = await promotionCandidates(accountId, TIER2_PROMOTION_THRESHOLD);
      return {
        threshold: TIER2_PROMOTION_THRESHOLD,
        // Named to make the status unmistakable to the model: these are NOT
        // rules, and nothing here may be acted on as if it were.
        awaitingApproval: rows.map((e) => ({
          // The id is what makes the queue actionable — without it the list is
          // something to read and nothing to do.
          observationId: e.id,
          observation: e.fact,
          subject: `${e.subjectType}:${e.subjectId}`,
          timesSeen: e.occurrences,
          status: 'observed — not approved, do not act on this as a rule',
        })),
      };
    },
    digest: (_a, r: any) => {
      if (!r) return '';
      return r.awaitingApproval?.length
        ? `${r.awaitingApproval.length} observed pattern(s) awaiting your approval before they can be acted on.`
        : 'No patterns awaiting review.';
    },
  },
];
