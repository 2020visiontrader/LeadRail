// Packet 2.2 — forms domain. Thin wrappers over lib/forms/store.ts's
// account-scoped functions (the public getPublicForm/submitForm path is
// intentionally NOT wrapped here — it runs with no session and derives its
// own account scope, so it has no place in an account-authenticated tool).
import { z } from 'zod';
import { listForms, getForm, createForm, listSubmissions } from '@/lib/forms/store';
import {
  obj, S, type Capability,
  rowsOf, plural, samples, digestLine,
} from './types';

const fieldSchema = {
  type: 'array',
  items: obj({ key: S.string, label: S.string, type: S.string, required: { type: 'boolean' } }, ['key', 'label', 'type']),
};
const zField = z.object({
  key: z.string(), label: z.string(), type: z.enum(['text', 'email', 'tel', 'textarea']), required: z.boolean().optional(),
});

export const FORM_CAPABILITIES: Capability[] = [
  {
    name: 'listForms',
    domain: 'forms',
    title: 'List forms',
    description: 'List the account\'s lead-capture forms.',
    gate: 'read',
    inputSchema: obj({}),
    zod: z.object({}),
    run: (accountId) => listForms(accountId),
    digest: (_args, result) => {
      const rows = rowsOf(result);
      if (!rows) return '';
      const names = samples(rows, ['name']);
      return digestLine(
        `${plural(rows.length, 'form')} returned.`,
        names.length ? `Includes: ${names.join(', ')}.` : null,
      );
    },
  },
  {
    name: 'getForm',
    domain: 'forms',
    title: 'Get form',
    description: 'Get a single form by id, including its fields.',
    gate: 'read',
    inputSchema: obj({ id: S.string }, ['id']),
    zod: z.object({ id: z.string() }),
    run: (accountId, { id }) => getForm(accountId, id),
  },
  {
    name: 'listSubmissions',
    domain: 'forms',
    title: 'List form submissions',
    description: 'List submissions received for a form.',
    gate: 'read',
    inputSchema: obj({ formId: S.string }, ['formId']),
    zod: z.object({ formId: z.string() }),
    run: (accountId, { formId }) => listSubmissions(accountId, formId),
    digest: (_args, result) => {
      const rows = rowsOf(result);
      if (!rows) return '';
      return digestLine(`${plural(rows.length, 'submission')} returned.`);
    },
  },
  {
    name: 'createForm',
    domain: 'forms',
    title: 'Create form',
    description: 'Create a new lead-capture form with a name and field list.',
    gate: 'internal_write',
    inputSchema: obj({ name: S.string, fields: fieldSchema, redirectUrl: S.string, enabled: { type: 'boolean' } }, ['name']),
    zod: z.object({ name: z.string(), fields: z.array(zField).optional(), redirectUrl: z.string().optional(), enabled: z.boolean().optional() }),
    run: (accountId, a) => createForm(accountId, { name: a.name, fields: a.fields as any, redirect_url: a.redirectUrl, enabled: a.enabled }),
  },
];
