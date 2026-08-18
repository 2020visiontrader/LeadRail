// Packet 2.2 — analytics domain. Thin wrapper over lib/analytics/store.ts's
// getTotals(accountId).
//
// DEVIATION FROM THE PLAN (reported, not silently fixed): the plan also
// lists `getCampaignAnalytics` and `getSequenceStats`.
//   - lib/crm.ts's getCampaignAnalytics(brandId) took NO accountId — it
//     queried ad_campaigns by brand_id alone. Per this packet's own hard
//     rule ("any capability whose backing service function lacks an
//     accountId parameter is a tenant-isolation bug in that service, not
//     something the capability layer should paper over"), wrapping it here
//     would have laundered that gap into a chat-reachable tool. Left out;
//     flagged for lib/crm.ts to fix, out of this packet's file list.
//     FIXED by Packet D1: getCampaignAnalytics now takes accountId and
//     filters ad_campaigns on it in the query. Added below.
//   - No getSequenceStats function exists anywhere in the codebase
//     (lib/sequences.ts has enrollment CRUD but no aggregate stats reader).
//     Left out rather than reimplementing new aggregation logic here.
import { z } from 'zod';
import { getTotals } from '@/lib/analytics/store';
import { getCampaignAnalytics } from '@/lib/crm';
import { obj, S, type Capability, present, digestLine } from './types';

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
  {
    name: 'getCampaignAnalytics',
    domain: 'analytics',
    title: 'Get campaign analytics',
    description: 'Roll up budget and spend across a brand\'s ad campaigns: totals, remaining budget, and a breakdown by channel.',
    gate: 'read',
    inputSchema: obj({ brandId: S.string }, ['brandId']),
    zod: z.object({ brandId: z.string() }),
    run: (accountId, { brandId }) => getCampaignAnalytics(brandId, accountId),
    digest: (_args, result) => {
      if (!result || typeof result !== 'object') return '';
      const byChannel = result.byChannel && typeof result.byChannel === 'object' ? Object.keys(result.byChannel) : [];
      return digestLine(
        present(result, 'campaigns') ? `${result.campaigns} campaign${result.campaigns === 1 ? '' : 's'}.` : null,
        present(result, 'totalBudget') ? `Budget ${result.totalBudget}.` : null,
        present(result, 'totalSpend') ? `Spend ${result.totalSpend}.` : null,
        present(result, 'remaining') ? `Remaining ${result.remaining}.` : null,
        byChannel.length ? `By channel: ${byChannel.join(', ')}.` : null,
      );
    },
  },
];
