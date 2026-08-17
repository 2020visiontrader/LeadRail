import { z } from 'zod';
import { getPipelineStages, createDeal, moveDealStage, createNote } from '@/lib/crm';
import { listConversations } from '@/lib/conversations';
import {
  obj, S, type Capability,
  rowsOf, plural, tally, samples, digestLine,
} from './types';

export const CRM_CAPABILITIES: Capability[] = [
  {
    name: 'listConversations',
    domain: 'crm',
    title: 'List conversations',
    description: 'List inbox conversations for the account.',
    gate: 'read',
    inputSchema: obj({ limit: S.number }),
    zod: z.object({ limit: z.number().optional() }),
    run: (accountId, { limit = 50 }) => listConversations(accountId, limit),
    // Unread is counted only over rows that carry unread_count, and only rows
    // where it is a number greater than zero — rows lacking the field are not
    // assumed to be read.
    digest: (_args, result) => {
      const rows = rowsOf(result);
      if (!rows) return '';
      const withUnread = rows.filter((r: any) => typeof r?.unread_count === 'number');
      const unread = withUnread.filter((r: any) => r.unread_count > 0).length;
      const by = tally(rows, 'status');
      const channels = tally(rows, 'channel');
      const subjects = samples(rows, ['subject']);
      return digestLine(
        `${plural(rows.length, 'conversation')} returned.`,
        withUnread.length ? `${unread} of ${withUnread.length} with unread messages.` : null,
        by ? `By status: ${by}.` : null,
        channels ? `By channel: ${channels}.` : null,
        subjects.length ? `Subjects include: ${subjects.join(' | ')}.` : null,
      );
    },
  },
  {
    name: 'listStages',
    domain: 'crm',
    title: 'List pipeline stages',
    description: 'List the CRM pipeline stages (optionally for one venture). Use to resolve a stage name to its id before moving a deal.',
    gate: 'read',
    inputSchema: obj({ brandId: S.string }),
    zod: z.object({ brandId: z.string().optional() }),
    run: (accountId, { brandId }) => getPipelineStages(accountId, brandId),
  },
  {
    name: 'createDeal',
    domain: 'crm',
    title: 'Create deal',
    description: 'Create a deal in the pipeline. Provide a name; optionally a stage id, the lead id it is for, venture id, and amount.',
    gate: 'internal_write',
    inputSchema: obj({ name: S.string, stageId: S.string, contactId: S.string, brandId: S.string, amount: S.number }, ['name']),
    zod: z.object({ name: z.string(), stageId: z.string().optional(), contactId: z.string().optional(), brandId: z.string().optional(), amount: z.number().optional() }),
    run: (accountId, a) => createDeal({ account_id: accountId, name: a.name, stage_id: a.stageId, primary_contact_id: a.contactId, brand_id: a.brandId, amount: a.amount }),
  },
  {
    name: 'moveDeal',
    domain: 'crm',
    title: 'Move deal to stage',
    description: 'Move a deal to a different pipeline stage (resolve the stage id with listStages first).',
    gate: 'internal_write',
    inputSchema: obj({ id: S.string, stageId: S.string }, ['id', 'stageId']),
    zod: z.object({ id: z.string(), stageId: z.string() }),
    run: (accountId, { id, stageId }) => moveDealStage(id, accountId, stageId),
  },
  {
    name: 'addNote',
    domain: 'crm',
    title: 'Add note',
    description: 'Add a note to a lead and/or deal. Provide the note body; optionally the lead id and/or deal id it attaches to.',
    gate: 'internal_write',
    inputSchema: obj({ body: S.string, contactId: S.string, dealId: S.string, brandId: S.string }, ['body']),
    zod: z.object({ body: z.string(), contactId: z.string().optional(), dealId: z.string().optional(), brandId: z.string().optional() }),
    run: (accountId, a) => createNote({ account_id: accountId, body: a.body, contact_id: a.contactId, deal_id: a.dealId, brand_id: a.brandId }),
  },
];
