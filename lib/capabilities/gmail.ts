// lib/capabilities/gmail.ts — Gmail domain capabilities.
//
// THE DEFECT THIS CLOSES. A working Gmail integration (lib/email/gmail.ts +
// lib/email/gmail-account.ts) was fully implemented — OAuth connect/callback,
// listMessages/getMessage/sendMessage/modifyMessage, token refresh via
// mintAccessToken — and called by NOTHING. The assistant, asked whether it
// could reach the owner's Gmail, answered "no" with zero tool calls, because
// there was no tool to call. This file is the wiring: thin wrappers over the
// existing lib/email/gmail.ts functions, no Gmail logic reimplemented.
//
// TOKEN REFRESH. Every capability here goes through requireGmailAccessToken(),
// which NEVER trusts a stored token — it always mints a fresh one via
// mintAccessToken() (a refresh-token exchange). mintAccessToken() already
// records a refresh failure via markGmailAccountError() and returns null
// rather than throwing; this module turns that null into a clear,
// user-actionable message ("needs reconnecting"), never a raw stack trace.
//
// ACCOUNT SCOPING. getGmailAccount(accountId) is scoped to the authenticated
// accountId on every call — the same accountId every other capability in this
// registry is scoped to (see lib/capabilities/types.ts's CapabilityContext and
// runTool in lib/agent/tools.ts). There is exactly one Gmail row per account
// (migration 081's partial unique index), so there is no "which mailbox"
// question to get wrong — only ever this account's own.
//
// GATES.
//   listGmailMessages / getGmailMessage — 'read'. No mutation.
//   sendGmailEmail — 'external_send', gated exactly like sendEmail in
//     lib/capabilities/outreach.ts: it reaches a real third party's inbox, so
//     it must go through the standing approval flow (runTool / isSensitive in
//     lib/capabilities/types.ts), never send directly.
//   markGmailMessageRead / archiveGmailMessage — 'internal_write'. Both change
//     only the state of labels on the OWNER'S OWN mailbox (read/unread,
//     inbox/archived) — nothing is sent and no third party is reached, which
//     is exactly the internal_write line drawn in types.ts ("mutates only
//     LeadRail state" — the owner's mailbox state, reached through the
//     owner's own connected account, is the same category as any other
//     internal record this platform writes on the user's behalf).
//
// 2026-09-04 ADDITIONS (drafts, threads, labels, reply, unread). The owner
// asked the live assistant how many drafts were in Gmail and it had no way to
// answer — the five capabilities above covered the inbox but nothing touched
// /drafts, /threads, or /labels, and markUnread (already implemented in
// lib/email/gmail.ts) was wired to nothing. Same wrapping discipline as
// above: thin wrappers, requireGmailAccessToken() on every call, truthful
// digests. New gates:
//   markGmailMessageUnread — 'internal_write'. Same category as
//     markGmailMessageRead/archiveGmailMessage: mutates only label state on
//     the owner's own mailbox.
//   listGmailDrafts / getGmailDraft / getGmailThread / listGmailLabels —
//     'read'. No mutation; a draft or a thread or a label list is read data,
//     same as a message.
//   createGmailDraft — 'internal_write', NOT 'external_send': a draft writes
//     only to the owner's own mailbox (a Gmail draft resource) and sends
//     nothing to anyone. It is the same category as
//     markGmailMessageRead/archiveGmailMessage: it mutates only the owner's
//     own account state.
//   sendGmailDraft / replyToGmailMessage — 'external_send', same class and
//     same reasoning as sendGmailEmail: both reach a real third party's inbox
//     the moment they run, so both go through the standing approval flow.
//   deleteGmailDraft — 'destructive': the draft resource is permanently
//     removed and cannot be recovered from chat — the same irreversibility
//     line drawn for deleteDeal (lib/capabilities/deals.ts) and other
//     'destructive' capabilities in this registry.
//
// REPLY THREADING. replyToGmailMessage fetches the ORIGINAL message first
// (getMessage) and derives In-Reply-To (the original's own Message-ID),
// References (the original's own References chain with its Message-ID
// appended — RFC 2822 threading), and threadId (the original's threadId,
// passed to sendMessage) from it. buildRawMessage already accepted
// inReplyTo/references (no sibling needed); the piece that was missing was
// computing them from a real prior message rather than leaving it to the
// caller to get right — a reply that starts a new thread is a defect users
// notice immediately, so this capability computes the headers itself instead
// of trusting the model to pass the right ones.
import { z } from 'zod';
import { getGmailAccount, type GmailAccountRow } from '@/lib/email/gmail-account';
import {
  mintAccessToken,
  listMessages,
  getMessage,
  sendMessage,
  markRead as gmailMarkRead,
  markUnread as gmailMarkUnread,
  archiveMessage as gmailArchiveMessage,
  listDrafts,
  getDraft,
  createDraft,
  sendDraft,
  deleteDraft,
  getThread,
  listLabels,
} from '@/lib/email/gmail';
import { obj, S, type Capability, present, digestLine, clip, plural, samples } from './types';

const NOT_CONNECTED =
  'No Gmail account is connected for this workspace. Connect one in Settings before reading or sending mail.';

const NEEDS_RECONNECT =
  'Your Gmail connection needs reconnecting — the stored connection no longer works (it may have been revoked or expired at Google). Reconnect Gmail in Settings, then try again.';

/**
 * Every capability in this file goes through here rather than assuming a
 * stored token is valid. Two failure shapes, both surfaced as a clear message
 * rather than a raw error — never a stack trace reaching the user:
 *   - no row at all / not connected            -> NOT_CONNECTED
 *   - a row exists but the refresh token no longer works (mintAccessToken
 *     returns null, having already called markGmailAccountError itself)
 *                                               -> NEEDS_RECONNECT
 */
async function requireGmailAccessToken(accountId: string): Promise<{ token: string; account: GmailAccountRow }> {
  const account = await getGmailAccount(accountId);
  if (!account || account.status === 'disconnected' || !account.secret_encrypted) {
    throw new Error(NOT_CONNECTED);
  }
  const token = await mintAccessToken(accountId);
  if (!token) {
    throw new Error(NEEDS_RECONNECT);
  }
  return { token, account };
}

/** Pull a header value (case-insensitive) off a Gmail API message payload. */
function headerValue(message: any, name: string): string | null {
  const headers = message?.payload?.headers;
  if (!Array.isArray(headers)) return null;
  const hit = headers.find((h: any) => String(h?.name || '').toLowerCase() === name.toLowerCase());
  return hit?.value ?? null;
}

export const GMAIL_CAPABILITIES: Capability[] = [
  {
    name: 'listGmailMessages',
    domain: 'gmail',
    title: 'List Gmail messages',
    description:
      'List messages in the connected Gmail mailbox, optionally filtered with Gmail search syntax (e.g. "is:unread", "from:someone@x.com"). Returns message ids — use getGmailMessage to read one.',
    gate: 'read',
    inputSchema: obj({ query: S.string, maxResults: S.number }, []),
    zod: z.object({ query: z.string().optional(), maxResults: z.number().int().positive().max(100).optional() }),
    run: async (accountId, { query, maxResults }) => {
      const { token } = await requireGmailAccessToken(accountId);
      return listMessages(token, { query, maxResults });
    },
    digest: (_a, result) => {
      if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
      const r: any = result;
      if (!Array.isArray(r.messages)) return '';
      if (!r.messages.length) return 'No messages matched.';
      return digestLine(
        `${plural(r.messages.length, 'message')} found.`,
        r.nextPageToken ? 'More are available beyond this page.' : null,
        'Call getGmailMessage with one of these ids to read its subject, sender and body.',
      );
    },
  },
  {
    name: 'getGmailMessage',
    domain: 'gmail',
    title: 'Read a Gmail message',
    description: 'Read one Gmail message by id (from listGmailMessages) — subject, sender, date and body.',
    gate: 'read',
    inputSchema: obj({ messageId: S.string }, ['messageId']),
    zod: z.object({ messageId: z.string() }),
    run: async (accountId, { messageId }) => {
      const { token } = await requireGmailAccessToken(accountId);
      return getMessage(token, messageId, 'full');
    },
    // Truthful only: every field here is read straight off the Gmail API
    // response's own headers/snippet, never inferred.
    digest: (_a, result) => {
      if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
      const r: any = result;
      const subject = headerValue(r, 'Subject');
      const from = headerValue(r, 'From');
      const date = headerValue(r, 'Date');
      if (!subject && !from && !present(r, 'snippet')) return '';
      return digestLine(
        subject ? `Subject: "${clip(subject, 120)}".` : null,
        from ? `From: ${clip(from, 120)}.` : null,
        date ? `Date: ${clip(date, 60)}.` : null,
        present(r, 'snippet') ? `Snippet: "${clip(String(r.snippet), 200)}".` : null,
      );
    },
  },
  {
    name: 'sendGmailEmail',
    domain: 'gmail',
    title: 'Send email from Gmail (SENDS to a real person)',
    description:
      'Send an email from the connected Gmail mailbox to a real person. Provide the recipient, subject, and body (html). This sends immediately once approved — it reaches their inbox and cannot be recalled.',
    gate: 'external_send',
    inputSchema: obj(
      { to: S.string, subject: S.string, html: S.string, inReplyTo: S.string, references: S.string, threadId: S.string },
      ['to', 'subject', 'html'],
    ),
    zod: z.object({
      to: z.string(),
      subject: z.string(),
      html: z.string(),
      inReplyTo: z.string().optional(),
      references: z.string().optional(),
      threadId: z.string().optional(),
    }),
    run: async (accountId, { to, subject, html, inReplyTo, references, threadId }) => {
      const { token, account } = await requireGmailAccessToken(accountId);
      return sendMessage(token, { from: account.address, to, subject, html, inReplyTo, references, threadId });
    },
    // Same pattern as sendEmail in lib/capabilities/outreach.ts: subject only,
    // never the body — the part a reviewer can actually judge before approving.
    summarize: (a) => `Send a real Gmail message to ${String(a.to ?? 'the recipient')} with the subject "${String(a.subject ?? '').slice(0, 120)}". It reaches their inbox immediately and cannot be recalled.`,
    // Speaks only for a send the Gmail API actually confirmed (a message id in
    // the response). No id -> no digest -> the raw result (or lack of one)
    // reaches the model instead of a fabricated "sent" claim.
    digest: (a, result) => {
      if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
      const r: any = result;
      const id = present(r, 'id') ? String(r.id) : null;
      if (!id) return '';
      const subj = present(a, 'subject') ? ` with the subject "${clip(String(a.subject), 120)}"` : '';
      const to = present(a, 'to') ? String(a.to) : 'the recipient';
      return digestLine(`Sent a real Gmail message to ${clip(to, 120)}${subj}.`, `Gmail message id ${clip(id, 60)}.`);
    },
  },
  {
    name: 'markGmailMessageRead',
    domain: 'gmail',
    title: 'Mark Gmail message read',
    description: 'Mark a Gmail message as read (or pass isRead:false to mark it unread again). Changes only the owner\'s own mailbox — nothing is sent.',
    gate: 'internal_write',
    inputSchema: obj({ messageId: S.string, isRead: { type: 'boolean' } }, ['messageId']),
    zod: z.object({ messageId: z.string(), isRead: z.boolean().optional() }),
    run: async (accountId, { messageId, isRead }) => {
      const { token } = await requireGmailAccessToken(accountId);
      return isRead === false ? gmailMarkUnread(token, messageId) : gmailMarkRead(token, messageId);
    },
  },
  {
    name: 'archiveGmailMessage',
    domain: 'gmail',
    title: 'Archive Gmail message',
    description: 'Archive a Gmail message (removes it from the inbox, keeps it in All Mail). Changes only the owner\'s own mailbox — nothing is sent.',
    gate: 'internal_write',
    inputSchema: obj({ messageId: S.string }, ['messageId']),
    zod: z.object({ messageId: z.string() }),
    run: async (accountId, { messageId }) => {
      const { token } = await requireGmailAccessToken(accountId);
      return gmailArchiveMessage(token, messageId);
    },
  },
  {
    name: 'markGmailMessageUnread',
    domain: 'gmail',
    title: 'Mark Gmail message unread',
    description: 'Mark a Gmail message as unread. Changes only the owner\'s own mailbox — nothing is sent.',
    gate: 'internal_write',
    inputSchema: obj({ messageId: S.string }, ['messageId']),
    zod: z.object({ messageId: z.string() }),
    run: async (accountId, { messageId }) => {
      const { token } = await requireGmailAccessToken(accountId);
      return gmailMarkUnread(token, messageId);
    },
  },
  {
    name: 'listGmailDrafts',
    domain: 'gmail',
    title: 'List Gmail drafts',
    description:
      'List drafts in the connected Gmail mailbox. Use this to answer "how many drafts do I have" — the digest states the count. Returns draft ids — use getGmailDraft to read one.',
    gate: 'read',
    inputSchema: obj({ maxResults: S.number }, []),
    zod: z.object({ maxResults: z.number().int().positive().max(100).optional() }),
    run: async (accountId, { maxResults }) => {
      const { token } = await requireGmailAccessToken(accountId);
      return listDrafts(token, { maxResults });
    },
    // Gmail's own resultSizeEstimate is the true count of drafts matching
    // this call (Gmail API semantics: it is a real count for an unfiltered
    // drafts.list, not an approximation the way it can be for a search
    // query) — never re-derived from the page of rows returned, which can be
    // fewer than the total when the page truncates at maxResults.
    digest: (_a, result) => {
      if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
      const r: any = result;
      if (!Array.isArray(r.drafts)) return '';
      const total = typeof r.resultSizeEstimate === 'number' ? r.resultSizeEstimate : r.drafts.length;
      if (!total) return 'No drafts.';
      return digestLine(
        `${plural(total, 'draft')} in the mailbox.`,
        r.drafts.length < total ? `${r.drafts.length} shown on this page.` : null,
        r.nextPageToken ? 'More are available beyond this page.' : null,
        'Call getGmailDraft with one of these ids to read its contents.',
      );
    },
  },
  {
    name: 'getGmailDraft',
    domain: 'gmail',
    title: 'Read a Gmail draft',
    description: 'Read one Gmail draft by id (from listGmailDrafts) — recipient, subject and body.',
    gate: 'read',
    inputSchema: obj({ draftId: S.string }, ['draftId']),
    zod: z.object({ draftId: z.string() }),
    run: async (accountId, { draftId }) => {
      const { token } = await requireGmailAccessToken(accountId);
      return getDraft(token, draftId, 'full');
    },
    digest: (_a, result) => {
      if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
      const r: any = result;
      const msg = r.message;
      const subject = headerValue(msg, 'Subject');
      const to = headerValue(msg, 'To');
      if (!subject && !to && !present(msg, 'snippet')) return '';
      return digestLine(
        subject ? `Subject: "${clip(subject, 120)}".` : null,
        to ? `To: ${clip(to, 120)}.` : null,
        present(msg, 'snippet') ? `Snippet: "${clip(String(msg.snippet), 200)}".` : null,
      );
    },
  },
  {
    name: 'createGmailDraft',
    domain: 'gmail',
    title: 'Create a Gmail draft',
    description:
      'Create a new draft in the connected Gmail mailbox. Writes only to the owner\'s own mailbox — this never sends. Use sendGmailDraft to send it afterwards.',
    gate: 'internal_write',
    inputSchema: obj({ to: S.string, subject: S.string, html: S.string }, ['to', 'subject', 'html']),
    zod: z.object({ to: z.string(), subject: z.string(), html: z.string() }),
    run: async (accountId, { to, subject, html }) => {
      const { token, account } = await requireGmailAccessToken(accountId);
      return createDraft(token, { from: account.address, to, subject, html });
    },
    digest: (a, result) => {
      if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
      const r: any = result;
      const id = present(r, 'id') ? String(r.id) : null;
      if (!id) return '';
      const subj = present(a, 'subject') ? ` with the subject "${clip(String(a.subject), 120)}"` : '';
      return digestLine(`Created a Gmail draft${subj}.`, `Draft id ${clip(id, 60)}.`, 'Nothing was sent.');
    },
  },
  {
    name: 'sendGmailDraft',
    domain: 'gmail',
    title: 'Send a Gmail draft (SENDS to a real person)',
    description:
      'Send an existing Gmail draft by id. This sends immediately once approved — it reaches the recipient\'s inbox and cannot be recalled.',
    gate: 'external_send',
    inputSchema: obj({ draftId: S.string }, ['draftId']),
    zod: z.object({ draftId: z.string() }),
    run: async (accountId, { draftId }) => {
      const { token } = await requireGmailAccessToken(accountId);
      return sendDraft(token, draftId);
    },
    summarize: (a) => `Send Gmail draft ${String(a.draftId ?? '')}. It reaches the recipient's inbox immediately and cannot be recalled.`,
    digest: (_a, result) => {
      if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
      const r: any = result;
      const id = present(r, 'id') ? String(r.id) : null;
      if (!id) return '';
      return digestLine('Sent the Gmail draft.', `Gmail message id ${clip(id, 60)}.`);
    },
  },
  {
    name: 'deleteGmailDraft',
    domain: 'gmail',
    title: 'Delete a Gmail draft',
    description: 'Permanently delete a Gmail draft by id. This is irreversible — the draft cannot be recovered from chat.',
    gate: 'destructive',
    inputSchema: obj({ draftId: S.string }, ['draftId']),
    zod: z.object({ draftId: z.string() }),
    run: async (accountId, { draftId }) => {
      const { token } = await requireGmailAccessToken(accountId);
      return deleteDraft(token, draftId);
    },
    summarize: (a) => `Permanently delete Gmail draft ${String(a.draftId ?? '')}. This cannot be undone.`,
    digest: (a, result) => {
      if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
      const r: any = result;
      if (!r.deleted) return '';
      return digestLine(`Deleted Gmail draft ${clip(String(a.draftId ?? r.id ?? ''), 60)}.`);
    },
  },
  {
    name: 'replyToGmailMessage',
    domain: 'gmail',
    title: 'Reply to a Gmail message (SENDS to a real person)',
    description:
      'Reply to an existing Gmail message by id, staying in the same thread. This sends immediately once approved — it reaches their inbox and cannot be recalled. Do not use sendGmailEmail for a reply: that starts a new, unthreaded message.',
    gate: 'external_send',
    inputSchema: obj({ messageId: S.string, html: S.string }, ['messageId', 'html']),
    zod: z.object({ messageId: z.string(), html: z.string() }),
    run: async (accountId, { messageId, html }) => {
      const { token, account } = await requireGmailAccessToken(accountId);
      const original = await getMessage(token, messageId, 'full');
      const to = headerValue(original, 'Reply-To') || headerValue(original, 'From');
      if (!to) throw new Error('Could not determine who to reply to — the original message has no From/Reply-To header.');
      const originalSubject = headerValue(original, 'Subject') || '';
      const subject = /^re:/i.test(originalSubject.trim()) ? originalSubject : `Re: ${originalSubject}`;
      // Threading per RFC 2822 / Gmail's own contract: In-Reply-To is the
      // original message's Message-ID; References is the original's own
      // References chain with the original Message-ID appended (or just the
      // Message-ID when the original started the thread). threadId keeps it
      // in the same Gmail thread even if a header were ever missing.
      const originalMessageId = headerValue(original, 'Message-ID') || headerValue(original, 'Message-Id');
      const originalReferences = headerValue(original, 'References');
      const references = [originalReferences, originalMessageId].filter(Boolean).join(' ').trim() || undefined;
      const threadId = (original as any)?.threadId;
      return sendMessage(token, {
        from: account.address,
        to,
        subject,
        html,
        inReplyTo: originalMessageId || undefined,
        references,
        threadId,
      });
    },
    summarize: (a) => `Reply to Gmail message ${String(a.messageId ?? '')}, staying in the same thread. It reaches their inbox immediately and cannot be recalled.`,
    digest: (_a, result) => {
      if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
      const r: any = result;
      const id = present(r, 'id') ? String(r.id) : null;
      if (!id) return '';
      const threadId = present(r, 'threadId') ? String(r.threadId) : null;
      return digestLine(
        'Sent the reply, in the same thread.',
        `Gmail message id ${clip(id, 60)}.`,
        threadId ? `Thread id ${clip(threadId, 60)}.` : null,
      );
    },
  },
  {
    name: 'getGmailThread',
    domain: 'gmail',
    title: 'Read a Gmail thread',
    description: 'Read a whole Gmail conversation (every message in the thread) by thread id, not just one message.',
    gate: 'read',
    inputSchema: obj({ threadId: S.string }, ['threadId']),
    zod: z.object({ threadId: z.string() }),
    run: async (accountId, { threadId }) => {
      const { token } = await requireGmailAccessToken(accountId);
      return getThread(token, threadId, 'full');
    },
    digest: (_a, result) => {
      if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
      const r: any = result;
      if (!Array.isArray(r.messages)) return '';
      const subject = headerValue(r.messages[0], 'Subject');
      return digestLine(
        `${plural(r.messages.length, 'message')} in this thread.`,
        subject ? `Subject: "${clip(subject, 120)}".` : null,
        'Call getGmailMessage on any of its message ids to read the full body.',
      );
    },
  },
  {
    name: 'listGmailLabels',
    domain: 'gmail',
    title: 'List Gmail labels',
    description: 'List the labels (system and user-created, e.g. INBOX, SENT, custom labels) in the connected Gmail mailbox.',
    gate: 'read',
    inputSchema: obj({}, []),
    zod: z.object({}),
    run: async (accountId) => {
      const { token } = await requireGmailAccessToken(accountId);
      return listLabels(token);
    },
    digest: (_a, result) => {
      if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
      const r: any = result;
      if (!Array.isArray(r.labels)) return '';
      if (!r.labels.length) return 'No labels.';
      const names = samples(r.labels, ['name'], 8);
      return digestLine(
        `${plural(r.labels.length, 'label')}.`,
        names.length ? `Includes: ${names.join(', ')}.` : null,
      );
    },
  },
];
