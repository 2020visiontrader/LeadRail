// lib/agent/context.ts's "WHICH VENTURE — no venture is selected" block only
// fires when brandId is ABSENT (see the `if (!brandId)` guard around it).
// That conditional already existed; what was missing was the client ever
// reliably SENDING brandId (AgentConsole took the prop but /assistant never
// passed it — see app/assistant/page.tsx's fix). This file pins the
// conditional itself: a turn with a venture selected gets a venture profile
// and NOT the "which venture" prompt; a turn with none selected (and more
// than one venture on the account) gets the prompt, not a guess.
//
// Every dependency of loadAgentContext is mocked to a safe default — this
// file is about the venture/snapshot branching, not memory, attachments,
// social, or plans.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const supabaseFrom = vi.fn();
vi.mock('@/lib/db', () => ({
  supabase: { from: (...a: any[]) => supabaseFrom(...a) },
  getConnections: async () => [],
}));
vi.mock('@/lib/social/providers', () => ({ LIVE_SOCIALS: [] }));

const loadVentureContext = vi.fn(async (_brandId?: string, _accountId?: string) => undefined as any);
vi.mock('@/lib/ai/venture-context', () => ({ loadVentureContext: (...a: any[]) => loadVentureContext(...(a as [any, any])) }));

vi.mock('@/lib/documents/attachments', () => ({
  listAttachments: async () => [], attachmentContextBlock: () => '', attachmentsByIds: async () => [],
}));
vi.mock('@/lib/documents/attachment-bindings', () => ({ listBindingsForConversation: async () => [] }));
vi.mock('@/lib/agent/memory', () => ({ recallMemoryDigest: async () => null }));
vi.mock('@/lib/memory/resolve', () => ({ resolveSubjects: async () => [] }));
vi.mock('@/lib/memory/project', () => ({ loadSubjectMemory: async () => null }));
vi.mock('@/lib/plans/store', () => ({ activePlanForConversation: async () => null, renderPlan: () => '' }));
vi.mock('@/lib/outreach/history', () => ({ getOutreachHistory: async () => [], renderOutboxBlock: () => null }));

/** A `.from('brands').select(...).eq(...).limit(...)` chain resolving to the
 *  given ventures; `.from('contacts'|'ad_campaigns')...` resolve to counts. */
function mockSupabase(ventures: Array<{ id: string; name: string }>) {
  supabaseFrom.mockImplementation((table: string) => {
    if (table === 'brands') {
      return { select: () => ({ eq: () => ({ limit: async () => ({ data: ventures }) }) }) };
    }
    // contacts / ad_campaigns count queries — chain shape doesn't matter, only the tail.
    const chain: any = {
      select: () => chain, eq: () => chain, in: () => chain,
      then: (resolve: any) => resolve({ count: 0 }),
    };
    return chain;
  });
}

beforeEach(() => {
  supabaseFrom.mockReset();
  loadVentureContext.mockReset();
  loadVentureContext.mockResolvedValue(undefined);
});

describe('WHICH VENTURE block — presence is conditioned on brandId', () => {
  it('a turn WITH a selected venture (brandId present, profile found) gets CURRENT VENTURE and NOT the "which venture" prompt', async () => {
    mockSupabase([{ id: 'brand_1', name: 'Rentahub' }, { id: 'brand_2', name: 'FilmOps' }]);
    loadVentureContext.mockResolvedValue({
      name: 'Rentahub', description: 'Equipment rental marketplace', leadGoal: 'customers',
    });
    const { loadAgentContext } = await import('@/lib/agent/context');
    const block = await loadAgentContext({ accountId: 'acct_1', brandId: 'brand_1' });

    expect(block).toContain('CURRENT VENTURE');
    expect(block).toContain('Rentahub');
    expect(block).not.toContain('WHICH VENTURE');
  });

  it('a turn with NO venture selected, and more than one on the account, gets the "which venture" prompt', async () => {
    mockSupabase([{ id: 'brand_1', name: 'Rentahub' }, { id: 'brand_2', name: 'FilmOps' }]);
    const { loadAgentContext } = await import('@/lib/agent/context');
    const block = await loadAgentContext({ accountId: 'acct_1' });

    expect(block).toContain('WHICH VENTURE');
    expect(block).not.toContain('CURRENT VENTURE');
  });

  it('brandId is the ONLY thing that suppresses the prompt — even with a single venture on the account, no brandId still gets it (the rule "if exactly one, use it" lives INSIDE that same block, not as a separate branch)', async () => {
    mockSupabase([{ id: 'brand_1', name: 'Rentahub' }]);
    const { loadAgentContext } = await import('@/lib/agent/context');
    const block = await loadAgentContext({ accountId: 'acct_1' });

    expect(block).toContain('WHICH VENTURE');
    expect(block).toContain('exactly one venture');
    expect(block).not.toContain('CURRENT VENTURE');
  });
});
