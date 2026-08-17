import { z } from 'zod';
import { supabase, getVentures, getVenture, updateVenture } from '@/lib/db';
import { obj, S, type Capability, rowsOf, plural, samples, digestLine } from './types';

// Module-local ownership helper — replaces TOOLS.getVenture pattern
async function getVentureOwned(accountId: string, brandId: string) {
  const v: any = await getVenture(brandId);
  if (!v || (v.account_id && v.account_id !== accountId)) throw new Error('Venture not found');
  return v;
}

export const VENTURE_CAPABILITIES: Capability[] = [
  {
    name: 'listVentures',
    domain: 'ventures',
    title: 'List ventures',
    description: 'List the ventures/brands in the account (id, name). Use to resolve a venture name the user typed into its id.',
    gate: 'read',
    inputSchema: obj({}),
    zod: z.object({}),
    run: async (accountId) => (await getVentures(accountId)).map((v: any) => ({ id: v.id, name: v.name })),
    // Small result, but it is the one the model resolves names against on
    // almost every turn — naming the ventures outright saves a re-read.
    digest: (_a, result) => {
      const rows = rowsOf(result);
      if (!rows) return '';
      if (!rows.length) return 'No ventures in this account.';
      const names = samples(rows, ['name'], 8);
      return digestLine(
        `${plural(rows.length, 'venture')}.`,
        names.length ? `${names.join(', ')}${rows.length > names.length ? ', …' : ''}` : null,
      );
    },
  },
  {
    name: 'getPersona',
    domain: 'ventures',
    title: 'Get sender persona',
    description: 'Get the sender persona for a venture (sender name/role/email, signature, pitch, tone, default CTA).',
    gate: 'read',
    inputSchema: obj({ brandId: S.string }, ['brandId']),
    zod: z.object({ brandId: z.string() }),
    run: async (accountId, { brandId }) => {
      const v: any = await getVentureOwned(accountId, brandId);
      return { name: v.sender_name, role: v.sender_role, email: v.sender_email, signature: v.signature, pitch: v.pitch, tone: v.tone, defaultCta: v.default_cta };
    },
  },
  {
    name: 'updatePersona',
    domain: 'ventures',
    title: 'Update sender persona',
    description: "Update a venture's sender persona fields (senderName, senderRole, senderEmail, signature, pitch, tone, defaultCta).",
    gate: 'internal_write',
    inputSchema: obj({ brandId: S.string, senderName: S.string, senderRole: S.string, senderEmail: S.string, signature: S.string, pitch: S.string, tone: S.string, defaultCta: S.string }, ['brandId']),
    zod: z.object({ brandId: z.string(), senderName: z.string().optional(), senderRole: z.string().optional(), senderEmail: z.string().optional(), signature: z.string().optional(), pitch: z.string().optional(), tone: z.string().optional(), defaultCta: z.string().optional() }),
    run: (accountId, a) => updateVenture(a.brandId, accountId, {
      sender_name: a.senderName, sender_role: a.senderRole, sender_email: a.senderEmail,
      signature: a.signature, pitch: a.pitch, tone: a.tone, default_cta: a.defaultCta,
    }),
  },
];
