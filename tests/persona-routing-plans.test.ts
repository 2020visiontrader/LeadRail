// BACKLOG 5b — createPlan (lib/capabilities/plans.ts) pins a persona derived
// from the skills Hermes routed for the plan's objective, using
// lib/agent/persona-routing.ts. Only a DB ROW can be pinned (plans.personaId
// is a row FK) — a template-only match pins nothing.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const hermesRoute = vi.fn();
const listPersonas = vi.fn(async (..._a: any[]) => [] as any[]);
const createPlanMock = vi.fn(async (args: any) => ({
  id: 'plan-1', status: args.requireApproval ? 'draft' : 'active',
  steps: args.steps.map((title: string, i: number) => ({ seq: i, title })),
  skills: args.skills, personaId: args.personaId,
}));

vi.mock('@/lib/ai/hermes', () => ({ hermesRoute: (...a: any[]) => hermesRoute(...a) }));
vi.mock('@/lib/agent/personas', () => ({ listPersonas: (...a: any[]) => listPersonas(...a) }));
vi.mock('@/lib/plans/store', () => ({
  createPlan: (a: any) => createPlanMock(a),
  getPlan: vi.fn(), activePlanForConversation: vi.fn(), completeStep: vi.fn(),
  blockStep: vi.fn(), cancelPlans: vi.fn(), renderPlan: vi.fn(), MAX_PLAN_STEPS: 16,
}));

const SKILL_ROW = (slug: string, instructions: string) => ({ slug, instructions });

let enabledSkills: any[] = [];
vi.mock('@/lib/skills/store', () => ({ loadEnabledSkillsForAgent: async () => enabledSkills }));

vi.mock('@/lib/agent/harvested-personas', () => ({
  HARVESTED_PERSONA_TEMPLATES: [
    {
      slug: 'seo-specialist', name: 'SEO Specialist', description: 'd', role: 'seo-specialist',
      instructions: 'template', domain: 'shared', sourceRepo: 'x', sourceCommit: 'x',
      sourcePath: 'x', license: 'MIT',
    },
  ],
}));

const ROW = {
  id: 'row-1', account_id: 'acct-1', name: 'Content Creator', role: 'content-creator',
  instructions: 'row', model_id: null, tone: null, avatar: null, is_coordinator: false,
  enabled: true, sort_order: 0, created_at: '', updated_at: '',
};

beforeEach(() => {
  vi.resetModules();
  hermesRoute.mockReset();
  listPersonas.mockReset();
  listPersonas.mockResolvedValue([]);
  createPlanMock.mockClear();
  enabledSkills = [];
});

describe('createPlan — persona pin derived from routed skills', () => {
  it('pins the row when the winning persona resolves to a matching, enabled, non-coordinator row', async () => {
    enabledSkills = [SKILL_ROW('skill-a', '## Agents Used\n\n- **content-creator** — writes copy')];
    hermesRoute.mockResolvedValue({ skillIds: ['skill-a'] });
    listPersonas.mockResolvedValue([ROW]);

    const { PLAN_CAPABILITIES } = await import('@/lib/capabilities/plans');
    const createPlanCap = PLAN_CAPABILITIES.find((c) => c.name === 'createPlan')!;
    await createPlanCap.run('acct-1', { objective: 'write some copy', steps: ['a', 'b'] }, {});

    expect(createPlanMock).toHaveBeenCalledTimes(1);
    expect(createPlanMock.mock.calls[0][0].personaId).toBe('row-1');
  });

  it('pins null when only a template matches (no row) — never invents a row', async () => {
    enabledSkills = [SKILL_ROW('skill-b', '## Agents Used\n\n- **seo-specialist** — does SEO')];
    hermesRoute.mockResolvedValue({ skillIds: ['skill-b'] });
    listPersonas.mockResolvedValue([]); // no rows at all

    const { PLAN_CAPABILITIES } = await import('@/lib/capabilities/plans');
    const createPlanCap = PLAN_CAPABILITIES.find((c) => c.name === 'createPlan')!;
    await createPlanCap.run('acct-1', { objective: 'improve SEO', steps: ['a', 'b'] }, {});

    expect(createPlanMock).toHaveBeenCalledTimes(1);
    expect(createPlanMock.mock.calls[0][0].personaId).toBeNull();
  });

  it('pins null when no routed skill names a persona at all', async () => {
    enabledSkills = [SKILL_ROW('skill-c', 'no agents section here')];
    hermesRoute.mockResolvedValue({ skillIds: ['skill-c'] });

    const { PLAN_CAPABILITIES } = await import('@/lib/capabilities/plans');
    const createPlanCap = PLAN_CAPABILITIES.find((c) => c.name === 'createPlan')!;
    await createPlanCap.run('acct-1', { objective: 'do a thing', steps: ['a', 'b'] }, {});

    expect(createPlanMock.mock.calls[0][0].personaId).toBeNull();
  });
});
