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
} from '@/lib/email/gmail';
import { obj, S, type Capability, present, digestLine, clip, plural } from './types';

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
];
