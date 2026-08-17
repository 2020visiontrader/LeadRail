// Packet 2.2 — scheduled tasks domain. Thin wrappers over
// lib/scheduled/store.ts. `disableScheduledTask` wraps updateScheduledTask's
// existing enabled patch rather than adding a new function.
//
// NOT REGISTERED (reported, not silently fixed): lib/scheduled/store.ts
// imports `runAgent` from lib/agent/loop.ts at module top level. Wiring this
// file's SCHEDULED_CAPABILITIES into lib/capabilities/registry.ts closes a
// cycle back through lib/agent/tools.ts into the registry itself — reachable
// under vitest's resetModules()+dynamic-import (tests/parity.test.ts), which
// leaves CAPABILITIES undefined mid-import. lib/scheduled/store.ts is not in
// this packet's file list, so it was not modified to break the cycle (e.g.
// a lazy import of runAgent inside runDueScheduledTasks). This file is
// otherwise complete and ready to register once that is fixed.
import { z } from 'zod';
import { listScheduledTasks, createScheduledTask, updateScheduledTask } from '@/lib/scheduled/store';
import {
  obj, S, type Capability,
  rowsOf, plural, tally, samples, digestLine,
} from './types';

export const SCHEDULED_CAPABILITIES: Capability[] = [
  {
    name: 'listScheduledTasks',
    domain: 'scheduled',
    title: 'List scheduled tasks',
    description: 'List the account\'s scheduled tasks (recurring prompts run automatically on an interval) with their status.',
    gate: 'read',
    inputSchema: obj({}),
    zod: z.object({}),
    run: (accountId) => listScheduledTasks(accountId),
    digest: (_args, result) => {
      const rows = rowsOf(result);
      if (!rows) return '';
      const byInterval = tally(rows, 'interval');
      const names = samples(rows, ['name']);
      return digestLine(
        `${plural(rows.length, 'scheduled task')} returned.`,
        byInterval ? `By interval: ${byInterval}.` : null,
        names.length ? `Includes: ${names.join(', ')}.` : null,
      );
    },
  },
  {
    name: 'createScheduledTask',
    domain: 'scheduled',
    title: 'Create scheduled task',
    description: 'Create a new scheduled task: a named prompt that runs automatically on an interval (hourly, daily, or weekly).',
    gate: 'internal_write',
    inputSchema: obj({ name: S.string, prompt: S.string, interval: S.string, enabled: { type: 'boolean' } }, ['name', 'prompt', 'interval']),
    zod: z.object({ name: z.string(), prompt: z.string(), interval: z.enum(['hourly', 'daily', 'weekly']), enabled: z.boolean().optional() }),
    run: (accountId, a) => createScheduledTask(accountId, { name: a.name, prompt: a.prompt, interval: a.interval, enabled: a.enabled }),
  },
  {
    name: 'disableScheduledTask',
    domain: 'scheduled',
    title: 'Disable scheduled task',
    description: 'Turn off a scheduled task so it stops running automatically. It is not deleted and can be re-enabled later.',
    gate: 'internal_write',
    inputSchema: obj({ id: S.string }, ['id']),
    zod: z.object({ id: z.string() }),
    run: (accountId, { id }) => updateScheduledTask(accountId, id, { enabled: false }),
  },
];
