// Packet 2.2 — suppressions domain. Thin wrapper over lib/suppressions.ts's
// account-scoped addSuppression().
//
// DEVIATION FROM THE PLAN (reported, not silently fixed): the plan also
// lists `listSuppressions`. lib/suppressions.ts exposes only isSuppressed()
// (single-address check) and filterSuppressed() (batch filter) — neither is
// a "list everything suppressed for this account" read. Adding one would be
// a new query, not a wrap of an existing function, so it is left out here
// rather than reimplementing that read inside the capability layer.
import { z } from 'zod';
import { addSuppression } from '@/lib/suppressions';
import { obj, S, type Capability } from './types';

export const SUPPRESSION_CAPABILITIES: Capability[] = [
  {
    name: 'addSuppression',
    domain: 'suppressions',
    title: 'Add suppression',
    description: 'Add an email address or domain to the account\'s send-suppression list so future outreach and sequences skip it. Provide an email and/or a domain, plus an optional reason.',
    gate: 'internal_write',
    inputSchema: obj({ email: S.string, domain: S.string, reason: S.string }),
    zod: z.object({ email: z.string().optional(), domain: z.string().optional(), reason: z.string().optional() }),
    run: (accountId, a) => addSuppression({ accountId, email: a.email, domain: a.domain, reason: a.reason, source: 'agent' }),
  },
];
