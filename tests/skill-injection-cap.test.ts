// C7 — cap on what a skill can inject into the system prompt.
//
// Measured in production: account_skills holds 353 enabled rows for one
// account, all created within a ~2.5 hour window on 2026-08-18, with zero
// disabled rows and no bulk-enable path in the app. Harvested skills average
// 11,269 chars and the largest is 94,247 — unbounded, that is up to ~377K
// chars injected into a single turn's system prompt (four routed skills at
// the largest measured size). This file proves the ceiling actually holds,
// via the REAL runAgent / runAgentStream loops (same harness as
// tests/persona-routing-loop.test.ts), not a reimplementation of skillsBlock.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateChat = vi.fn();
const loadPersonaForAgent = vi.fn(async (..._a: any[]) => null as any);
const listPersonas = vi.fn(async (..._a: any[]) => [] as any[]);

vi.mock('@/lib/ai/router', () => ({
  generateChat: (...a: any[]) => generateChat(...a),
  streamChat: vi.fn(),
  textConfigured: () => true,
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() },
}));
// Includes 'webSearch' so a skill naming it as a used capability shows up in
// the "[this work uses: ...]" bridge — proves that behaviour survives the cap.
vi.mock('@/lib/agent/tools', () => ({
  TOOLS: { webSearch: { title: 'Web search', run: vi.fn() } },
  runTool: vi.fn(),
  toolCatalogForPrompt: () => 'TOOLS',
  toolCatalogStaged: () => 'TOOLS',
  AGENT_STAGED_CATALOG: false,
  capabilityFor: () => undefined,
  toolsFromCapabilities: () => ({}),
}));
vi.mock('@/lib/capabilities/external-mcp', () => ({ loadExternalCapabilities: async () => [] }));
vi.mock('@/lib/agent/personas', async () => {
  const actual = await vi.importActual<typeof import('@/lib/agent/personas')>('@/lib/agent/personas');
  return {
    ...actual,
    loadPersonaForAgent: (...a: any[]) => loadPersonaForAgent(...a),
    resolveMentionedPersonas: async () => [],
    getCoordinator: async () => null,
    listPersonas: (...a: any[]) => listPersonas(...a),
  };
});
vi.mock('@/lib/agent/harvested-personas', () => ({ HARVESTED_PERSONA_TEMPLATES: [] }));

let enabledSkills: any[] = [];
vi.mock('@/lib/skills/store', () => ({ loadEnabledSkillsForAgent: async () => enabledSkills }));

vi.mock('@/lib/agent/compose', () => ({ composeAnswer: async (a: any) => a?.draft ?? '' }));
vi.mock('@/lib/approvals/store', () => ({
  createApproval: async () => null, consumeApprovalForExecution: vi.fn(),
  markApprovedByToolAndArgs: vi.fn(), recordExecutedApproval: vi.fn(),
  ApprovalExecutionError: class extends Error {},
}));
vi.mock('@/lib/approvals/grants', () => ({ consumeGrant: async () => null, isGrantable: () => false }));
vi.mock('@/lib/capabilities/delegation', () => ({
  beginDelegationScope: vi.fn(), endDelegationScope: vi.fn(), setDelegationContext: vi.fn(),
}));
vi.mock('@/lib/ai/hermes', () => ({ hermesRoute: async () => ({ skillIds: [] }) }));
vi.mock('@/lib/credits', () => ({ markParseOutcome: vi.fn(), recordAiUsage: vi.fn() }));
vi.mock('@/lib/db', () => ({ supabase: { from: () => ({}) }, dbReady: () => false }));
vi.mock('@/lib/storage', () => ({ putPrivate: vi.fn(), signUrl: vi.fn(), ensurePrivateBucket: vi.fn() }));
vi.mock('@/lib/ai/deck', () => ({ extractDeckText: vi.fn(), isSupportedDeck: () => false }));

const FINAL = JSON.stringify({ action: 'final', message: 'Done.' });

// Four skills at (or above) the largest measured production size. Kept under
// SKILL_ROUTING_THRESHOLD (8) so selectSkillsForTurn returns all four
// unfiltered — the low-count path this packet also has to bound, not just
// the routed (<=4) path.
function bigSkills() {
  return [
    { slug: 'skill-a', name: 'Skill A', instructions: 'A'.repeat(94247), capabilities: ['webSearch'] },
    { slug: 'skill-b', name: 'Skill B', instructions: 'B'.repeat(94247) },
    { slug: 'skill-c', name: 'Skill C', instructions: 'C'.repeat(94247) },
    { slug: 'skill-d', name: 'Skill D', instructions: 'D'.repeat(94247) },
  ];
}

function extractEnabledSkillsBlock(system: string): string {
  const start = system.indexOf('ENABLED SKILLS');
  expect(start).toBeGreaterThanOrEqual(0);
  // The skills block is followed by a blank line before "HOW YOU RESPOND:"
  // (systemPrompt's static section order — see the PROMPT BLOCK ORDER
  // comment in lib/agent/loop.ts). Slicing to that anchor isolates exactly
  // what skillsBlock() produced.
  const end = system.indexOf('HOW YOU RESPOND:', start);
  expect(end).toBeGreaterThan(start);
  return system.slice(start, end);
}

beforeEach(() => {
  vi.resetModules();
  generateChat.mockReset();
  loadPersonaForAgent.mockReset();
  loadPersonaForAgent.mockResolvedValue(null);
  listPersonas.mockReset();
  listPersonas.mockResolvedValue([]);
  enabledSkills = [];
});

describe('skillsBlock() — direct unit coverage', () => {
  it('never exceeds the total char budget even with four 94,247-char skills', async () => {
    const { skillsBlock, SKILL_TOTAL_CHAR_BUDGET } = await import('@/lib/agent/loop');
    const block = skillsBlock(bigSkills());
    // Total injected TEXT (excluding the fixed header line and bullet/marker
    // scaffolding) must stay within budget — that scaffolding is presentation,
    // not the unbounded part this packet bounds.
    const header = 'ENABLED SKILLS — apply this guidance when relevant to the current task:\n';
    expect(block.startsWith(header)).toBe(true);
    const body = block.slice(header.length);
    expect(body.length).toBeLessThanOrEqual(SKILL_TOTAL_CHAR_BUDGET + 4 * 200); // + bullet/marker scaffolding slack
    // The load-bearing assertion: strip everything but each skill's own
    // instructions text and confirm THAT sum is capped. The "[this work
    // uses: ...]" bridge (when present) itself contains a colon, so a naive
    // "strip up to the first colon" split over-matches into it — skip past
    // the "]: " that always closes that bridge first, and only fall back to
    // the first ": " when there's no bridge on this line.
    const instructionsOnly = body
      .split('\n')
      .map((line) => {
        const afterUses = line.indexOf(']: ');
        if (afterUses !== -1) return line.slice(afterUses + 3);
        const afterName = line.indexOf(': ');
        return afterName !== -1 ? line.slice(afterName + 2) : line;
      })
      .join('');
    expect(instructionsOnly.length).toBeLessThanOrEqual(SKILL_TOTAL_CHAR_BUDGET);
  });

  it('a clipped skill carries an explicit truncation marker naming describeSkill and its slug', async () => {
    const { skillsBlock } = await import('@/lib/agent/loop');
    const block = skillsBlock(bigSkills());
    expect(block).toContain('describeSkill("skill-a")');
    // Never a silent cut: the raw 94,247-char run of "A"s must not appear
    // whole — the skill's own text was clipped well below its full length.
    expect(block).not.toContain('A'.repeat(94247));
  });

  it('a short skill under both caps is injected verbatim, uncapped text intact', async () => {
    const { skillsBlock } = await import('@/lib/agent/loop');
    const block = skillsBlock([{ slug: 'skill-short', name: 'Short Skill', instructions: 'Always be concise.' }]);
    expect(block).toContain('Always be concise.');
    expect(block).not.toContain('truncated');
  });

  it('preserves the "[this work uses: ...]" capability-naming behaviour on a clipped skill', async () => {
    const { skillsBlock } = await import('@/lib/agent/loop');
    const block = skillsBlock(bigSkills());
    expect(block).toContain('Skill A [this work uses: webSearch]:');
  });

  it('clips at a paragraph or sentence boundary rather than mid-word, when one exists in budget', async () => {
    const { skillsBlock, SKILL_PER_SKILL_CHAR_CAP } = await import('@/lib/agent/loop');
    // A paragraph break sits just past the halfway point of the per-skill cap,
    // so the boundary-preferring clip should land there rather than mid-word
    // deep in the second paragraph.
    const firstPara = 'Guidance that matters. '.repeat(60); // ~1440 chars, < cap
    const secondPara = 'Zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'.repeat(40);
    const text = `${firstPara}\n\n${secondPara}`;
    expect(text.length).toBeGreaterThan(SKILL_PER_SKILL_CHAR_CAP);
    const block = skillsBlock([{ slug: 'skill-para', name: 'Para Skill', instructions: text }]);
    // Clipped at the paragraph boundary: the full first paragraph survives
    // intact and no word is severed mid-way.
    expect(block).toContain(firstPara.trim());
    expect(block).not.toMatch(/Zzzz+\s*\[\.\.\.truncated/); // didn't cut mid-run of the second paragraph's filler
  });
});

describe('runAgent / runAgentStream — the cap applies through the real system prompt (both loops)', () => {
  it('runAgentImpl: total skill text injected into the system prompt stays within budget', async () => {
    enabledSkills = bigSkills();
    generateChat.mockResolvedValueOnce(FINAL);

    const { runAgent, SKILL_TOTAL_CHAR_BUDGET } = await import('@/lib/agent/loop');
    await runAgent({ accountId: 'acct-1', message: 'help', conversationId: 'conv-1' });

    const system: string = generateChat.mock.calls[0][0].system;
    const block = extractEnabledSkillsBlock(system);
    expect(block).toContain('describeSkill(');
    expect(block.length).toBeLessThanOrEqual(SKILL_TOTAL_CHAR_BUDGET + 2000); // + header/scaffolding slack
  });

  it('runAgentStreamImpl: identical cap behaviour to runAgentImpl (CLAUDE.md: both loops stay identical)', async () => {
    enabledSkills = bigSkills();
    generateChat.mockResolvedValueOnce(FINAL);

    const { runAgentStream, SKILL_TOTAL_CHAR_BUDGET } = await import('@/lib/agent/loop');
    await runAgentStream({ accountId: 'acct-1', message: 'help', conversationId: 'conv-1' }, () => {});

    const system: string = generateChat.mock.calls[0][0].system;
    const block = extractEnabledSkillsBlock(system);
    expect(block).toContain('describeSkill(');
    expect(block.length).toBeLessThanOrEqual(SKILL_TOTAL_CHAR_BUDGET + 2000);
  });
});

describe('describeSkill capability — the expansion path for a clipped skill', () => {
  it('returns the full, unclipped instructions for an enabled skill by slug', async () => {
    vi.resetModules();
    const fullText = 'A'.repeat(94247);
    enabledSkills = [{ slug: 'skill-a', name: 'Skill A', instructions: fullText, capabilities: [] }];

    const { SKILL_LOOKUP_CAPABILITIES } = await import('@/lib/capabilities/skill-lookup');
    const describeSkill = SKILL_LOOKUP_CAPABILITIES.find((c) => c.name === 'describeSkill')!;
    expect(describeSkill).toBeDefined();

    const result = await describeSkill.run('acct-1', { slug: 'skill-a' });
    expect(result.found).toBe(true);
    expect(result.instructions).toBe(fullText);
    expect(result.instructions.length).toBe(94247);
  });

  it('reports not found for a slug the account does not have enabled', async () => {
    vi.resetModules();
    enabledSkills = [{ slug: 'skill-a', name: 'Skill A', instructions: 'x', capabilities: [] }];

    const { SKILL_LOOKUP_CAPABILITIES } = await import('@/lib/capabilities/skill-lookup');
    const describeSkill = SKILL_LOOKUP_CAPABILITIES.find((c) => c.name === 'describeSkill')!;
    const result = await describeSkill.run('acct-1', { slug: 'nonexistent-slug' });
    expect(result.found).toBe(false);
  });
});
