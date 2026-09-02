// The route that scored images it had never seen.
//
// app/api/campaigns/[id]/assets/analyze put an image URL into a TEXT prompt,
// parsed the JSON that came back, and wrote `score` / `issues` /
// `recommendation` onto the asset row — flipping `status` to 'approved' or
// 'rejected' on the strength of it. A text model cannot open a URL. Every
// verdict was invented, and the invention mutated real state: an asset nobody
// had looked at could be marked rejected and dropped from a campaign.
//
// There is no vision path to fix it with — ChatMessage in lib/ai/opencode.ts is
// `{ role, content: string }` and nothing anywhere builds an image part. So the
// route refuses. What this file pins is BOTH halves of that refusal: the 501,
// and the fact that nothing is written. A 501 that still wrote a row would be
// the same defect wearing a different status code.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const updateCampaignAsset = vi.fn();
const getCampaignAssets = vi.fn();
const generateText = vi.fn();

vi.mock('@/lib/crm', () => ({
  updateCampaignAsset: (...a: any[]) => updateCampaignAsset(...a),
  getCampaignAssets: (...a: any[]) => getCampaignAssets(...a),
}));
vi.mock('@/lib/ai/opencode', () => ({
  generateText: (...a: any[]) => generateText(...a),
  opencodeConfigured: () => true,
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() },
  requestStore: { run: (_s: any, fn: any) => fn() },
  enrichContext: vi.fn(),
  currentContext: () => undefined,
}));
vi.mock('@/lib/session', () => ({
  verifySession: async () => ({ email: 'op@example.com', accountId: 'acct-1', role: 'owner', exp: 0 }),
  SESSION_COOKIE: 'ma_session',
}));

beforeEach(() => {
  vi.resetModules();
  updateCampaignAsset.mockReset();
  getCampaignAssets.mockReset().mockResolvedValue([
    { id: 'a1', kind: 'image', status: 'raw', url: 'https://cdn.example.com/hero.png' },
  ]);
  generateText.mockReset().mockResolvedValue('{"score":91,"issues":[],"recommendation":"approve"}');
});

async function callAnalyze() {
  const { POST } = await import('@/app/api/campaigns/[id]/assets/analyze/route');
  const req = new NextRequest('http://localhost/api/campaigns/camp-1/assets/analyze', { method: 'POST' });
  req.cookies.set('ma_session', 'token');
  return POST(req, { params: { id: 'camp-1' } } as any);
}

describe('campaign asset analysis refuses rather than inventing verdicts', () => {
  it('answers 501 not_supported', async () => {
    const res = await callAnalyze();
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error).toBe('not_supported');
    expect(body.message).toMatch(/vision/i);
  });

  it('writes NOTHING — the asset row is never touched', async () => {
    await callAnalyze();
    expect(updateCampaignAsset).not.toHaveBeenCalled();
  });

  it('does not even ask a text model about an image it cannot see', async () => {
    await callAnalyze();
    expect(generateText).not.toHaveBeenCalled();
  });
});
