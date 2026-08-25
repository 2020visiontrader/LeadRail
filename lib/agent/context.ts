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

import { supabase, getConnections } from '@/lib/db';
import { LIVE_SOCIALS } from '@/lib/social/providers';
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
  '- Conversations: an inbox of replies from leads, plus social messages (Instagram direct messages and comments sent to connected business accounts land here too).',
  '- Campaigns: create and run Meta (Facebook/Instagram) ad campaigns, launch/pause them, and read live performance insights.',
  '- Social: connect Facebook Pages, Instagram business accounts, and Threads for the user, then publish posts, read and reply to comments, and reply to Instagram direct messages.',
  '- Knowledge: connected Notion and Google Drive the user keeps briefs and assets in.',
  'You can DO these things for the user by calling tools — you are not just an advisor. Reads and safe internal writes run immediately; actions that spend money, send messages to real people, or are destructive pause for the user to approve first.',
  'SOCIAL SCOPE: act only on accounts the user connected, and only within the permissions (scopes) they granted at connect time. For Instagram, messages and comments sent TO a connected business account arrive here; you cannot browse a private inbox you were not granted access to, or accounts that are not connected. If a requested social account is not connected, say so and offer to help connect it.',
].join('\n');

export interface AgentContextInput {
  accountId: string;
  brandId?: string;
  brandName?: string;
  /** Current user message — enables semantic (meaning-based) memory recall.
   *  Omitted → durable memory falls back to recency-only (unchanged). */
  query?: string;
}

/**
 * Assemble the grounding block appended to the agent system prompt. Returns a
 * plain-text briefing (platform + venture + account snapshot + durable memory).
 * Never throws — any section that fails is simply omitted.
 */
export async function loadAgentContext(input: AgentContextInput): Promise<string> {
  const { accountId, brandId } = input;

  // The four sections below don't depend on each other, so they're fetched
  // concurrently — sequential awaits here used to add ~4 DB round-trips (one
  // of which, the memory digest, includes an embedding API call) before this
  // function could even return, let alone before the SSE stream's first event.
  // Each section still degrades independently (its own try/catch): a slow or
  // failing one must not block or blank out the others. Final assembly below
  // re-imposes a FIXED order regardless of which promise settled first, so the
  // prompt's static-prefix shape (and its cacheability) is unchanged.

  // --- Venture grounding: ICP, pitch, positioning, lead goal ---------------
  const ventureSection = (async () => {
    try {
      const vc = brandId ? await loadVentureContext(brandId, accountId) : undefined;
      if (vc) {
        const lines = ['CURRENT VENTURE — the user is explicitly working here (source: live database). Use it unless they name another:'];
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
        return lines.length > 1 ? lines.join('\n') : null;
      } else if (input.brandName) {
        return `CURRENT VENTURE: ${input.brandName} (no stored profile yet).`;
      }
      return null;
    } catch { return null; /* venture section omitted */ }
  })();

  // --- Account snapshot: ventures + rough scale ----------------------------
  const snapshotSection = (async () => {
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
      // Timestamped so the model can tell "counted seconds ago" apart from the
      // durable-memory digest below, which can be weeks old. Bare numbers with
      // no fetch time invite the model to treat a stale recalled fact and a
      // live count as equally current when they conflict.
      const snap = [`ACCOUNT SNAPSHOT (source: live database, fetched ${new Date().toISOString()}):`];
      if (ventures?.length) {
        // Names AND ids. Names alone let the model recognise a venture but not
        // act on one — every brand-scoped capability takes an id, so a list
        // without ids means it either asks a question it could have answered
        // or invents an identifier.
        snap.push(`- Ventures (${ventures.length}): ${ventures.map((v: any) => `${v.name} [${v.id}]`).filter(Boolean).join(', ')}`);
        if (!brandId) {
          // WHY THIS BLOCK EXISTS. The UI used to default to whichever venture
          // sorted first and pass its id silently, so work landed on a brand
          // nobody chose and nothing said so. Removing that default is only
          // half the fix: without a rule, "no venture" becomes "guess", which
          // is the same failure with an extra step.
          snap.push('');
          snap.push('WHICH VENTURE — no venture is selected, so work it out before doing anything brand-scoped:');
          snap.push('1. If the message names a venture, or clearly refers to one (its product, its audience, a campaign only it runs), use that one and say which you picked.');
          snap.push('2. If the account has exactly one venture, use it.');
          snap.push('3. If the conversation already established one, stay with it — do not re-ask every turn.');
          snap.push('4. Otherwise ASK which venture this is for, and ask BEFORE acting. Do not pick the first one, do not pick the most recently used, and do not spread the work across all of them.');
          snap.push('Reading a venture to work out which is meant is fine. Writing, sending or spending against a guessed venture is not — that is work landing on the wrong brand, which is expensive to undo and easy to miss.');
        }
      }
      snap.push(`- Leads on file: ${leadCount ?? 0}`);
      snap.push(`- Ad campaigns: ${campaignCount ?? 0}`);
      return snap.join('\n');
    } catch { return null; /* snapshot omitted */ }
  })();

  // --- Connected social accounts (Packet 2.2-S) ----------------------------
  // Without this the model has to call listSocialAccounts before it can even
  // answer "what am I connected to?", and it cannot name the right account when
  // the user says "post this to the salon page". Identity only — display name,
  // username and the public external id. NEVER secret_ref or meta, which carry
  // access tokens. Omitted entirely when nothing is connected: an empty header
  // would invite the model to claim connections that don't exist.
  const socialSection = (async () => {
    try {
      const live = new Set(LIVE_SOCIALS.map((p) => p.key as string));
      const labelFor = new Map(LIVE_SOCIALS.map((p) => [p.key as string, p.label]));
      const conns = (await getConnections(accountId))
        .filter((c: any) => c.status === 'connected' && live.has(c.provider));
      if (!conns.length) return null;
      const lines = ['CONNECTED SOCIAL ACCOUNTS (source: live database):'];
      // Cap the block: a user with 40 connected pages must not crowd out the
      // rest of the briefing. The model can call listSocialAccounts for the full list.
      for (const c of conns.slice(0, 12)) {
        const who = c.username ? `@${c.username}` : (c.display_name || '(unnamed)');
        lines.push(`- ${labelFor.get(c.provider) || c.provider}: ${who} (id: ${c.external_id})`);
      }
      if (conns.length > 12) lines.push(`- …and ${conns.length - 12} more (call listSocialAccounts).`);
      try {
        const { count } = await supabase
          .from('social_automations')
          .select('id', { count: 'exact', head: true })
          .eq('account_id', accountId)
          .eq('enabled', true);
        if (count) lines.push(`Active automations: ${count} (see listSocialAutomations)`);
      } catch { /* automation count omitted */ }
      return lines.join('\n');
    } catch { return null; /* social section omitted */ }
  })();

  // --- Durable memory: facts learned across sessions -----------------------
  // Deliberately the LOWEST-authority section and placed LAST: everything
  // above is read live from the database on this exact turn; this is recalled
  // from past turns and can be minutes or months old, and nothing currently
  // re-verifies it against the live sections above before handing it to the
  // model. Without an explicit hierarchy instruction, a stale recalled fact
  // ("Sarah's email is sarah@oldco.com") and a live count read one line
  // earlier in the SAME prompt look equally authoritative — the model has no
  // basis to prefer one over the other. This line gives it that basis.
  const memorySection = (async () => {
    try {
      const digest = await recallMemoryDigest(accountId, 12, input.query);
      if (!digest) return null;
      return [
        "WHAT YOU'VE LEARNED (source: recalled memory — may be stale; if it conflicts with a live section above, the live section is correct):",
        digest,
      ].join('\n');
    } catch { return null; /* memory omitted */ }
  })();

  const [venture, snapshot, social, memory] = await Promise.all([
    ventureSection, snapshotSection, socialSection, memorySection,
  ]);

  const sections: string[] = [PLATFORM_BRIEF];
  for (const s of [venture, snapshot, social, memory]) if (s) sections.push(s);
  return sections.join('\n\n');
}
