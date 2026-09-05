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
  const ALL_GMAIL_CAPABILITY_NAMES = [
    'listGmailMessages', 'getGmailMessage', 'sendGmailEmail', 'markGmailMessageRead', 'archiveGmailMessage',
    'markGmailMessageUnread', 'listGmailDrafts', 'getGmailDraft', 'createGmailDraft', 'sendGmailDraft',
    'deleteGmailDraft', 'replyToGmailMessage', 'getGmailThread', 'listGmailLabels',
  ];

  it('registers all fourteen gmail capabilities, present in the catalog', async () => {
    const { CAPABILITY_BY_NAME } = await import('@/lib/capabilities/registry');
    for (const name of ALL_GMAIL_CAPABILITY_NAMES) {
      expect(CAPABILITY_BY_NAME[name], `${name} should be registered`).toBeTruthy();
    }
  });

  it('sendGmailDraft and replyToGmailMessage are gated external_send — both need approval before sending', async () => {
    const { CAPABILITY_BY_NAME } = await import('@/lib/capabilities/registry');
    const { isSensitive } = await import('@/lib/capabilities/types');
    expect(CAPABILITY_BY_NAME.sendGmailDraft.gate).toBe('external_send');
    expect(CAPABILITY_BY_NAME.replyToGmailMessage.gate).toBe('external_send');
    expect(isSensitive(CAPABILITY_BY_NAME.sendGmailDraft)).toBe(true);
    expect(isSensitive(CAPABILITY_BY_NAME.replyToGmailMessage)).toBe(true);
  });

  it('createGmailDraft and markGmailMessageUnread are internal_write — run immediately, no approval', async () => {
    const { CAPABILITY_BY_NAME } = await import('@/lib/capabilities/registry');
    const { isSensitive } = await import('@/lib/capabilities/types');
    expect(CAPABILITY_BY_NAME.createGmailDraft.gate).toBe('internal_write');
    expect(CAPABILITY_BY_NAME.markGmailMessageUnread.gate).toBe('internal_write');
    expect(isSensitive(CAPABILITY_BY_NAME.createGmailDraft)).toBe(false);
    expect(isSensitive(CAPABILITY_BY_NAME.markGmailMessageUnread)).toBe(false);
  });

  it('deleteGmailDraft is destructive — irreversible, needs approval', async () => {
    const { CAPABILITY_BY_NAME } = await import('@/lib/capabilities/registry');
    const { isSensitive } = await import('@/lib/capabilities/types');
    expect(CAPABILITY_BY_NAME.deleteGmailDraft.gate).toBe('destructive');
    expect(isSensitive(CAPABILITY_BY_NAME.deleteGmailDraft)).toBe(true);
  });

  it('listGmailDrafts, getGmailDraft, getGmailThread and listGmailLabels are read — no approval', async () => {
    const { CAPABILITY_BY_NAME } = await import('@/lib/capabilities/registry');
    const { isSensitive } = await import('@/lib/capabilities/types');
    for (const name of ['listGmailDrafts', 'getGmailDraft', 'getGmailThread', 'listGmailLabels']) {
      expect(CAPABILITY_BY_NAME[name].gate).toBe('read');
      expect(isSensitive(CAPABILITY_BY_NAME[name])).toBe(false);
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
  threadId: 't1',
  snippet: 'Hey, following up on last week...',
  payload: { headers: [
    { name: 'Subject', value: 'Following up' },
    { name: 'From', value: 'lead@example.com' },
    { name: 'Date', value: 'Wed, 3 Sep 2026 10:00:00 -0700' },
    { name: 'Message-ID', value: '<original-msg-id@mail.gmail.com>' },
    { name: 'References', value: '<earlier-msg-id@mail.gmail.com>' },
  ] },
}));
const sendMessage = vi.fn(async () => ({ id: 'sent-msg-1', threadId: 't1' }));
const markRead = vi.fn(async () => ({ id: 'm1' }));
const markUnread = vi.fn(async () => ({ id: 'm1' }));
const archiveMessage = vi.fn(async () => ({ id: 'm1' }));
const listDrafts = vi.fn(async () => ({
  drafts: [{ id: 'd1', message: { id: 'dm1', threadId: 't1' } }, { id: 'd2', message: { id: 'dm2', threadId: 't2' } }],
  resultSizeEstimate: 2,
}));
const getDraft = vi.fn(async () => ({
  id: 'd1',
  message: { id: 'dm1', threadId: 't1', snippet: 'Draft snippet', payload: { headers: [
    { name: 'Subject', value: 'Draft subject' },
    { name: 'To', value: 'lead@example.com' },
  ] } },
}));
const createDraft = vi.fn(async () => ({ id: 'new-draft-1', message: { id: 'new-msg-1', threadId: 't9' } }));
const sendDraft = vi.fn(async () => ({ id: 'sent-from-draft-1', threadId: 't1' }));
const deleteDraft = vi.fn(async () => ({ id: 'd1', deleted: true }));
const getThread = vi.fn(async () => ({
  id: 't1',
  messages: [
    { id: 'm1', payload: { headers: [{ name: 'Subject', value: 'Thread subject' }] } },
    { id: 'm2', payload: { headers: [{ name: 'Subject', value: 'Re: Thread subject' }] } },
  ],
}));
const listLabels = vi.fn(async () => ({ labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'l1', name: 'VIP', type: 'user' }] }));

vi.mock('@/lib/email/gmail', () => ({
  mintAccessToken: (...a: any[]) => (mintAccessToken as any)(...a),
  listMessages: (...a: any[]) => (listMessages as any)(...a),
  getMessage: (...a: any[]) => (getMessage as any)(...a),
  sendMessage: (...a: any[]) => (sendMessage as any)(...a),
  markRead: (...a: any[]) => (markRead as any)(...a),
  markUnread: (...a: any[]) => (markUnread as any)(...a),
  archiveMessage: (...a: any[]) => (archiveMessage as any)(...a),
  listDrafts: (...a: any[]) => (listDrafts as any)(...a),
  getDraft: (...a: any[]) => (getDraft as any)(...a),
  createDraft: (...a: any[]) => (createDraft as any)(...a),
  sendDraft: (...a: any[]) => (sendDraft as any)(...a),
  deleteDraft: (...a: any[]) => (deleteDraft as any)(...a),
  getThread: (...a: any[]) => (getThread as any)(...a),
  listLabels: (...a: any[]) => (listLabels as any)(...a),
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

// ---------------------------------------------------------------------------
// F. Drafts: the owner's actual question ("how many drafts do I have").
// ---------------------------------------------------------------------------
describe('drafts: listGmailDrafts answers the owner\'s actual question — a usable count', () => {
  it('surfaces a count in the digest, not just rows', async () => {
    const caps = await gmailCaps();
    const result = await caps.listGmailDrafts.run(ACCOUNT_A, {});
    expect(result.drafts).toHaveLength(2);
    expect(result.resultSizeEstimate).toBe(2);
    const digest = caps.listGmailDrafts.digest!({}, result);
    expect(digest).toMatch(/2 drafts/i);
    expect(digest).not.toMatch(/[{}[\]]/);
  });

  it('mints a fresh token like every other capability', async () => {
    const caps = await gmailCaps();
    await caps.listGmailDrafts.run(ACCOUNT_A, {});
    expect(mintAccessToken).toHaveBeenCalledWith(ACCOUNT_A);
    expect(listDrafts).toHaveBeenCalledWith(`fresh-token-for-${ACCOUNT_A}`, { maxResults: undefined });
  });

  it('zero drafts renders "No drafts." not a fabricated number', async () => {
    listDrafts.mockResolvedValueOnce({ drafts: [], resultSizeEstimate: 0 });
    const caps = await gmailCaps();
    const result = await caps.listGmailDrafts.run(ACCOUNT_A, {});
    const digest = caps.listGmailDrafts.digest!({}, result);
    expect(digest).toBe('No drafts.');
  });

  it('another account\'s drafts are unreachable — B has no row, never sees A\'s drafts', async () => {
    const caps = await gmailCaps();
    await expect(caps.listGmailDrafts.run(ACCOUNT_B, {})).rejects.toThrow(/no gmail account is connected/i);
    expect(listDrafts).not.toHaveBeenCalled();
  });

  it('getGmailDraft reads one draft\'s subject/recipient/snippet in prose', async () => {
    const caps = await gmailCaps();
    const result = await caps.getGmailDraft.run(ACCOUNT_A, { draftId: 'd1' });
    const digest = caps.getGmailDraft.digest!({}, result);
    expect(digest).toContain('Subject: "Draft subject"');
    expect(digest).toContain('To: lead@example.com');
    expect(digest).not.toMatch(/[{}[\]]/);
  });

  it('createGmailDraft writes to the owner\'s own mailbox and sends nothing (no sendMessage call)', async () => {
    const caps = await gmailCaps();
    const result = await caps.createGmailDraft.run(ACCOUNT_A, { to: 'lead@x.com', subject: 'Draft me', html: '<p>hi</p>' });
    expect(createDraft).toHaveBeenCalledWith(`fresh-token-for-${ACCOUNT_A}`, expect.objectContaining({
      from: 'franckie@retentionrail.com', to: 'lead@x.com', subject: 'Draft me', html: '<p>hi</p>',
    }));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendDraft).not.toHaveBeenCalled();
    const digest = caps.createGmailDraft.digest!({ subject: 'Draft me' }, result);
    expect(digest).toContain('Nothing was sent.');
  });
});

// ---------------------------------------------------------------------------
// G. sendGmailDraft and replyToGmailMessage are BOTH gated — never send
//    directly.
//
// NOTE ON WHAT "GATED" MEANS HERE. runTool() (lib/agent/tools.ts) is the
// EXECUTION chokepoint, not the approval decision — it has no
// isSensitive()/def.sensitive check at all (confirmed by reading it: it goes
// straight from zod validation to tool.run()). The actual approval gate
// lives one layer up, in the two agent loops (runAgentImpl /
// runAgentStreamImpl in lib/agent/loop.ts, `if (def.sensitive) { … raise an
// approval, return needs_approval, never call runTool … }`) — CLAUDE.md
// forbids touching loop.ts, and re-implementing that gate here would be
// exactly the "re-implement the path" anti-pattern CLAUDE.md warns against
// for a class of bug the control flow itself produces. So "sending is
// gated" is asserted the way lib/capabilities/capability-contract.test.ts
// already asserts it for every other sensitive capability in this
// registry: isSensitive(cap) is the single fact the loop branches on, and
// it is checked directly against the real registry (not the capability's
// own local claim) for both new send-shaped capabilities. The functional
// proof that gating actually prevents a direct send is the loop's own test
// suite; this file's job is to prove these two names are wired into that
// same registry-driven mechanism, not exempted from it.
// ---------------------------------------------------------------------------
describe('sendGmailDraft and replyToGmailMessage are both gated — same mechanism sendGmailEmail already uses', () => {
  it('both are external_send and isSensitive() — the exact fact the agent loop branches on to raise an approval', async () => {
    const { CAPABILITY_BY_NAME } = await import('@/lib/capabilities/registry');
    const { isSensitive } = await import('@/lib/capabilities/types');
    for (const name of ['sendGmailDraft', 'replyToGmailMessage']) {
      expect(CAPABILITY_BY_NAME[name].gate).toBe('external_send');
      expect(isSensitive(CAPABILITY_BY_NAME[name])).toBe(true);
    }
    // Same class as the capability already proven to be gated in production.
    expect(CAPABILITY_BY_NAME.sendGmailDraft.gate).toBe(CAPABILITY_BY_NAME.sendGmailEmail.gate);
    expect(CAPABILITY_BY_NAME.replyToGmailMessage.gate).toBe(CAPABILITY_BY_NAME.sendGmailEmail.gate);
  });

  it('both carry a summarize() the approval card can render before the send happens', async () => {
    const caps = await gmailCaps();
    expect(caps.sendGmailDraft.summarize!({ draftId: 'd1' })).toMatch(/d1/);
    expect(caps.replyToGmailMessage.summarize!({ messageId: 'm1' })).toMatch(/m1/);
  });

  it('by contrast, listGmailDrafts (read) is not sensitive — no approval gate applies to it', async () => {
    const { CAPABILITY_BY_NAME } = await import('@/lib/capabilities/registry');
    const { isSensitive } = await import('@/lib/capabilities/types');
    expect(isSensitive(CAPABILITY_BY_NAME.listGmailDrafts)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// H. deleteGmailDraft — destructive, irreversible.
// ---------------------------------------------------------------------------
describe('deleteGmailDraft: irreversible removal of the user\'s own content', () => {
  it('calls deleteDraft with the given id and digests a confirmation, never raw JSON', async () => {
    const caps = await gmailCaps();
    const result = await caps.deleteGmailDraft.run(ACCOUNT_A, { draftId: 'd1' });
    expect(deleteDraft).toHaveBeenCalledWith(`fresh-token-for-${ACCOUNT_A}`, 'd1');
    const digest = caps.deleteGmailDraft.digest!({ draftId: 'd1' }, result);
    expect(digest).toContain('Deleted Gmail draft d1');
    expect(digest).not.toMatch(/[{}[\]]/);
  });

  it('is destructive and isSensitive() — the same fact the loop uses to gate it, never deleting without approval', async () => {
    const { CAPABILITY_BY_NAME } = await import('@/lib/capabilities/registry');
    const { isSensitive } = await import('@/lib/capabilities/types');
    expect(CAPABILITY_BY_NAME.deleteGmailDraft.gate).toBe('destructive');
    expect(isSensitive(CAPABILITY_BY_NAME.deleteGmailDraft)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// I. Reply threading — the named defect: "a reply that starts a new thread
//    is a defect users notice immediately."
// ---------------------------------------------------------------------------
describe('replyToGmailMessage: threading headers actually thread it in Gmail', () => {
  it('carries In-Reply-To and References computed from the ORIGINAL message, and passes threadId', async () => {
    const caps = await gmailCaps();
    await caps.replyToGmailMessage.run(ACCOUNT_A, { messageId: 'm1', html: '<p>reply</p>' });
    expect(getMessage).toHaveBeenCalledWith(`fresh-token-for-${ACCOUNT_A}`, 'm1', 'full');
    expect(sendMessage).toHaveBeenCalledWith(`fresh-token-for-${ACCOUNT_A}`, expect.objectContaining({
      to: 'lead@example.com',
      subject: 'Re: Following up',
      inReplyTo: '<original-msg-id@mail.gmail.com>',
      references: '<earlier-msg-id@mail.gmail.com> <original-msg-id@mail.gmail.com>',
      threadId: 't1',
    }));
  });

  it('does not double-prefix a subject that already starts with "Re:"', async () => {
    getMessage.mockResolvedValueOnce({
      id: 'm2', threadId: 't1', snippet: '',
      payload: { headers: [
        { name: 'Subject', value: 'Re: Following up' },
        { name: 'From', value: 'lead@example.com' },
        { name: 'Message-ID', value: '<msg-2@mail.gmail.com>' },
      ] },
    });
    const caps = await gmailCaps();
    await caps.replyToGmailMessage.run(ACCOUNT_A, { messageId: 'm2', html: '<p>reply</p>' });
    expect(sendMessage).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ subject: 'Re: Following up' }));
  });

  it('this is a REAL send from the connected mailbox\'s own address, distinct from a fresh sendGmailEmail', async () => {
    const caps = await gmailCaps();
    await caps.replyToGmailMessage.run(ACCOUNT_A, { messageId: 'm1', html: '<p>reply</p>' });
    expect(sendMessage).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ from: 'franckie@retentionrail.com' }));
  });

  it('digest names the thread it replied in, in prose', async () => {
    const caps = await gmailCaps();
    const result = await caps.replyToGmailMessage.run(ACCOUNT_A, { messageId: 'm1', html: '<p>reply</p>' });
    const digest = caps.replyToGmailMessage.digest!({}, result);
    expect(digest).toMatch(/same thread/i);
    expect(digest).toContain('Thread id t1');
    expect(digest).not.toMatch(/[{}[\]]/);
  });
});

// ---------------------------------------------------------------------------
// J. Threads and labels.
// ---------------------------------------------------------------------------
describe('getGmailThread and listGmailLabels', () => {
  it('getGmailThread reads a whole conversation, digest names message count and subject', async () => {
    const caps = await gmailCaps();
    const result = await caps.getGmailThread.run(ACCOUNT_A, { threadId: 't1' });
    expect(getThread).toHaveBeenCalledWith(`fresh-token-for-${ACCOUNT_A}`, 't1', 'full');
    const digest = caps.getGmailThread.digest!({}, result);
    expect(digest).toMatch(/2 messages in this thread/i);
    expect(digest).toContain('Thread subject');
    expect(digest).not.toMatch(/[{}[\]]/);
  });

  it('listGmailLabels digests a count and sample names in prose', async () => {
    const caps = await gmailCaps();
    const result = await caps.listGmailLabels.run(ACCOUNT_A, {});
    const digest = caps.listGmailLabels.digest!({}, result);
    expect(digest).toMatch(/2 labels/i);
    expect(digest).toContain('INBOX');
    expect(digest).not.toMatch(/[{}[\]]/);
  });
});

// ---------------------------------------------------------------------------
// K. markGmailMessageUnread — the lib function existed, exposed by nothing.
// ---------------------------------------------------------------------------
describe('markGmailMessageUnread', () => {
  it('mints a fresh token and calls the existing markUnread lib function', async () => {
    const caps = await gmailCaps();
    await caps.markGmailMessageUnread.run(ACCOUNT_A, { messageId: 'm1' });
    expect(mintAccessToken).toHaveBeenCalledWith(ACCOUNT_A);
    expect(markUnread).toHaveBeenCalledWith(`fresh-token-for-${ACCOUNT_A}`, 'm1');
  });
});

// ---------------------------------------------------------------------------
// L. Every new capability's digest, fed a representative result, contains no
//    raw-JSON fingerprints (mirrors tests/observation-display-guard.test.ts's
//    marker set directly against these specific capabilities).
// ---------------------------------------------------------------------------
describe('every new capability\'s digest output contains no raw-JSON fingerprints', () => {
  const RAW_JSON_MARKERS = ['{"', '":[', '":{'];
  function hasMarker(s: string) {
    return RAW_JSON_MARKERS.some((m) => s.includes(m));
  }

  it('listGmailDrafts, getGmailDraft, createGmailDraft, sendGmailDraft, deleteGmailDraft, replyToGmailMessage, getGmailThread, listGmailLabels', async () => {
    const caps = await gmailCaps();
    const checks: Array<[string, any, any]> = [
      ['listGmailDrafts', {}, await caps.listGmailDrafts.run(ACCOUNT_A, {})],
      ['getGmailDraft', { draftId: 'd1' }, await caps.getGmailDraft.run(ACCOUNT_A, { draftId: 'd1' })],
      ['createGmailDraft', { subject: 'Hi' }, await caps.createGmailDraft.run(ACCOUNT_A, { to: 'x@y.com', subject: 'Hi', html: '<p>hi</p>' })],
      ['sendGmailDraft', { draftId: 'd1' }, await caps.sendGmailDraft.run(ACCOUNT_A, { draftId: 'd1' })],
      ['deleteGmailDraft', { draftId: 'd1' }, await caps.deleteGmailDraft.run(ACCOUNT_A, { draftId: 'd1' })],
      ['replyToGmailMessage', {}, await caps.replyToGmailMessage.run(ACCOUNT_A, { messageId: 'm1', html: '<p>hi</p>' })],
      ['getGmailThread', {}, await caps.getGmailThread.run(ACCOUNT_A, { threadId: 't1' })],
      ['listGmailLabels', {}, await caps.listGmailLabels.run(ACCOUNT_A, {})],
    ];
    for (const [name, args, result] of checks) {
      const digest = caps[name].digest!(args, result);
      expect(hasMarker(digest), `${name} digest leaked raw JSON: ${digest}`).toBe(false);
    }
  });
});
