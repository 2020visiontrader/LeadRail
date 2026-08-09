// Loads compact venture context for grounding the AI prompt boxes — the
// "thinking layer with context". Given the brand the user is working inside, it
// pulls the stored profile (positioning, lead goal, sectors, established ICP) so
// a prompt box reasons like an assistant that already knows the brand instead of
// treating each request as context-free text. Returns undefined for
// 'all'/missing/foreign ventures so callers safely stay context-free.

import { getVenture } from '@/lib/db';
import type { VentureContext } from './generation';

export async function loadVentureContext(
  brandId?: string,
  accountId?: string,
): Promise<VentureContext | undefined> {
  if (!brandId || brandId === 'all') return undefined;
  try {
    const v: any = await getVenture(brandId);
    if (!v) return undefined;
    // Tenant guard: never leak another account's brand context.
    if (accountId && v.account_id && v.account_id !== accountId) return undefined;
    const icp = v.icp_profile && typeof v.icp_profile === 'object' ? v.icp_profile : null;
    return {
      name: v.name || undefined,
      description: v.deck_summary || v.description || v.summary || undefined,
      leadGoal: v.lead_goal || undefined,
      sectors: Array.isArray(v.sectors) ? v.sectors.map(String) : undefined,
      pitch: v.pitch || undefined,
      icp: icp
        ? {
            industry: icp.industry,
            titles: Array.isArray(icp.titles) ? icp.titles : undefined,
            seniority: Array.isArray(icp.seniority) ? icp.seniority : undefined,
            keywords: icp.keywords,
            company_size: icp.company_size,
          }
        : null,
    };
  } catch {
    return undefined;
  }
}
