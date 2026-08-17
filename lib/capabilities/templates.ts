// Packet 2.2 — templates/ICP domain.
//
// DEVIATION FROM THE PLAN (reported, not silently fixed): the plan names
// this domain "templates/ICP" backed by `lib/templates` + `lib/icp.ts`, with
// capabilities listTemplates, getTemplate, createTemplate, getIcp, updateIcp.
// There is no `lib/templates` module anywhere in the codebase (confirmed by
// search) — no reusable service function exists to wrap, so
// listTemplates/getTemplate/createTemplate are left out entirely rather than
// inventing new business logic.
//
// The ICP half IS backed by lib/icp.ts, but its shape is "profiles" (plural,
// per account/brand), not a single named "the ICP" — so `getIcp`/`updateIcp`
// are named `listIcpProfiles`/`updateIcpProfile` to stay truthful to what
// the backing functions actually return.
import { z } from 'zod';
import { listIcpProfiles, updateIcpProfile } from '@/lib/icp';
import {
  obj, S, type Capability,
  rowsOf, plural, samples, digestLine,
} from './types';

export const TEMPLATE_CAPABILITIES: Capability[] = [
  {
    name: 'listIcpProfiles',
    domain: 'templates',
    title: 'List ICP profiles',
    description: 'List the account\'s saved ideal-customer-profile (ICP) searches, optionally filtered to one venture.',
    gate: 'read',
    inputSchema: obj({ brandId: S.string }),
    zod: z.object({ brandId: z.string().optional() }),
    run: (accountId, { brandId }) => listIcpProfiles(accountId, brandId),
    digest: (_args, result) => {
      const rows = rowsOf(result);
      if (!rows) return '';
      const names = samples(rows, ['name']);
      return digestLine(
        `${plural(rows.length, 'ICP profile')} returned.`,
        names.length ? `Includes: ${names.join(', ')}.` : null,
      );
    },
  },
  {
    name: 'updateIcpProfile',
    domain: 'templates',
    title: 'Update ICP profile',
    description: 'Update a saved ICP profile\'s name or query.',
    gate: 'internal_write',
    inputSchema: obj({ id: S.string, name: S.string, brandId: S.string }, ['id']),
    zod: z.object({ id: z.string(), name: z.string().optional(), brandId: z.string().optional() }),
    run: (accountId, { id, name, brandId }) => updateIcpProfile(id, accountId, { name, brand_id: brandId }),
  },
];
