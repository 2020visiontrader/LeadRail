// LeadRail AI — context assembly (the "wrapper brain").
//
// This is what makes the in-app copilot operate like Zo does: before the model
// reasons, we hand it a compact, per-account briefing so it already knows the
// platform, the venture it's working in, the account's current state, and the
// durable facts it has learned. The model is a general LLM wrapping LeadRail —
// grounding is what turns it from a context-free chatbot into an operator.
//
// Everything here is READ-ONLY and tenant-scoped: every query is filtered by the
// authenticated accountId (never a client value). All lookups degrade gracefully
// — a copilot with partial context is better than a failed turn.

import { supabase } from '@/lib/db';
import { loadVentureContext } from '@/lib/ai/venture-context';
import { recallMemoryDigest } from './memory';

// A static description of what LeadRail is and how its pieces fit together, so
// the copilot can explain features and route plain-language tasks to the right
// capability. Kept terse — it is prepended to every turn.
const PLATFORM_BRIEF = [
  'ABOUT LEADRAIL (the platform you operate):',
  'LeadRail is an operator console for B2B growth. A user runs one or more "ventures" (brands) and works these areas:',
  '- Sourcing: find and reveal leads/contacts (people at target companies) matching a venture\'s ideal-customer profile.',
  '- Outreach: draft and send emails to leads, and enroll them into multi-step follow-up sequences.',
  '- CRM / pipeline: track leads through pipeline stages as deals, add notes, update status, tag.',
  '- Conversations: an inbox of replies from leads.',
  '- Campaigns: create and run Meta (Facebook/Instagram) ad campaigns, launch/pause them, and read live performance insights.',
  '- Knowledge: connected Notion and Google Drive the user keeps briefs and assets in.',
  'You can DO these things for the user by calling tools — you are not just an advisor. Reads and safe internal writes run immediately; actions that spend money, send messages to real people, or are destructive pause for the user to approve first.',
].join('\n');

export interface AgentContextInput {
  accountId: string;
  brandId?: string;
  brandName?: string;
}

/**
 * Assemble the grounding block appended to the agent system prompt. Returns a
 * plain-text briefing (platform + venture + account snapshot + durable memory).
 * Never throws — any section that fails is simply omitted.
 */
export async function loadAgentContext(input: AgentContextInput): Promise<string> {
  const { accountId, brandId } = input;
  const sections: string[] = [PLATFORM_BRIEF];

  // --- Venture grounding: ICP, pitch, positioning, lead goal ---------------
  try {
    const vc = brandId ? await loadVentureContext(brandId, accountId) : undefined;
    if (vc) {
      const lines = ['CURRENT VENTURE (work here unless the user names another):'];
      if (vc.name) lines.push(`- Name: ${vc.name}`);
      if (vc.description) lines.push(`- What it is: ${vc.description}`);
      if (vc.pitch) lines.push(`- Pitch: ${vc.pitch}`);
      if (vc.leadGoal) lines.push(`- Lead goal: ${vc.leadGoal}`);
      if (vc.sectors?.length) lines.push(`- Sectors: ${vc.sectors.join(', ')}`);
      if (vc.icp) {
        const icp = vc.icp;
        const parts: string[] = [];
        if (icp.industry) parts.push(`industry ${icp.industry}`);
        if (icp.titles?.length) parts.push(`titles ${icp.titles.join('/')}`);
        if (icp.seniority?.length) parts.push(`seniority ${icp.seniority.join('/')}`);
        if (icp.company_size) parts.push(`company size ${icp.company_size}`);
        if (icp.keywords) parts.push(`keywords ${Array.isArray(icp.keywords) ? icp.keywords.join('/') : icp.keywords}`);
        if (parts.length) lines.push(`- Ideal customer: ${parts.join('; ')}`);
      }
      if (lines.length > 1) sections.push(lines.join('\n'));
    } else if (input.brandName) {
      sections.push(`CURRENT VENTURE: ${input.brandName} (no stored profile yet).`);
    }
  } catch { /* venture section omitted */ }

  // --- Account snapshot: ventures + rough scale ----------------------------
  try {
    const { data: ventures } = await supabase
      .from('brands').select('id, name').eq('account_id', accountId).limit(25);
    const brandIds = (ventures || []).map((v: any) => v.id);
    const [{ count: leadCount }, { count: campaignCount }] = await Promise.all([
      supabase.from('contacts').select('id', { count: 'exact', head: true }).eq('account_id', accountId),
      brandIds.length
        ? supabase.from('ad_campaigns').select('id', { count: 'exact', head: true }).in('brand_id', brandIds)
        : Promise.resolve({ count: 0 } as any),
    ]);
    const snap = ['ACCOUNT SNAPSHOT:'];
    if (ventures?.length) snap.push(`- Ventures (${ventures.length}): ${ventures.map((v: any) => v.name).filter(Boolean).join(', ')}`);
    snap.push(`- Leads on file: ${leadCount ?? 0}`);
    snap.push(`- Ad campaigns: ${campaignCount ?? 0}`);
    sections.push(snap.join('\n'));
  } catch { /* snapshot omitted */ }

  // --- Durable memory: facts learned across sessions -----------------------
  try {
    const digest = await recallMemoryDigest(accountId);
    if (digest) sections.push(`WHAT YOU'VE LEARNED (durable memory):\n${digest}`);
  } catch { /* memory omitted */ }

  return sections.join('\n\n');
}
