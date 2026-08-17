// Packet 2.2 — journeys domain. Thin wrappers over lib/journeys/store.ts.
//
// DEVIATION FROM THE PLAN (reported, not silently fixed): the plan lists
// `enrollInJourney` as a capability, but the codebase has no enrollment/
// membership concept for journeys (lib/journeys/store.ts is graph CRUD only
// — no equivalent of lib/sequences.ts's enrollContacts). Adding one would be
// new business logic, which this packet's own rule forbids ("no business
// logic is reimplemented"). Left out; flagged in the packet report.
// `pauseJourney` IS included — it is a thin wrapper around updateJourney's
// existing status patch, not new logic.
import { z } from 'zod';
import { listJourneys, getJourney, createJourney, updateJourney, VALID_TRIGGER } from '@/lib/journeys/store';
import {
  obj, S, type Capability,
  rowsOf, plural, tally, samples, digestLine,
} from './types';

export const JOURNEY_CAPABILITIES: Capability[] = [
  {
    name: 'listJourneys',
    domain: 'journeys',
    title: 'List journeys',
    description: 'List the account\'s journeys (branching automations) with their status.',
    gate: 'read',
    inputSchema: obj({}),
    zod: z.object({}),
    run: (accountId) => listJourneys(accountId),
    digest: (_args, result) => {
      const rows = rowsOf(result);
      if (!rows) return '';
      const byStatus = tally(rows, 'status');
      const names = samples(rows, ['name']);
      return digestLine(
        `${plural(rows.length, 'journey')} returned.`,
        byStatus ? `By status: ${byStatus}.` : null,
        names.length ? `Includes: ${names.join(', ')}.` : null,
      );
    },
  },
  {
    name: 'getJourney',
    domain: 'journeys',
    title: 'Get journey',
    description: 'Get a single journey by id, including its graph and stats.',
    gate: 'read',
    inputSchema: obj({ id: S.string }, ['id']),
    zod: z.object({ id: z.string() }),
    run: (accountId, { id }) => getJourney(accountId, id),
  },
  {
    name: 'createJourney',
    domain: 'journeys',
    title: 'Create journey',
    description: 'Create a new journey (starts as a draft with an empty graph unless one is provided).',
    gate: 'internal_write',
    inputSchema: obj({ name: S.string, description: S.string, trigger: S.string }, ['name']),
    zod: z.object({
      name: z.string(),
      description: z.string().optional(),
      trigger: z.enum(VALID_TRIGGER as unknown as [string, ...string[]]).optional(),
    }),
    run: (accountId, { name, description, trigger }) => createJourney(accountId, { name, description, trigger: trigger as any }),
  },
  {
    name: 'pauseJourney',
    domain: 'journeys',
    title: 'Pause journey',
    description: 'Pause an active journey so it stops advancing contacts through it.',
    gate: 'internal_write',
    inputSchema: obj({ id: S.string }, ['id']),
    zod: z.object({ id: z.string() }),
    run: (accountId, { id }) => updateJourney(accountId, id, { status: 'paused' }),
  },
];
