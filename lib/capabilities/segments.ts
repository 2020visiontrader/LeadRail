// Packet 2.2 — segments domain. Thin wrappers over lib/segments/store.ts,
// which already does the filter-whitelist validation; no business logic
// reimplemented here.
import { z } from 'zod';
import { listSegments, previewSegment, createSegment, updateSegment, ALLOWED_FIELDS, ALLOWED_OPS } from '@/lib/segments/store';
import {
  obj, S, type Capability,
  rowsOf, plural, samples, digestLine,
} from './types';

const filterSchema = {
  type: 'array',
  items: obj({ field: S.string, op: S.string, value: {} }, ['field', 'op']),
};
const zFilter = z.object({
  field: z.enum(ALLOWED_FIELDS as unknown as [string, ...string[]]),
  op: z.enum(ALLOWED_OPS as unknown as [string, ...string[]]),
  value: z.any().optional(),
});

export const SEGMENT_CAPABILITIES: Capability[] = [
  {
    name: 'listSegments',
    domain: 'segments',
    title: 'List segments',
    description: 'List saved lead segments (re-runnable filters over contacts) for the account.',
    gate: 'read',
    inputSchema: obj({}),
    zod: z.object({}),
    run: (accountId) => listSegments(accountId),
    digest: (_args, result) => {
      const rows = rowsOf(result);
      if (!rows) return '';
      const names = samples(rows, ['name']);
      return digestLine(
        `${plural(rows.length, 'segment')} returned.`,
        names.length ? `Includes: ${names.join(', ')}.` : null,
      );
    },
  },
  {
    name: 'previewSegment',
    domain: 'segments',
    title: 'Preview segment',
    description: 'Preview how many contacts match a set of filters, plus a small sample, before saving it as a segment.',
    gate: 'read',
    inputSchema: obj({ filters: filterSchema }, ['filters']),
    zod: z.object({ filters: z.array(zFilter) }),
    run: (accountId, { filters }) => previewSegment(accountId, filters as any),
    // Truthful over the actual preview shape: count is a real field on the
    // result, never inferred from the sample's length.
    digest: (_args, result) => {
      if (!result || typeof result !== 'object') return '';
      const count = typeof result.count === 'number' ? result.count : null;
      const sample = Array.isArray(result.sample) ? result.sample : [];
      const names = samples(sample, ['name', 'email']);
      return digestLine(
        count !== null ? `${plural(count, 'contact')} match.` : null,
        names.length ? `Sample includes: ${names.join(', ')}.` : null,
      );
    },
  },
  {
    name: 'createSegment',
    domain: 'segments',
    title: 'Create segment',
    description: 'Save a set of filters as a reusable segment. Use previewSegment first to check the filters match what you expect.',
    gate: 'internal_write',
    inputSchema: obj({ name: S.string, description: S.string, filters: filterSchema }, ['name']),
    zod: z.object({ name: z.string(), description: z.string().optional(), filters: z.array(zFilter).optional() }),
    run: (accountId, { name, description, filters }) => createSegment(accountId, { name, description, filters: filters as any }),
  },
  {
    name: 'updateSegment',
    domain: 'segments',
    title: 'Update segment',
    description: 'Update a saved segment\'s name, description, or filters.',
    gate: 'internal_write',
    inputSchema: obj({ id: S.string, name: S.string, description: S.string, filters: filterSchema }, ['id']),
    zod: z.object({ id: z.string(), name: z.string().optional(), description: z.string().optional(), filters: z.array(zFilter).optional() }),
    run: (accountId, { id, ...patch }) => updateSegment(accountId, id, patch as any),
  },
];
