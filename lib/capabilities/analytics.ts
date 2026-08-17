// Packet 2.2 — analytics domain. Thin wrapper over lib/analytics/store.ts's
// getTotals(accountId).
//
// DEVIATION FROM THE PLAN (reported, not silently fixed): the plan also
// lists `getCampaignAnalytics` and `getSequenceStats`.
//   - lib/crm.ts's getCampaignAnalytics(brandId) takes NO accountId — it
//     queries ad_campaigns by brand_id alone. Per this packet's own hard
//     rule ("any capability whose backing service function lacks an
//     accountId parameter is a tenant-isolation bug in that service, not
//     something the capability layer should paper over"), wrapping it here
//     would launder that gap into a chat-reachable tool. Left out; flagged
//     for lib/crm.ts to fix, out of this packet's file list.
//   - No getSequenceStats function exists anywhere in the codebase
//     (lib/sequences.ts has enrollment CRUD but no aggregate stats reader).
//     Left out rather than reimplementing new aggregation logic here.
import { z } from 'zod';
import { getTotals } from '@/lib/analytics/store';
import { obj, type Capability, present, digestLine } from './types';

export const ANALYTICS_CAPABILITIES: Capability[] = [
  {
    name: 'getOverview',
    domain: 'analytics',
    title: 'Get account overview',
    description: 'Get high-level account totals: contact count, all-time event count, and events in the last 7 days.',
    gate: 'read',
    inputSchema: obj({}),
    zod: z.object({}),
    run: (accountId) => getTotals(accountId),
    digest: (_args, result) => {
      if (!result || typeof result !== 'object') return '';
      return digestLine(
        present(result, 'contacts') ? `${result.contacts} contacts.` : null,
        present(result, 'events') ? `${result.events} events all-time.` : null,
        present(result, 'events7d') ? `${result.events7d} events in the last 7 days.` : null,
      );
    },
  },
];
