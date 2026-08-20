// tests/approval-gate.test.ts — BEHAVIOURAL coverage for the approval gate.
//
// Why this file exists
// -------------------
// The platform's defensible claim is not "an agent that can do 99 things"; it
// is "an agent that can do 99 things and cannot do the dangerous ones without a
// human". The second half is enforced in exactly one place, lib/approvals/store.ts,
// and before this file NOTHING tested it. tests/parity.test.ts and
// tests/regressions.test.ts are 31 assertions over static registry metadata:
// they prove every capability is DECLARED with a gate, and never once execute a
// capability, consume an approval, or run the loop. A gate that is declared but
// not enforced looks identical to one that works, right up until it doesn't.
//
// So these tests drive the store directly against an in-memory Postgres stand-in
// (tests/support/fake-supabase.ts) and assert the properties the gate exists to
// guarantee. They are offline and deterministic — including the concurrency
// case, which cannot be tested reliably against a shared live database.
//
// Each test names the failure it prevents in the real world, because a security
// test that does not say what it is defending is the first one deleted when it
// becomes inconvenient.

import { describe, it, expect, beforeEach, vi } from 'vitest';
// vi.mock is hoisted above every import, so the factory cannot close over a
// local. Both sides instead reach the one cached module instance of `db`.
import { db as fake } from './support/fake-supabase';

vi.mock('@/lib/db', async () => {
  const { db } = await import('./support/fake-supabase');
  return { supabase: db.client };
});
// No vault in tests: createApproval then stores args_redacted + args_hash and
// skips args_encrypted, which is the documented degraded path and the one that
// matters here — the HASH is what binds an approval to its payload.
vi.mock('@/lib/ai/crypto', () => ({
  vaultConfigured: () => false,
  encryptSecret: (s: string) => `enc:${s}`,
  decryptSecret: (s: string) => String(s).replace(/^enc:/, ''),
}));

const store = await import('@/lib/approvals/store');
const {
  createApproval, decideApproval, consumeApprovalForExecution,
  hashArgs, redactArgs, expiryForGate, isPastDue,
} = store;

const ACCOUNT = 'acct_alpha';
const OTHER   = 'acct_beta';
const TOOL    = 'sendEmail';
const ARGS    = { to: 'someone@example.com', subject: 'Q3 intro', body: 'Hello.' };

/** A proposal sitting in `approved`, ready to run — the normal pre-execution state. */
async function approved(args: Record<string, any> = ARGS, gate: any = 'external_send') {
  const row = await createApproval(ACCOUNT, {
    tool: TOOL, title: 'Send an email', summary: 'Send one email', args,
    requestedBy: 'user_requester', gate,
  });
  await decideApproval(ACCOUNT, row.id, 'approved', { decidedBy: 'user_reviewer' });
  return row;
}

/** Force a stored approval's expiry into the past without waiting for wall time. */
function backdate(id: string, minutesAgo = 5) {
  const row = fake.tableRows('approvals').find((r: any) => r.id === id);
  if (!row) throw new Error(`backdate: no approval ${id}`);
  row.expires_at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

function stateOf(id: string) {
  return fake.tableRows('approvals').find((r: any) => r.id === id)?.state;
}

beforeEach(() => fake.reset());

describe('single use — an approval authorises exactly one execution', () => {
  it('the first consume succeeds and the second is refused', async () => {
    // Prevents: a retry loop, a double-clicked button, or a replayed transcript
    // sending the same email twice off one human decision.
    const row = await approved();
    await expect(consumeApprovalForExecution(ACCOUNT, row.id, TOOL, ARGS)).resolves.toBeUndefined();
    expect(stateOf(row.id)).toBe('executed');

    await expect(consumeApprovalForExecution(ACCOUNT, row.id, TOOL, ARGS))
      .rejects.toMatchObject({ code: 'already_executed' });
  });

  it('two concurrent consumes produce exactly one execution', async () => {
    // Prevents: two workers racing the same approval and both passing the
    // read-check before either writes. The guard has to be the conditional
    // UPDATE, not an if-statement — this is the test that tells the difference.
    const row = await approved();
    const results = await Promise.allSettled([
      consumeApprovalForExecution(ACCOUNT, row.id, TOOL, ARGS),
      consumeApprovalForExecution(ACCOUNT, row.id, TOOL, ARGS),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(stateOf(row.id)).toBe('executed');
  });
});

describe('payload binding — the approval covers these arguments and no others', () => {
  it('refuses when any argument changed after approval', async () => {
    // Prevents: approving an email to a colleague and executing it against a
    // customer list, without a second human decision.
    const row = await approved();
    await expect(
      consumeApprovalForExecution(ACCOUNT, row.id, TOOL, { ...ARGS, to: 'everyone@example.com' }),
    ).rejects.toMatchObject({ code: 'args_mismatch' });
    expect(stateOf(row.id)).toBe('approved'); // refused, not consumed
  });

  it('refuses when the tool changed but the arguments did not', async () => {
    const row = await approved();
    await expect(consumeApprovalForExecution(ACCOUNT, row.id, 'deleteDeal', ARGS))
      .rejects.toMatchObject({ code: 'args_mismatch' });
  });

  it('accepts the same arguments written in a different key order', async () => {
    // The binding must be semantic, not textual: JSON key order is not a
    // meaningful change, and treating it as one would make the gate flaky and
    // train users to re-approve reflexively.
    const row = await approved();
    const reordered = { body: ARGS.body, to: ARGS.to, subject: ARGS.subject };
    await expect(consumeApprovalForExecution(ACCOUNT, row.id, TOOL, reordered)).resolves.toBeUndefined();
  });

  it('hashes nested objects order-independently too', () => {
    expect(hashArgs({ a: 1, n: { x: 1, y: 2 } })).toBe(hashArgs({ n: { y: 2, x: 1 }, a: 1 }));
    expect(hashArgs({ a: 1 })).not.toBe(hashArgs({ a: 2 }));
  });
});

describe('tenant scoping — an approval belongs to one account', () => {
  it('another account cannot consume it, and it stays runnable for its owner', async () => {
    // Prevents the worst failure available here: cross-tenant execution, where
    // one customer's approval authorises an action inside another's data.
    const row = await approved();
    await expect(consumeApprovalForExecution(OTHER, row.id, TOOL, ARGS))
      .rejects.toMatchObject({ code: 'not_found' });
    expect(stateOf(row.id)).toBe('approved');
    await expect(consumeApprovalForExecution(ACCOUNT, row.id, TOOL, ARGS)).resolves.toBeUndefined();
  });

  it('another account cannot decide it', async () => {
    const row = await createApproval(ACCOUNT, {
      tool: TOOL, title: 'Send an email', summary: 'Send one email', args: ARGS, gate: 'external_send',
    });
    await expect(decideApproval(OTHER, row.id, 'approved', { decidedBy: 'intruder' }))
      .rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('state — only an approved proposal runs', () => {
  it('a pending proposal cannot be executed', async () => {
    // Prevents: the model treating its own proposal as permission.
    const row = await createApproval(ACCOUNT, {
      tool: TOOL, title: 'Send an email', summary: 'Send one email', args: ARGS, gate: 'external_send',
    });
    await expect(consumeApprovalForExecution(ACCOUNT, row.id, TOOL, ARGS))
      .rejects.toMatchObject({ code: 'not_approved' });
  });

  it('a rejected proposal cannot be executed', async () => {
    const row = await createApproval(ACCOUNT, {
      tool: TOOL, title: 'Send an email', summary: 'Send one email', args: ARGS,
      requestedBy: 'user_requester', gate: 'external_send',
    });
    await decideApproval(ACCOUNT, row.id, 'rejected', { decidedBy: 'user_reviewer' });
    await expect(consumeApprovalForExecution(ACCOUNT, row.id, TOOL, ARGS))
      .rejects.toMatchObject({ code: 'not_approved' });
  });

  it('an unknown id is refused', async () => {
    await expect(consumeApprovalForExecution(ACCOUNT, 'ap_nope', TOOL, ARGS))
      .rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('separation of powers — the proposer is not the approver', () => {
  it('the requester cannot approve their own proposal', async () => {
    const row = await createApproval(ACCOUNT, {
      tool: TOOL, title: 'Send an email', summary: 'Send one email', args: ARGS,
      requestedBy: 'user_same', gate: 'external_send',
    });
    await expect(decideApproval(ACCOUNT, row.id, 'approved', { decidedBy: 'user_same' }))
      .rejects.toMatchObject({ code: 'self_approval' });
  });

  it('editing the proposal after it was raised invalidates it', async () => {
    // Prevents: a proposal being reviewed as one thing and approved as another.
    const row = await createApproval(ACCOUNT, {
      tool: TOOL, title: 'Send an email', summary: 'Send one email', args: ARGS,
      requestedBy: 'user_requester', gate: 'external_send',
    });
    await expect(
      decideApproval(ACCOUNT, row.id, 'approved', { decidedBy: 'user_reviewer' }, { ...ARGS, to: 'other@example.com' }),
    ).rejects.toMatchObject({ code: 'invalidated' });
    expect(stateOf(row.id)).toBe('invalidated');
  });

  it('an invalidated proposal cannot then be executed', async () => {
    const row = await createApproval(ACCOUNT, {
      tool: TOOL, title: 'Send an email', summary: 'Send one email', args: ARGS,
      requestedBy: 'user_requester', gate: 'external_send',
    });
    await decideApproval(ACCOUNT, row.id, 'approved', { decidedBy: 'user_reviewer' }, { ...ARGS, to: 'x@example.com' })
      .catch(() => {});
    await expect(consumeApprovalForExecution(ACCOUNT, row.id, TOOL, ARGS))
      .rejects.toMatchObject({ code: 'not_approved' });
  });
});

describe('expiry — authority lapses', () => {
  it('assigns a lifetime scaled to how bad a stale execution would be', () => {
    const ms = (iso: string | null) => (iso ? Date.parse(iso) - Date.now() : 0);
    expect(ms(expiryForGate('destructive'))).toBeLessThan(ms(expiryForGate('spend')));
    expect(ms(expiryForGate('spend'))).toBeLessThan(ms(expiryForGate('external_send')));
    // Gates that never reach the approval path must not acquire a lifetime.
    expect(expiryForGate('read')).toBeNull();
    expect(expiryForGate('internal_write')).toBeNull();
    // An undeclared gate keeps the pre-expiry behaviour rather than inheriting one.
    expect(expiryForGate(undefined)).toBeNull();
  });

  it('a sensitive proposal is born with an expiry', async () => {
    const row = await createApproval(ACCOUNT, {
      tool: TOOL, title: 'Send an email', summary: 'Send one email', args: ARGS, gate: 'external_send',
    });
    expect(row.expires_at).toBeTruthy();
    expect(isPastDue(row.expires_at)).toBe(false);
  });

  it('a lapsed approval cannot be executed, and is marked expired', async () => {
    // THE FAILURE THIS PREVENTS: a user approves an ad launch, the model dies
    // before executing, and a retry fires it weeks later against a budget and a
    // campaign that have both moved on. The args hash cannot catch this — the
    // payload never changed. Only a clock can.
    const row = await approved(ARGS, 'spend');
    backdate(row.id);
    await expect(consumeApprovalForExecution(ACCOUNT, row.id, TOOL, ARGS))
      .rejects.toMatchObject({ code: 'expired' });
    expect(stateOf(row.id)).toBe('expired');
  });

  it('a lapsed proposal cannot be approved into life', async () => {
    const row = await createApproval(ACCOUNT, {
      tool: TOOL, title: 'Send an email', summary: 'Send one email', args: ARGS,
      requestedBy: 'user_requester', gate: 'external_send',
    });
    backdate(row.id);
    await expect(decideApproval(ACCOUNT, row.id, 'approved', { decidedBy: 'user_reviewer' }))
      .rejects.toMatchObject({ code: 'not_pending' });
    expect(stateOf(row.id)).toBe('expired');
  });

  it('expiry never resurrects an already-executed approval', async () => {
    // The flip is conditioned on state='approved', so a terminal row is safe.
    const row = await approved();
    await consumeApprovalForExecution(ACCOUNT, row.id, TOOL, ARGS);
    backdate(row.id);
    await expect(consumeApprovalForExecution(ACCOUNT, row.id, TOOL, ARGS))
      .rejects.toMatchObject({ code: 'already_executed' });
    expect(stateOf(row.id)).toBe('executed');
  });
});

describe('what the operator is shown matches what the gate will do', () => {
  it('a lapsed proposal is listed as expired, not as pending with live buttons', async () => {
    // Nothing sweeps lapsed rows; the flip happens on the decide or consume that
    // notices. Enforcement is fine either way — DISPLAY is not. A dead proposal
    // rendering as pending gives the operator Approve and Reject buttons whose
    // only possible outcome is an error, which teaches them the buttons lie.
    const row = await createApproval(ACCOUNT, {
      tool: TOOL, title: 'Send an email', summary: 'Send one email', args: ARGS,
      requestedBy: 'user_requester', gate: 'external_send',
    });
    backdate(row.id);
    const listed = (await store.listApprovals(ACCOUNT)).find((a: any) => a.id === row.id);
    expect(listed!.state).toBe('expired');
    expect((await store.getApproval(ACCOUNT, row.id))!.state).toBe('expired');
  });

  it('a live proposal is still shown as pending', async () => {
    const row = await createApproval(ACCOUNT, {
      tool: TOOL, title: 'Send an email', summary: 'Send one email', args: ARGS, gate: 'external_send',
    });
    expect((await store.getApproval(ACCOUNT, row.id))!.state).toBe('pending');
  });

  it('an executed approval is never relabelled by a later expiry', async () => {
    const row = await approved();
    await consumeApprovalForExecution(ACCOUNT, row.id, TOOL, ARGS);
    backdate(row.id);
    expect((await store.getApproval(ACCOUNT, row.id))!.state).toBe('executed');
  });
});

describe('secrets never reach the stored display copy', () => {
  it('redacts secret-ish keys at the top level and one level down', () => {
    const out = redactArgs({ to: 'a@b.c', api_key: 'sk-live-123', nested: { authorization: 'Bearer x', name: 'ok' } });
    expect(out.to).toBe('a@b.c');
    expect(out.api_key).toBe('[redacted]');
    expect(out.nested.authorization).toBe('[redacted]');
    expect(out.nested.name).toBe('ok');
  });

  it('a proposal persists redacted args, never the raw secret', async () => {
    const row = await createApproval(ACCOUNT, {
      tool: 'connectProvider', title: 'Connect', summary: 'Connect a provider',
      args: { provider: 'meta', token: 'super-secret-value' }, gate: 'external_send',
    });
    expect(JSON.stringify(row.args_redacted)).not.toContain('super-secret-value');
    expect(row.args_redacted.token).toBe('[redacted]');
  });
});
