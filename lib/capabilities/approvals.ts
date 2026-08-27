// Standing-approval capabilities — seeing and withdrawing what you granted.
//
// MODELLED ON HOW A CODING AGENT'S PERMISSIONS WORK, because that system has
// had the sharp edges filed off it already:
//
//   1. Three answers on a prompt, not two: reject / allow once / allow without
//      asking again. LeadRail had only the first two, which is why a per-item
//      tool like enrichLead produced 29 approval cards in this account.
//   2. A grant is a RULE, not a mood. It has a subject (which tool), a scope
//      (this session), and a bound (how many uses).
//   3. The allowlist is INSPECTABLE AND EDITABLE. This is the part that is easy
//      to skip and most important to keep: a standing permission nobody can see
//      is the dangerous kind. If the operator cannot answer "what am I
//      currently letting it do without asking?" then the grant has stopped
//      being a decision and become a setting they forgot.
//   4. Withdrawal beats grant, always, and takes effect immediately.
//
// So these two exist for the same reason `/permissions` does: the grant is only
// safe if it is visible and cancellable from the same place you gave it.

import { z } from 'zod';
import { obj, S, type Capability } from './types';
import { listLiveGrantsForAccount, revokeGrant, revokeAllForAccount } from '@/lib/approvals/grants';

export const APPROVAL_CAPABILITIES: Capability[] = [
  {
    name: 'listStandingApprovals',
    domain: 'workspace',
    title: 'List standing approvals',
    description:
      'List what you are currently allowed to do in this chat without asking each time, and how many uses are left on each. Use when the user asks what they have approved, what is still allowed, or before a long batch so they can see what will run unattended.',
    gate: 'read',
    inputSchema: obj({}, []),
    zod: z.object({}),
    run: async (accountId) => {
      const grants = await listLiveGrantsForAccount(accountId);
      return {
        standing: grants.map((g) => ({
          action: g.tool,
          usesLeft: g.usesRemaining,
          expiresAt: g.expiresAt,
          grantedBy: g.grantedBy,
        })),
      };
    },
    digest: (_a, r: any) => {
      if (!r) return '';
      return r.standing?.length
        ? `${r.standing.length} action(s) currently approved to run without asking.`
        : 'Nothing is currently approved to run without asking.';
    },
  },
  {
    name: 'revokeStandingApproval',
    domain: 'workspace',
    title: 'Stop running an action without asking',
    description:
      'Withdraw a standing approval so the action asks for confirmation again. Pass the action name to withdraw one, or omit it to withdraw every standing approval in this chat. Use the moment the user says to stop, slow down, or check with them first.',
    // Deliberately NOT sensitive. Withdrawing permission must never itself need
    // permission — a user saying "stop" has to take effect on the spot, not
    // queue behind a card they then have to approve.
    gate: 'internal_write',
    inputSchema: obj({ action: S.string }, []),
    zod: z.object({ action: z.string().min(1).optional() }),
    run: async (accountId, a) => {
      if (!a.action) {
        const n = await revokeAllForAccount(accountId);
        return { revoked: n, scope: 'every standing approval' };
      }
      const grants = await listLiveGrantsForAccount(accountId);
      let revoked = 0;
      for (const g of grants.filter((x) => x.tool === a.action)) {
        if (await revokeGrant(accountId, g.id)) revoked++;
      }
      return { revoked, scope: a.action };
    },
    digest: (_a, r: any) => {
      if (!r) return '';
      return r.revoked
        ? `Withdrawn — ${r.scope} will ask for confirmation again.`
        : 'There was nothing standing to withdraw.';
    },
  },
];
