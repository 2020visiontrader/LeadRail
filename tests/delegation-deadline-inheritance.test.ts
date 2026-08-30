// askSpecialist hands the PARENT turn's deadline down to the sub-run.
//
// REPLACES fan-out coverage. Until the coordinator fan-out was removed,
// runFanoutDelegates was the only path that passed `deadlineAt` into a spawned
// sub-run, and tests/agent-deadline-propagation.test.ts pinned it there. The
// fan-out is gone and askSpecialist is now the only way to spawn a sub-agent —
// and it was NOT passing a deadline, so the guarantee left with the code that
// was deleted.
//
// Why it matters: computeTurnDeadline clamps to whichever is sooner, its own
// default or the value passed in. Without a value, a sub-run spawned with ten
// seconds left on the parent turn still computes a fresh full budget and runs
// past the turn the operator is watching. The 90s AGENT_DELEGATE_BUDGET_MS race
// inside askSpecialist does not cover this: it bounds how long the CALLER
// waits, not how long the sub-run itself is entitled to run.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const runAgent = vi.fn();

vi.mock('@/lib/agent/loop', () => ({ runAgent: (...a: any[]) => runAgent(...a) }));
vi.mock('@/lib/agent/personas', () => ({
  listPersonas: async () => [
    { id: 'p-1', name: 'Nia', role: 'analytics-analyst', enabled: true, is_coordinator: false },
  ],
}));

const FINAL = { status: 'done', message: 'Sub-agent answer.', steps: [] };

async function askSpecialist(args: any, ctx?: any) {
  const { DELEGATION_CAPABILITIES } = await import('@/lib/capabilities/delegation');
  const cap = DELEGATION_CAPABILITIES.find((c) => c.name === 'askSpecialist');
  if (!cap) throw new Error('askSpecialist capability not registered');
  return cap.run('acct-1', args, ctx);
}

beforeEach(() => {
  vi.resetModules();
  runAgent.mockReset();
  runAgent.mockResolvedValue(FINAL);
});

describe('askSpecialist deadline inheritance', () => {
  it('passes the parent deadline through to the sub-run', async () => {
    const deadlineAt = Date.now() + 12_000;
    await askSpecialist({ personaId: 'p-1', question: 'what does this number mean?' }, { deadlineAt });

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(runAgent.mock.calls[0][0].deadlineAt).toBe(deadlineAt);
  });

  it('passes it on the brief-only path too, where there is no persona', async () => {
    const deadlineAt = Date.now() + 8_000;
    await askSpecialist({ question: 'summarize these rows', brief: 'You are checking row counts.' }, { deadlineAt });

    expect(runAgent).toHaveBeenCalledTimes(1);
    const call = runAgent.mock.calls[0][0];
    expect(call.deadlineAt).toBe(deadlineAt);
    expect(call.personaId).toBeUndefined();
  });

  it('still spawns with isDelegate set, so the sub-run cannot delegate or raise approvals', async () => {
    await askSpecialist({ personaId: 'p-1', question: 'a question' }, { deadlineAt: Date.now() + 5_000 });
    expect(runAgent.mock.calls[0][0].isDelegate).toBe(true);
  });

  it('degrades to the sub-run\'s own budget when no context is supplied', async () => {
    // Additive, not required: a caller with no deadline to give must not break.
    await askSpecialist({ personaId: 'p-1', question: 'a question' });
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(runAgent.mock.calls[0][0].deadlineAt).toBeUndefined();
  });
});
