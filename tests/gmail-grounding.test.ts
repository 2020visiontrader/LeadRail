// tests/gmail-grounding.test.ts — the CONNECTED EMAIL ACCOUNTS section added
// to lib/agent/context.ts's loadAgentContext(). See tests/gmail-capabilities.test.ts
// for the capability-side coverage of the same packet.
//
// THE DEFECT: asked whether it could reach the owner's Gmail, the model
// answered "no" with zero tool calls — nothing in its per-turn context said a
// mailbox was connected. This section is the fix; these tests pin that it
// actually appears, actually reflects account health, is cleanly omitted when
// there is no connection, and — like every other section in context.ts —
// degrades independently: a failure in it must never blank an unrelated
// section (venture grounding here, standing in for the others).
//
// Every dependency loadAgentContext touches is mocked except the module under
// test (lib/agent/context.ts) itself — same discipline as
// tests/gmail-connection.test.ts and tests/plan-store-batch.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getGmailAccount = vi.fn(async (_accountId: string) => null as any);
vi.mock('@/lib/email/gmail-account', () => ({
  getGmailAccount: (...a: any[]) => (getGmailAccount as any)(...a),
}));

vi.mock('@/lib/db', () => ({
  supabase: { from: () => { throw new Error('snapshot section intentionally unavailable in this test'); } },
  getConnections: async () => { throw new Error('social section intentionally unavailable in this test'); },
}));
vi.mock('@/lib/social/providers', () => ({ LIVE_SOCIALS: [] }));
vi.mock('@/lib/ai/venture-context', () => ({
  loadVentureContext: async (_brandId: string) => ({ name: 'Retention Rail', pitch: 'Win back churned customers.' }),
}));
vi.mock('@/lib/documents/attachments', () => ({
  listAttachments: async () => [],
  attachmentsByIds: async () => [],
  attachmentContextBlock: () => '',
}));
vi.mock('@/lib/agent/memory', () => ({ recallMemoryDigest: async () => '' }));
vi.mock('@/lib/memory/resolve', () => ({ resolveSubjects: async () => [] }));
vi.mock('@/lib/memory/project', () => ({ loadSubjectMemory: async () => null }));
vi.mock('@/lib/plans/store', () => ({ activePlanForConversation: async () => null, renderPlan: () => '' }));
vi.mock('@/lib/outreach/history', () => ({
  getOutreachHistory: async () => { throw new Error('outbox intentionally unavailable in this test'); },
  renderOutboxBlock: () => '',
}));

const ACCOUNT_A = 'acct-a';

beforeEach(() => {
  vi.clearAllMocks();
  getGmailAccount.mockResolvedValue(null);
});

async function ctx() { return import('@/lib/agent/context'); }

describe('CONNECTED EMAIL ACCOUNTS grounding', () => {
  it('names a connected, healthy gmail account by address', async () => {
    getGmailAccount.mockResolvedValue({
      id: 'row-1', account_id: ACCOUNT_A, provider: 'gmail', address: 'franckie@retentionrail.com',
      status: 'connected', last_error: null,
    });
    const { loadAgentContext } = await ctx();
    const block = await loadAgentContext({ accountId: ACCOUNT_A, brandId: 'b1' });
    expect(block).toContain('CONNECTED EMAIL ACCOUNTS');
    expect(block).toContain('franckie@retentionrail.com');
    expect(block).toMatch(/gmail: franckie@retentionrail\.com \(connected\)/i);
  });

  it('is omitted entirely when there is no connected gmail account', async () => {
    getGmailAccount.mockResolvedValue(null);
    const { loadAgentContext } = await ctx();
    const block = await loadAgentContext({ accountId: ACCOUNT_A, brandId: 'b1' });
    expect(block).not.toContain('CONNECTED EMAIL ACCOUNTS');
    expect(block).not.toContain('gmail');
  });

  it('is omitted when the account was disconnected (never claims a stale connection)', async () => {
    getGmailAccount.mockResolvedValue({
      id: 'row-1', account_id: ACCOUNT_A, provider: 'gmail', address: 'old@x.com',
      status: 'disconnected', last_error: null,
    });
    const { loadAgentContext } = await ctx();
    const block = await loadAgentContext({ accountId: ACCOUNT_A, brandId: 'b1' });
    expect(block).not.toContain('CONNECTED EMAIL ACCOUNTS');
  });

  it('states an errored connection as needing reconnecting, not as usable', async () => {
    getGmailAccount.mockResolvedValue({
      id: 'row-1', account_id: ACCOUNT_A, provider: 'gmail', address: 'franckie@retentionrail.com',
      status: 'error', last_error: 'Gmail token refresh failed: invalid_grant',
    });
    const { loadAgentContext } = await ctx();
    const block = await loadAgentContext({ accountId: ACCOUNT_A, brandId: 'b1' });
    expect(block).toContain('CONNECTED EMAIL ACCOUNTS');
    expect(block).toMatch(/needs reconnecting/i);
  });

  it('a failing email section (getGmailAccount throws) never blanks an unrelated section', async () => {
    getGmailAccount.mockRejectedValue(new Error('boom: db unreachable'));
    const { loadAgentContext } = await ctx();
    const block = await loadAgentContext({ accountId: ACCOUNT_A, brandId: 'b1' });
    expect(block).not.toContain('CONNECTED EMAIL ACCOUNTS');
    // The venture section (an independent try/catch) is unaffected.
    expect(block).toContain('Retention Rail');
  });
});
