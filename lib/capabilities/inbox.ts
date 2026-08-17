// Packet 2.2 — inbox domain. Thin wrappers over lib/conversations.ts and
// lib/inbox/reply-send.ts's account-scoped functions. listConversations
// already shipped in capabilities/crm.ts (2.1); this file adds the
// single-thread read/reply/mark-read surface the plan flagged as missing.
import { z } from 'zod';
import { getConversation, markConversationRead } from '@/lib/conversations';
import { sendInboxReply } from '@/lib/inbox/reply-send';
import { obj, S, type Capability, present, digestLine } from './types';

export const INBOX_CAPABILITIES: Capability[] = [
  {
    name: 'getThread',
    domain: 'inbox',
    title: 'Get conversation thread',
    description: 'Get a single inbox conversation by id.',
    gate: 'read',
    inputSchema: obj({ id: S.string }, ['id']),
    zod: z.object({ id: z.string() }),
    run: (accountId, { id }) => getConversation(id, accountId),
    digest: (_args, result) => {
      if (!result || typeof result !== 'object') return '';
      return digestLine(
        present(result, 'subject') ? `Subject: ${result.subject}.` : null,
        present(result, 'status') ? `Status: ${result.status}.` : null,
        present(result, 'channel') ? `Channel: ${result.channel}.` : null,
      );
    },
  },
  {
    name: 'replyToThread',
    domain: 'inbox',
    title: 'Reply to inbox message',
    description: 'Send a reply to an inbound inbox message, from the exact address it arrived at. Reaches a real person immediately.',
    gate: 'external_send',
    inputSchema: obj({ inboxMessageId: S.string, subject: S.string, bodyHtml: S.string }, ['inboxMessageId', 'bodyHtml']),
    zod: z.object({ inboxMessageId: z.string(), subject: z.string().optional(), bodyHtml: z.string().min(1) }),
    run: (accountId, a) => sendInboxReply({ accountId, inboxMessageId: a.inboxMessageId, subject: a.subject || '', bodyHtml: a.bodyHtml }),
    summarize: (a) => `Send a reply to inbox message ${a.inboxMessageId}. It reaches the original sender immediately.`,
  },
  {
    name: 'markRead',
    domain: 'inbox',
    title: 'Mark conversation read',
    description: 'Mark an inbox conversation as read (or unread). Pass isRead:false to mark it unread again.',
    gate: 'internal_write',
    inputSchema: obj({ id: S.string, isRead: { type: 'boolean' } }, ['id']),
    zod: z.object({ id: z.string(), isRead: z.boolean().optional() }),
    run: (accountId, { id, isRead }) => markConversationRead(id, accountId, isRead ?? true),
  },
];
