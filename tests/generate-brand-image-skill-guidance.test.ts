// generateBrandImage (lib/capabilities/content.ts) previously built its image
// prompt from ref.description + the scene only, with no skills-library
// consultation. This proves guidance is appended, and — the load-bearing
// assertion — that it is appended WITHOUT disturbing the existing
// character-reference contract: ref.description leads, "Scene: ..." follows
// immediately, and styleLock is still appended verbatim, last, by the image
// client (untouched by this change since it is a separate field).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const skillGuidanceForGeneration = vi.fn(async (..._a: any[]) => '');
const routeImage = vi.fn(async (..._a: any[]) => ({ base64: 'AA==', mimeType: 'image/png' }));
const getCharacterRef = vi.fn(async (..._a: any[]) => undefined as any);
const resolveCharacterRefUrl = vi.fn(async (..._a: any[]) => 'https://example.com/ref.png');
const recordMediaGeneration = vi.fn(async (..._a: any[]) => ({ storagePath: 'p', url: 'https://example.com/out.png', generationId: 'gen-1' }));

vi.mock('@/lib/skills/for-generation', () => ({ skillGuidanceForGeneration: (...a: any[]) => skillGuidanceForGeneration(...a) }));
vi.mock('@/lib/ai/image-router', () => ({ generateImage: (...a: any[]) => routeImage(...a) }));
vi.mock('@/lib/generations/store', () => ({
  recordMediaGeneration: (...a: any[]) => recordMediaGeneration(...a),
  recordExternalVideoGeneration: vi.fn(),
}));
vi.mock('@/lib/content/store', () => ({
  listPillars: vi.fn(), createPillar: vi.fn(), deletePillar: vi.fn(),
  listPlatformSpecs: vi.fn(), getPlatformSpec: vi.fn(), upsertPlatformSpec: vi.fn(),
  listCharacterRefs: vi.fn(),
  getCharacterRef: (...a: any[]) => getCharacterRef(...a),
  createCharacterRef: vi.fn(),
  resolveCharacterRefUrl: (...a: any[]) => resolveCharacterRefUrl(...a),
  createContentItem: vi.fn(), listContentItems: vi.fn(), getContentItem: vi.fn(), updateContentItem: vi.fn(),
  setContentStatus: vi.fn(), deleteContentItem: vi.fn(), contentBoardSummary: vi.fn(),
  CONTENT_STATUSES: ['DRAFT', 'PUBLISHED'],
  FUNNEL_STAGES: ['TOFU', 'MOFU', 'BOFU'],
}));
vi.mock('@/lib/content/engine', () => ({ generateContent: vi.fn() }));
vi.mock('@/lib/content/canon', () => ({ loadCanon: vi.fn(), saveCanon: vi.fn(), scoreLinearity: vi.fn() }));
vi.mock('@/lib/content/research', () => ({ runResearchSweep: vi.fn(), listFindings: vi.fn(), RESEARCH_PASSES: [] }));
vi.mock('@/lib/content/performance', () => ({ syncPerformance: vi.fn(), performanceReport: vi.fn() }));
vi.mock('@/lib/content/learning', () => ({ proposeLearning: vi.fn() }));
vi.mock('@/lib/content/intake', () => ({ runIntake: vi.fn(), proposeCanon: vi.fn() }));
vi.mock('@/lib/integrations/higgsfield', () => ({ generateVideo: vi.fn(), getVideoStatus: vi.fn(), higgsfieldUnavailableReason: vi.fn() }));

beforeEach(() => {
  skillGuidanceForGeneration.mockReset();
  skillGuidanceForGeneration.mockResolvedValue('');
  routeImage.mockClear();
  getCharacterRef.mockReset();
  recordMediaGeneration.mockClear();
});

async function runGenerateBrandImage(args: any) {
  const { CONTENT_CAPABILITIES } = await import('@/lib/capabilities/content');
  const cap = CONTENT_CAPABILITIES.find((c) => c.name === 'generateBrandImage')!;
  return cap.run('acct-1', args);
}

describe('generateBrandImage — skill guidance in the image prompt', () => {
  it('sends the prompt unchanged (no guidance section) when no guidance is returned', async () => {
    await runGenerateBrandImage({ prompt: 'a cat on a skateboard' });
    const sentPrompt: string = routeImage.mock.calls[0][0].prompt;
    expect(sentPrompt).toBe('a cat on a skateboard');
    expect(sentPrompt).not.toContain('HOUSE SKILL GUIDANCE');
  });

  it('appends guidance after the prompt, labeled as instruction not on-image text, when guidance is returned', async () => {
    skillGuidanceForGeneration.mockResolvedValue('• Ads Photoshoot: use soft studio lighting.');
    await runGenerateBrandImage({ prompt: 'a cat on a skateboard' });
    const sentPrompt: string = routeImage.mock.calls[0][0].prompt;
    expect(sentPrompt).toContain('a cat on a skateboard');
    expect(sentPrompt).toContain('HOUSE SKILL GUIDANCE');
    expect(sentPrompt).toContain('use soft studio lighting.');
    expect(sentPrompt).toContain('not text to render on the image itself');
    // Guidance must come AFTER the base prompt, never before it.
    expect(sentPrompt.indexOf('a cat on a skateboard')).toBeLessThan(sentPrompt.indexOf('HOUSE SKILL GUIDANCE'));
  });

  it('preserves the character-reference contract: ref.description leads, "Scene:" follows immediately, guidance comes after — styleLock is a separate field entirely, untouched', async () => {
    getCharacterRef.mockResolvedValue({
      id: 'ref-1',
      description: 'Ada: a friendly presenter with short brown hair, navy blazer.',
      style_lock: 'Studio Ghibli-inspired flat illustration style.',
    });
    skillGuidanceForGeneration.mockResolvedValue('• Ads Photoshoot: use soft studio lighting.');

    await runGenerateBrandImage({ prompt: 'presenting a laptop', characterRefId: 'ref-1' });

    const call = routeImage.mock.calls[0][0];
    const sentPrompt: string = call.prompt;
    // ref.description leads.
    expect(sentPrompt.startsWith('Ada: a friendly presenter with short brown hair, navy blazer.')).toBe(true);
    // Scene follows immediately after the description.
    expect(sentPrompt).toContain('Ada: a friendly presenter with short brown hair, navy blazer.\n\nScene: presenting a laptop');
    // Guidance comes after description+scene.
    const sceneIdx = sentPrompt.indexOf('Scene: presenting a laptop');
    const guidanceIdx = sentPrompt.indexOf('HOUSE SKILL GUIDANCE');
    expect(guidanceIdx).toBeGreaterThan(sceneIdx);
    // styleLock is passed through as its OWN field, verbatim, never folded
    // into `prompt` here — lib/ai/gemini.ts appends it last, downstream.
    expect(call.styleLock).toBe('Studio Ghibli-inspired flat illustration style.');
    expect(sentPrompt).not.toContain('Studio Ghibli-inspired flat illustration style.');
  });
});
