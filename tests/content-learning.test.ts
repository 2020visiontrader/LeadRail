// The learning loop's value is entirely in what it REFUSES to say.
//
// A loop that proposes something on every run gets acted on, and acting on
// noise is worse than not looking — it moves the brand for no reason and does
// it with a number attached, which makes the move look considered. So these
// tests pin the restraint, not the reasoning: thin samples produce nothing,
// small gaps produce nothing, and confidence never exceeds moderate no matter
// how much data arrives, because this is observational data with no control
// for timing or format.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const perf = vi.fn();
const findings = vi.fn();
const canon = vi.fn();

vi.mock('../lib/content/performance', () => ({ performanceReport: (...a: any[]) => perf(...a) }));
vi.mock('../lib/content/research', () => ({ listFindings: (...a: any[]) => findings(...a) }));
vi.mock('../lib/content/canon', () => ({ loadCanon: (...a: any[]) => canon(...a) }));

const { proposeLearning } = await import('../lib/content/learning');

const pillar = (value: string, medianEngagement: number, sample: number) =>
  ({ dimension: 'pillar' as const, value, medianEngagement, sample });

beforeEach(() => {
  vi.clearAllMocks();
  findings.mockResolvedValue([{ created_at: new Date().toISOString() }]);
  canon.mockResolvedValue({ coreThesis: 'A thesis' });
});

const run = () => proposeLearning({ accountId: 'a', brandId: 'b' });

describe('restraint', () => {
  it('proposes nothing when each pillar has too few pieces', async () => {
    perf.mockResolvedValue({ scored: 8, caveats: [], observations: [pillar('A', 100, 4), pillar('B', 10, 4)] });
    const r = await run();
    expect(r.proposals.filter((p) => p.kind === 'pillar_emphasis')).toHaveLength(0);
  });

  it('proposes nothing when the gap is within noise', async () => {
    perf.mockResolvedValue({ scored: 40, caveats: [], observations: [pillar('A', 105, 20), pillar('B', 100, 20)] });
    const r = await run();
    expect(r.proposals.filter((p) => p.kind === 'pillar_emphasis')).toHaveLength(0);
    expect(r.caveats.join(' ')).toMatch(/clearly outperformed/i);
  });

  it('says so plainly when there is nothing to say', async () => {
    perf.mockResolvedValue({ scored: 0, caveats: [], observations: [] });
    const r = await run();
    expect(r.proposals).toHaveLength(0);
    expect(r.caveats.length).toBeGreaterThan(0);
  });
});

describe('when it does speak', () => {
  it('proposes on a real gap with real samples, and carries its evidence', async () => {
    perf.mockResolvedValue({ scored: 40, caveats: [], observations: [pillar('A', 200, 20), pillar('B', 100, 20)] });
    const r = await run();
    const p = r.proposals.find((x) => x.kind === 'pillar_emphasis');
    expect(p).toBeDefined();
    expect(p!.evidence).toMatch(/20/);
    expect(p!.suggestion).toMatch(/consider/i);
  });

  it('never claims more than moderate confidence', async () => {
    perf.mockResolvedValue({ scored: 2000, caveats: [], observations: [pillar('A', 900, 1000), pillar('B', 10, 1000)] });
    const r = await run();
    for (const p of r.proposals) expect(['low', 'moderate']).toContain(p.confidence);
  });
});

describe('governance', () => {
  it('states that nothing was written, on every report', async () => {
    perf.mockResolvedValue({ scored: 40, caveats: [], observations: [pillar('A', 200, 20), pillar('B', 100, 20)] });
    const r = await run();
    expect(r.governance).toMatch(/nothing has been written/i);
  });

  it('flags stale research rather than acting confidently on an old market picture', async () => {
    perf.mockResolvedValue({ scored: 40, caveats: [], observations: [] });
    findings.mockResolvedValue([{ created_at: new Date(Date.now() - 120 * 86_400_000).toISOString() }]);
    const r = await run();
    expect(r.proposals.some((p) => p.kind === 'research_refresh')).toBe(true);
  });

  it('notes when there is no thesis to judge anything against', async () => {
    perf.mockResolvedValue({ scored: 0, caveats: [], observations: [] });
    canon.mockResolvedValue(null);
    const r = await run();
    expect(r.caveats.join(' ')).toMatch(/no core thesis/i);
  });
});
