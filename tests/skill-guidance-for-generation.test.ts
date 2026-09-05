// Packet: content/image generation never consulted the skills library.
// lib/skills/for-generation.ts is the bridge — this proves:
//   - guidance is produced when routing returns an enabled, prefix-matching skill
//   - a bare (unprefixed) slug returned by routing does NOT match a `harvested:`
//     enabled skill (the exact silent-failure mode the packet calls out)
//   - any failure (loadEnabledSkillsForAgent throwing, hermesRoute throwing,
//     hermesRoute timing out) never throws and returns ''
//   - the char/skill caps hold

import { describe, it, expect, vi, beforeEach } from 'vitest';

const loadEnabledSkillsForAgent = vi.fn();
const hermesRoute = vi.fn();

vi.mock('@/lib/skills/store', () => ({
  loadEnabledSkillsForAgent: (...a: any[]) => loadEnabledSkillsForAgent(...a),
}));
vi.mock('@/lib/ai/hermes', () => ({
  hermesRoute: (...a: any[]) => hermesRoute(...a),
}));

beforeEach(() => {
  loadEnabledSkillsForAgent.mockReset();
  hermesRoute.mockReset();
});

describe('skillGuidanceForGeneration', () => {
  it('returns guidance text when routing returns a skill the account has enabled (prefixed form matches prefixed form)', async () => {
    loadEnabledSkillsForAgent.mockResolvedValue([
      { slug: 'harvested:ad-creative', name: 'Ad Creative', instructions: 'Lead with the offer, not the brand.' },
    ]);
    hermesRoute.mockResolvedValue({ skillIds: ['harvested:ad-creative'] });

    const { skillGuidanceForGeneration } = await import('@/lib/skills/for-generation');
    const guidance = await skillGuidanceForGeneration('acct-1', { kind: 'ad copy', platform: 'instagram', topic: 'summer sale' });

    expect(guidance).toContain('Ad Creative');
    expect(guidance).toContain('Lead with the offer, not the brand.');
  });

  // REVERT-CHECK candidate: comment out the `harvested:` prefix on the enabled
  // skill's slug (leaving hermesRoute's prefixed skillIds untouched) and this
  // must go back to failing (empty string) — proving the intersection is a
  // real prefix-sensitive match, not something that happens to pass either way.
  it('does NOT match a bare slug against a `harvested:`-prefixed routed id — the exact silent-failure mode this packet calls out', async () => {
    loadEnabledSkillsForAgent.mockResolvedValue([
      // Enabled skill stored WITHOUT the prefix — wrong, but exactly the bug
      // shape the brief warns about if someone strips or forgets the prefix.
      { slug: 'ad-creative', name: 'Ad Creative', instructions: 'Lead with the offer, not the brand.' },
    ]);
    hermesRoute.mockResolvedValue({ skillIds: ['harvested:ad-creative'] });

    const { skillGuidanceForGeneration } = await import('@/lib/skills/for-generation');
    const guidance = await skillGuidanceForGeneration('acct-1', { kind: 'ad copy', platform: 'instagram', topic: 'summer sale' });

    expect(guidance).toBe('');
  });

  it('returns "" with no accountId, without calling routing at all', async () => {
    const { skillGuidanceForGeneration } = await import('@/lib/skills/for-generation');
    const guidance = await skillGuidanceForGeneration(undefined, { kind: 'ad copy', platform: 'ig', topic: 'x' });
    expect(guidance).toBe('');
    expect(loadEnabledSkillsForAgent).not.toHaveBeenCalled();
  });

  it('returns "" when the account has no enabled skills', async () => {
    loadEnabledSkillsForAgent.mockResolvedValue([]);
    const { skillGuidanceForGeneration } = await import('@/lib/skills/for-generation');
    const guidance = await skillGuidanceForGeneration('acct-1', { kind: 'ad copy', platform: 'ig', topic: 'x' });
    expect(guidance).toBe('');
    expect(hermesRoute).not.toHaveBeenCalled();
  });

  it('never throws when loadEnabledSkillsForAgent rejects — returns "" instead', async () => {
    loadEnabledSkillsForAgent.mockRejectedValue(new Error('db down'));
    const { skillGuidanceForGeneration } = await import('@/lib/skills/for-generation');
    await expect(skillGuidanceForGeneration('acct-1', { kind: 'ad copy', platform: 'ig', topic: 'x' })).resolves.toBe('');
  });

  it('never throws when hermesRoute rejects (e.g. a routing timeout) — returns "" instead', async () => {
    loadEnabledSkillsForAgent.mockResolvedValue([
      { slug: 'harvested:ad-creative', name: 'Ad Creative', instructions: 'x' },
    ]);
    hermesRoute.mockRejectedValue(new Error('deadline exceeded'));
    const { skillGuidanceForGeneration } = await import('@/lib/skills/for-generation');
    await expect(skillGuidanceForGeneration('acct-1', { kind: 'ad copy', platform: 'ig', topic: 'x' })).resolves.toBe('');
  });

  it('caps at GENERATION_MAX_SKILLS even when routing returns more matches', async () => {
    loadEnabledSkillsForAgent.mockResolvedValue([
      { slug: 'harvested:a', name: 'A', instructions: 'one' },
      { slug: 'harvested:b', name: 'B', instructions: 'two' },
      { slug: 'harvested:c', name: 'C', instructions: 'three' },
    ]);
    hermesRoute.mockResolvedValue({ skillIds: ['harvested:a', 'harvested:b', 'harvested:c'] });

    const { skillGuidanceForGeneration, GENERATION_MAX_SKILLS } = await import('@/lib/skills/for-generation');
    expect(GENERATION_MAX_SKILLS).toBe(2);
    const guidance = await skillGuidanceForGeneration('acct-1', { kind: 'ad copy', platform: 'ig', topic: 'x' });
    expect(guidance).toContain('A');
    expect(guidance).toContain('B');
    expect(guidance).not.toContain('• C:');
  });

  it('never exceeds GENERATION_TOTAL_CHAR_BUDGET worth of instruction text', async () => {
    loadEnabledSkillsForAgent.mockResolvedValue([
      { slug: 'harvested:a', name: 'A', instructions: 'X'.repeat(50_000) },
      { slug: 'harvested:b', name: 'B', instructions: 'Y'.repeat(50_000) },
    ]);
    hermesRoute.mockResolvedValue({ skillIds: ['harvested:a', 'harvested:b'] });

    const { skillGuidanceForGeneration, GENERATION_TOTAL_CHAR_BUDGET } = await import('@/lib/skills/for-generation');
    const guidance = await skillGuidanceForGeneration('acct-1', { kind: 'ad copy', platform: 'ig', topic: 'x' });
    const instructionsOnly = guidance
      .split('\n')
      .map((line) => {
        const i = line.indexOf(': ');
        return i !== -1 ? line.slice(i + 2) : line;
      })
      .join('');
    expect(instructionsOnly.length).toBeLessThanOrEqual(GENERATION_TOTAL_CHAR_BUDGET);
  });
});
