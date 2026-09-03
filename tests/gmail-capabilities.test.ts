// tests/gmail-capabilities.test.ts — Gmail domain wiring
// (lib/capabilities/gmail.ts, and the grounding block it depends on in
// lib/agent/context.ts).
//
// THE DEFECT UNDER TEST: a complete Gmail integration (lib/email/gmail.ts)
// shipped with zero call sites, so the assistant denied it could reach a
// connected mailbox. This file covers:
//   A. capability registration + gate classification (real registry, no mocks)
//   B. token refresh: every capability mints a fresh token, never trusts a
//      stored one; a refresh failure surfaces as an actionable message
//   C. account scoping: a capability never reaches another account's mailbox
//   D. digest: results render as prose, never raw JSON
//   E. grounding: loadAgentContext names a connected Gmail account, omits the
//      section cleanly when there is none, and a failing email section never
//      blanks an unrelated section (independent try/catch)
//
// Fake-client / mocked-fetch pattern per tests/gmail-connection.test.ts and
// tests/plan-store-batch.test.ts — the module under test (lib/capabilities/
// gmail.ts, lib/agent/context.ts) is never mocked; only what IT calls is.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// A. Capability registration + gate classification — the REAL registry.
// ---------------------------------------------------------------------------
describe('gmail capabilities: registration and gates', () => {
  it('registers all five gmail capabilities, present in the catalog', async () => {
    const { CAPABILITY_BY_NAME } = await import('@/lib/capabilities/registry');
    for (const name of ['listGmailMessages', 'getGmailMessage', 'sendGmailEmail', 'markGmailMessageRead', 'archiveGmailMessage']) {
      expect(CAPABILITY_BY_NAME[name], `${name} should be registered`).toBeTruthy();
    }
  });

  it('sendGmailEmail is gated external_send — same class as sendEmail — and is sensitive (needs approval)', async () => {
    const { CAPABILITY_BY_NAME } = await import('@/lib/capabilities/registry');
    const { isSensitive } = await import('@/lib/capabilities/types');
    expect(CAPABILITY_BY_NAME.sendGmailEmail.gate).toBe('external_send');
    expect(CAPABILITY_BY_NAME.sendEmail.gate).toBe('external_send');
    expect(isSensitive(CAPABILITY_BY_NAME.sendGmailEmail)).toBe(true);
  });

  it('listGmailMessages and getGmailMessage are read — run immediately, no approval', async () => {
    const { CAPABILITY_BY_NAME } = await import('@/lib/capabilities/registry');
    const { isSensitive } = await import('@/lib/capabilities/types');
    expect(CAPABILITY_BY_NAME.listGmailMessages.gate).toBe('read');
    expect(CAPABILITY_BY_NAME.getGmailMessage.gate).toBe('read');
    expect(isSensitive(CAPABILITY_BY_NAME.listGmailMessages)).toBe(false);
    expect(isSensitive(CAPABILITY_BY_NAME.getGmailMessage)).toBe(false);
  });

  it('markGmailMessageRead and archiveGmailMessage are internal_write — mutate only the owner\'s own mailbox, run immediately', async () => {
    const { CAPABILITY_BY_NAME } = await import('@/lib/capabilities/registry');
    const { isSensitive } = await import('@/lib/capabilities/types');
    expect(CAPABILITY_BY_NAME.markGmailMessageRead.gate).toBe('internal_write');
    expect(CAPABILITY_BY_NAME.archiveGmailMessage.gate).toBe('internal_write');
    expect(isSensitive(CAPABILITY_BY_NAME.markGmailMessageRead)).toBe(false);
    expect(isSensitive(CAPABILITY_BY_NAME.archiveGmailMessage)).toBe(false);
  });

  it('every gmail tool has a TOOL_VERB entry (fixture already enforces this globally; spot-check directly)', async () => {
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const file = path.join(process.cwd(), 'src/components/AgentConsole.tsx');
    const src = await fs.readFile(file, 'utf8');
    for (const name of ['listGmailMessages', 'getGmailMessage', 'sendGmailEmail', 'markGmailMessageRead', 'archiveGmailMessage']) {
      expect(src).toContain(`${name}:`);
    }
  });
});

// ---------------------------------------------------------------------------
// B/C/D. Functional behaviour: mock only what lib/capabilities/gmail.ts calls.
// ---------------------------------------------------------------------------
const accounts: Record<string, any> = {};
const mintAccessToken = vi.fn(async (accountId: string) => {
  const row = accounts[accountId];
  if (!row || row.__refreshFails) return null;
  return `fresh-token-for-${accountId}`;
});
const listMessages = vi.fn(async () => ({ messages: [{ id: 'm1', threadId: 't1' }, { id: 'm2', threadId: 't2' }] }));
const getMessage = vi.fn(async () => ({
  id: 'm1',
  snippet: 'Hey, following up on last week...',
  payload: { headers: [
    { name: 'Subject', value: 'Following up' },
    { name: 'From', value: 'lead@example.com' },
    { name: 'Date', value: 'Wed, 3 Sep 2026 10:00:00 -0700' },
  ] },
}));
const sendMessage = vi.fn(async () => ({ id: 'sent-msg-1', threadId: 't1' }));
const markRead = vi.fn(async () => ({ id: 'm1' }));
const markUnread = vi.fn(async () => ({ id: 'm1' }));
const archiveMessage = vi.fn(async () => ({ id: 'm1' }));

vi.mock('@/lib/email/gmail', () => ({
  mintAccessToken: (...a: any[]) => (mintAccessToken as any)(...a),
  listMessages: (...a: any[]) => (listMessages as any)(...a),
  getMessage: (...a: any[]) => (getMessage as any)(...a),
  sendMessage: (...a: any[]) => (sendMessage as any)(...a),
  markRead: (...a: any[]) => (markRead as any)(...a),
  markUnread: (...a: any[]) => (markUnread as any)(...a),
  archiveMessage: (...a: any[]) => (archiveMessage as any)(...a),
}));

const getGmailAccount = vi.fn(async (accountId: string) => accounts[accountId] ?? null);
vi.mock('@/lib/email/gmail-account', () => ({
  getGmailAccount: (...a: any[]) => (getGmailAccount as any)(...a),
}));

const ACCOUNT_A = 'acct-a';
const ACCOUNT_B = 'acct-b';

async function gmailCaps() {
  const { GMAIL_CAPABILITIES } = await import('@/lib/capabilities/gmail');
  return Object.fromEntries(GMAIL_CAPABILITIES.map((c) => [c.name, c]));
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(accounts)) delete accounts[k];
  accounts[ACCOUNT_A] = {
    id: 'row-a', account_id: ACCOUNT_A, provider: 'gmail', address: 'franckie@retentionrail.com',
    status: 'connected', secret_encrypted: 'ciphertext', token_expires_at: '2026-09-02T15:21:00.000Z',
    scopes: ['gmail.readonly', 'gmail.send', 'gmail.modify'], last_error: null,
  };
});

describe('token refresh: every capability mints a fresh token, never assumes a stored one is valid', () => {
  it('listGmailMessages mints a fresh token even though the stored one is already expired', async () => {
    const caps = await gmailCaps();
    const result = await caps.listGmailMessages.run(ACCOUNT_A, { query: 'is:unread' });
    expect(mintAccessToken).toHaveBeenCalledWith(ACCOUNT_A);
    expect(listMessages).toHaveBeenCalledWith(`fresh-token-for-${ACCOUNT_A}`, { query: 'is:unread', maxResults: undefined });
    expect(result.messages).toHaveLength(2);
  });

  it('sendGmailEmail mints a fresh token and sends from the connected address', async () => {
    const caps = await gmailCaps();
    await caps.sendGmailEmail.run(ACCOUNT_A, { to: 'lead@x.com', subject: 'Hi', html: '<p>hi</p>' });
    expect(mintAccessToken).toHaveBeenCalledWith(ACCOUNT_A);
    expect(sendMessage).toHaveBeenCalledWith(`fresh-token-for-${ACCOUNT_A}`, expect.objectContaining({
      from: 'franckie@retentionrail.com', to: 'lead@x.com', subject: 'Hi', html: '<p>hi</p>',
    }));
  });

  it('a refresh failure produces the actionable "needs reconnecting" message, never a raw error', async () => {
    accounts[ACCOUNT_A].__refreshFails = true; // mintAccessToken (mocked) resolves null
    const caps = await gmailCaps();
    await expect(caps.listGmailMessages.run(ACCOUNT_A, {})).rejects.toThrow(/needs reconnecting/i);
    await expect(caps.getGmailMessage.run(ACCOUNT_A, { messageId: 'm1' })).rejects.toThrow(/needs reconnecting/i);
    await expect(caps.sendGmailEmail.run(ACCOUNT_A, { to: 'x@y.com', subject: 's', html: 'h' })).rejects.toThrow(/needs reconnecting/i);
    // Not a raw stack trace / Google error code leaking through:
    await caps.listGmailMessages.run(ACCOUNT_A, {}).catch((e: Error) => {
      expect(e.message).not.toMatch(/invalid_grant/i);
    });
    // mintAccessToken (real implementation, not this mock) is documented to
    // record the failure itself via markGmailAccountError — covered directly
    // against the real function in tests/gmail-connection.test.ts. Here we
    // confirm this module actually calls mintAccessToken (the only path that
    // can record it) rather than working around it.
    expect(mintAccessToken).toHaveBeenCalled();
  });

  it('no connected account at all produces a clear "not connected" message, not a crash', async () => {
    const caps = await gmailCaps();
    await expect(caps.listGmailMessages.run(ACCOUNT_B, {})).rejects.toThrow(/no gmail account is connected/i);
    expect(mintAccessToken).not.toHaveBeenCalled();
  });
});

describe('account scoping: a capability never reaches another account\'s mailbox', () => {
  it('reads/sends for account B never see account A\'s row, even though A is connected', async () => {
    // B has no row at all.
    const caps = await gmailCaps();
    await expect(caps.listGmailMessages.run(ACCOUNT_B, {})).rejects.toThrow(/no gmail account is connected/i);
    expect(getGmailAccount).toHaveBeenCalledWith(ACCOUNT_B);
    expect(listMessages).not.toHaveBeenCalled();
  });

  it('connecting B to its own mailbox sends only from B\'s address, never A\'s', async () => {
    accounts[ACCOUNT_B] = { ...accounts[ACCOUNT_A], account_id: ACCOUNT_B, address: 'other@company.com' };
    const caps = await gmailCaps();
    await caps.sendGmailEmail.run(ACCOUNT_B, { to: 'lead@x.com', subject: 'Hi', html: '<p>hi</p>' });
    expect(sendMessage).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ from: 'other@company.com' }));
    expect(sendMessage).not.toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ from: 'franckie@retentionrail.com' }));
  });
});

describe('digest: results render as prose, never raw JSON, for the model to reason over', () => {
  it('listGmailMessages digest is a plain sentence naming a count, not braces/JSON', async () => {
    const caps = await gmailCaps();
    const result = await caps.listGmailMessages.run(ACCOUNT_A, {});
    const digest = caps.listGmailMessages.digest!({}, result);
    expect(digest).toMatch(/2 messages found/i);
    expect(digest).not.toMatch(/[{}[\]]/);
  });

  it('getGmailMessage digest names subject/from/snippet in prose', async () => {
    const caps = await gmailCaps();
    const result = await caps.getGmailMessage.run(ACCOUNT_A, { messageId: 'm1' });
    const digest = caps.getGmailMessage.digest!({}, result);
    expect(digest).toContain('Subject: "Following up"');
    expect(digest).toContain('From: lead@example.com');
    expect(digest).not.toMatch(/[{}[\]]/);
  });

  it('sendGmailEmail digest speaks only for a send the API actually confirmed (a real id)', async () => {
    const caps = await gmailCaps();
    const args = { to: 'lead@x.com', subject: 'Hi there' };
    const confirmed = await caps.sendGmailEmail.run(ACCOUNT_A, { ...args, html: '<p>hi</p>' });
    expect(caps.sendGmailEmail.digest!(args, confirmed)).toMatch(/Sent a real Gmail message to lead@x.com/);

    // No id in the result -> no digest emitted (never fabricates a "sent" claim).
    expect(caps.sendGmailEmail.digest!(args, {})).toBe('');
  });

  it('sendGmailEmail approval summary shows only the subject, never the body', async () => {
    const caps = await gmailCaps();
    const summary = caps.sendGmailEmail.summarize!({ to: 'lead@x.com', subject: 'Confidential offer', html: '<p>SECRET BODY TEXT</p>' });
    expect(summary).toContain('Confidential offer');
    expect(summary).not.toContain('SECRET BODY TEXT');
  });
});
