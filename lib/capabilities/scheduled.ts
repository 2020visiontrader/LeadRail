// Packet 2.2 — scheduled tasks domain. Thin wrappers over
// lib/scheduled/store.ts. `disableScheduledTask` wraps updateScheduledTask's
// existing enabled patch rather than adding a new function.
//
// Packet D2: registered now that lib/scheduled/store.ts imports runAgent
// lazily (inside runDueScheduledTasks) instead of at module top level, which
// closes the registry.ts -> scheduled.ts -> store.ts -> agent/loop.ts ->
// agent/tools.ts -> registry.ts cycle that used to leave CAPABILITIES
// undefined under vitest's resetModules()+dynamic-import.
import { z } from 'zod';
import { listScheduledTasks, createScheduledTask, updateScheduledTask } from '@/lib/scheduled/store';
import {
  obj, S, type Capability,
  rowsOf, present, clip, plural, tally, samples, digestLine,
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
    description: 'Create a new scheduled task: a named prompt that runs automatically on an interval (hourly, daily, or weekly), calling the agent with no human reviewing that run. Unlike a social automation, this is created ENABLED by default and starts firing on its own schedule immediately unless enabled:false is passed.',
    // 'standing_rule', not 'internal_write': this creates a rule that runs the
    // full agent loop unattended, repeatedly, forever, with nobody watching a
    // given run unless it happens to propose something sensitive (in which case
    // runDueScheduledTasks halts it and notifies — see lib/scheduled/store.ts).
    // That is exactly the class 2.2-S added standing_rule for: "creates or
    // switches on a rule that will act on its own, repeatedly, with no further
    // human in the loop." createSocialAutomation is standing_rule despite being
    // created disabled-by-default (a second approval is needed to turn it on);
    // createScheduledTask is a STRICTLY stronger case because it defaults to
    // enabled:true — approving this call alone is enough to start the unbounded
    // stream of runs, so gating creation itself, not a later "enable" step, is
    // the only point where a human approval actually exists in the flow.
    gate: 'standing_rule',
    inputSchema: obj({ name: S.string, prompt: S.string, interval: S.string, enabled: { type: 'boolean' } }, ['name', 'prompt', 'interval']),
    zod: z.object({ name: z.string(), prompt: z.string(), interval: z.enum(['hourly', 'daily', 'weekly']), enabled: z.boolean().optional() }),
    run: (accountId, a) => createScheduledTask(accountId, { name: a.name, prompt: a.prompt, interval: a.interval, enabled: a.enabled }),
    summarize: (a) => `Create a scheduled task "${a.name}" that runs automatically on the agent, ${a.interval}, with no one reviewing each run${a.enabled === false ? ' (created OFF — will not run until enabled)' : ' (starts running immediately)'}.`,
    // The strongest evidence of "keeps running after this turn" anywhere in
    // this gate, and it exists only on the RETURN: createScheduledTask
    // (lib/scheduled/store.ts) computes next_run_at itself via computeNextRun
    // and stores it, so the row names a real future moment at which the agent
    // will run this prompt with nobody watching. It is nowhere in the
    // arguments, which is exactly why it is worth stating.
    //
    // `enabled` is likewise the row's (`input.enabled ?? true`), not the
    // argument's. This capability defaults to ARMED, so getting that backwards
    // in the transcript is the difference between a stored draft and an
    // unattended agent loop.
    digest: (_args, result) => {
      const r: any = result;
      if (!r || typeof r !== 'object' || Array.isArray(r) || !present(r, 'id')) return '';
      const id = clip(String(r.id), 60);
      const name = present(r, 'name') ? ` "${clip(String(r.name), 80)}"` : '';
      if (r.enabled !== true) {
        return digestLine(
          `Stored scheduled task ${id}${name}, and the stored row says enabled=false — it will NOT run on its own and nothing happens after this turn until it is enabled.`,
        );
      }
      const every = present(r, 'interval') ? ` ${clip(String(r.interval), 20)},` : '';
      return digestLine(
        `Scheduled task ${id}${name} is stored and ARMED (enabled=true on the row).`,
        `It runs the full agent on this prompt${every} by itself after this turn ends, with nobody reviewing any individual run.`,
        present(r, 'next_run_at')
          ? `The row already names its first unattended run: ${clip(String(r.next_run_at), 40)}.`
          : null,
      );
    },
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
