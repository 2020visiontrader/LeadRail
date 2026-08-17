// Durable-memory capabilities (Packet 1.1).
//
// Before this packet, recordFact() in lib/agent/memory.ts had ZERO callers, so
// agent_memory was a table nothing ever wrote and the whole semantic-recall
// layer (recallMemoryDigest / semanticRecall / embeddings) was inert. These
// three capabilities are the ingestion + audit path.
//
// GATE: all three are non-sensitive. They mutate only LeadRail's own memory
// table — no spend, no external send. Marking rememberFact sensitive would
// deadlock the agent loop on an approval card for a harmless internal write.
// forgetFact deletes a single memory row the user asked to be forgotten; it is
// deliberately NOT 'destructive' for the same reason (and the fact is
// re-creatable by simply telling the assistant again).

import { z } from 'zod';
import { recordFact, deleteFact, listFacts, factRejectionReason } from '@/lib/agent/memory';
import {
  obj, S, type Capability,
  rowsOf, plural, samples, digestLine,
} from './types';

export const MEMORY_CAPABILITIES: Capability[] = [
  {
    name: 'rememberFact',
    domain: 'memory',
    title: 'Remember a fact',
    description: 'Save a durable fact about this account, its ventures, preferences, or people, so you recall it in future chats. Use when the user tells you something worth remembering long-term (a preference, a constraint, a decision, who someone is). Do NOT use for one-off task details.',
    gate: 'internal_write',
    inputSchema: obj({ fact: S.string, subject: S.string, predicate: S.string, object: S.string }, ['fact']),
    zod: z.object({
      fact: z.string().min(3).max(500),
      subject: z.string().optional(),
      predicate: z.string().optional(),
      object: z.string().optional(),
    }),
    run: async (accountId, a) => {
      // Ask the same guard recordFact applies, so a rejected fact reports why
      // instead of silently claiming it was remembered. recordFact re-checks —
      // the guard lives at the write, not at the caller.
      const rejected = factRejectionReason(a.fact);
      if (rejected) return { remembered: false, reason: rejected };
      await recordFact(accountId, a);
      return { remembered: a.fact };
    },
  },
  {
    name: 'forgetFact',
    domain: 'memory',
    title: 'Forget a fact',
    description: 'Delete one remembered fact by its id, when the user asks you to forget something or corrects a fact you stored. Call listFacts first to find the id — never guess one.',
    gate: 'internal_write',
    inputSchema: obj({ id: S.string }, ['id']),
    zod: z.object({ id: z.string().min(1) }),
    run: async (accountId, { id }) => {
      const deleted = await deleteFact(accountId, id);
      return { forgotten: deleted, id };
    },
  },
  {
    name: 'listFacts',
    domain: 'memory',
    // Read-only: it mutates nothing, so 'read' rather than 'internal_write'.
    // Either way it is non-sensitive (see SENSITIVE_GATES in ./types).
    title: 'List remembered facts',
    description: 'List the most recent durable facts you have remembered about this account, with their ids. Use when the user asks what you remember about them, or before forgetFact so you have the right id.',
    gate: 'read',
    inputSchema: obj({ limit: S.number }),
    zod: z.object({ limit: z.number().int().min(1).max(100).optional() }),
    run: (accountId, { limit }) => listFacts(accountId, limit),
    // The facts themselves ARE the content here, so the digest quotes a few
    // verbatim rather than describing them. `samples` clips and skips rows that
    // carry no `fact` field, so nothing is invented.
    digest: (_a, result) => {
      const rows = rowsOf(result);
      if (!rows) return '';
      if (!rows.length) return 'Nothing remembered for this account yet.';
      const recent = samples(rows, ['fact'], 3);
      return digestLine(
        `${plural(rows.length, 'remembered fact')}.`,
        recent.length ? `Most recent: ${recent.join(' | ')}` : null,
      );
    },
  },
];
