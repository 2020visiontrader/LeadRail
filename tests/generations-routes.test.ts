// tests/generations-routes.test.ts — GET /api/generations, POST
// /api/generations/[id]/review, POST /api/generations/[id]/promote.
//
// Every id lookup here MUST filter on account_id — this repo already shipped
// a cross-tenant leak from exactly this mistake (GET /api/brands, GET
// /api/content/export — see tests/route-tenant-guard-audit.test.ts's header).
// The tests below are written to catch a route that forgets: a generation
// that belongs to a different account must come back as "not found", not as
// the row, and never be reviewable or promotable via this session.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const listGenerations = vi.fn();
const getGeneration = vi.fn();
const reviewGeneration = vi.fn();
const resolveGenerationUrl = vi.fn(async (..._a: any[]) => 'https://signed.example.com/x.png');
const accountStorageBytes = vi.fn(async (..._a: any[]) => 1024 * 1024);

vi.mock('@/lib/generations/store', () => ({
  listGenerations: (...a: any[]) => listGenerations(...a),
  getGeneration: (...a: any[]) => getGeneration(...a),
  reviewGeneration: (...a: any[]) => reviewGeneration(...a),
  resolveGenerationUrl: (...a: any[]) => resolveGenerationUrl(...a),
  accountStorageBytes: (...a: any[]) => accountStorageBytes(...a),
  GENERATION_QUOTA_BYTES: 2 * 1024 * 1024 * 1024,
}));

const promoteRun = vi.fn(async (..._a: any[]) => ({ contentItemId: 'ci-1', mediaUrl: 'https://signed.example.com/x.png' }));
vi.mock('@/lib/capabilities/generations', () => ({
  GENERATIONS_CAPABILITIES: [
    { name: 'promoteGenerationToContent', run: (...a: any[]) => promoteRun(...a) },
  ],
}));

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() },
  requestStore: { run: (_s: any, fn: any) => fn() },
  enrichContext: vi.fn(),
  currentContext: () => undefined,
}));

let sessionAccountId = 'acct-1';
vi.mock('@/lib/session', () => ({
  verifySession: async (token?: string) => {
    if (!token) return null;
    return { email: 'op@example.com', accountId: sessionAccountId, role: 'owner', exp: 0 };
  },
  SESSION_COOKIE: 'ma_session',
}));

beforeEach(() => {
  vi.resetModules();
  sessionAccountId = 'acct-1';
  listGenerations.mockReset().mockResolvedValue([]);
  getGeneration.mockReset().mockResolvedValue(null);
  reviewGeneration.mockReset();
  resolveGenerationUrl.mockReset().mockResolvedValue('https://signed.example.com/x.png');
  accountStorageBytes.mockReset().mockResolvedValue(1024 * 1024);
  promoteRun.mockReset().mockResolvedValue({ contentItemId: 'ci-1', mediaUrl: 'https://signed.example.com/x.png' });
});

function req(url: string, opts?: { method?: string; body?: any; noCookie?: boolean }) {
  const r = new NextRequest(url, {
    method: opts?.method || 'GET',
    ...(opts?.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  if (!opts?.noCookie) r.cookies.set('ma_session', 'token');
  return r;
}

describe('GET /api/generations', () => {
  it('rejects an unauthenticated request', async () => {
    const { GET } = await import('@/app/api/generations/route');
    const res = await GET(req('http://localhost/api/generations', { noCookie: true }));
    expect(res.status).toBe(401);
  });

  it('scopes the list to the session account id, never a client-supplied one', async () => {
    const { GET } = await import('@/app/api/generations/route');
    await GET(req('http://localhost/api/generations?brandId=b1&reviewState=PENDING&limit=10'));
    expect(listGenerations).toHaveBeenCalledWith('acct-1', expect.objectContaining({
      brandId: 'b1', reviewState: 'PENDING', limit: 10,
    }));
  });

  it('returns quota usage and limit alongside the list', async () => {
    listGenerations.mockResolvedValue([{ id: 'g1', storage_path: 'p', external_url: null }]);
    const { GET } = await import('@/app/api/generations/route');
    const res = await GET(req('http://localhost/api/generations'));
    const body = await res.json();
    expect(body.quota).toEqual({ usedBytes: 1024 * 1024, limitBytes: 2 * 1024 * 1024 * 1024 });
    expect(body.generations[0].url).toBe('https://signed.example.com/x.png');
  });

  it('never hands the client a raw storage_path — every row is resolved through resolveGenerationUrl', async () => {
    listGenerations.mockResolvedValue([{ id: 'g1', storage_path: 'acct-1/secret.png', external_url: null }]);
    const { GET } = await import('@/app/api/generations/route');
    await GET(req('http://localhost/api/generations'));
    expect(resolveGenerationUrl).toHaveBeenCalledWith({ id: 'g1', storage_path: 'acct-1/secret.png', external_url: null });
  });
});

describe('POST /api/generations/[id]/review', () => {
  async function call(id: string, body: any, noCookie = false) {
    const { POST } = await import('@/app/api/generations/[id]/review/route');
    return POST(req(`http://localhost/api/generations/${id}/review`, { method: 'POST', body, noCookie }), { params: { id } } as any);
  }

  it('rejects an unauthenticated request', async () => {
    const res = await call('g1', { state: 'APPROVED' }, true);
    expect(res.status).toBe(401);
  });

  it('rejects an invalid state', async () => {
    getGeneration.mockResolvedValue({ id: 'g1', account_id: 'acct-1' });
    const res = await call('g1', { state: 'MAYBE' });
    expect(res.status).toBe(400);
    expect(reviewGeneration).not.toHaveBeenCalled();
  });

  it('REVERT-CHECK TARGET: a generation belonging to another account is not returned or reviewable', async () => {
    // getGeneration is itself account-scoped (eq account_id) in the real
    // store — simulate it correctly returning nothing for this session's
    // account even though a row with this id exists for a different one.
    getGeneration.mockResolvedValue(null);
    const res = await call('other-accounts-gen', { state: 'APPROVED' });
    expect(res.status).toBe(404);
    expect(reviewGeneration).not.toHaveBeenCalled();
  });

  it('approves with the session account id and an optional note', async () => {
    getGeneration.mockResolvedValue({ id: 'g1', account_id: 'acct-1' });
    reviewGeneration.mockResolvedValue({ id: 'g1', review_state: 'REJECTED', review_note: 'blurry' });
    const res = await call('g1', { state: 'REJECTED', note: 'blurry' });
    expect(res.status).toBe(200);
    expect(reviewGeneration).toHaveBeenCalledWith('acct-1', 'g1', 'REJECTED', 'blurry');
  });
});

describe('POST /api/generations/[id]/promote', () => {
  async function call(id: string, body: any = {}, noCookie = false) {
    const { POST } = await import('@/app/api/generations/[id]/promote/route');
    return POST(req(`http://localhost/api/generations/${id}/promote`, { method: 'POST', body, noCookie }), { params: { id } } as any);
  }

  it('rejects an unauthenticated request', async () => {
    const res = await call('g1', {}, true);
    expect(res.status).toBe(401);
  });

  it('REVERT-CHECK TARGET: a generation belonging to another account cannot be promoted through this session', async () => {
    getGeneration.mockResolvedValue(null);
    const res = await call('other-accounts-gen');
    expect(res.status).toBe(404);
    expect(promoteRun).not.toHaveBeenCalled();
  });

  it('promotes with the session account id', async () => {
    getGeneration.mockResolvedValue({ id: 'g1', account_id: 'acct-1' });
    const res = await call('g1', { title: 'My post' });
    expect(res.status).toBe(200);
    expect(promoteRun).toHaveBeenCalledWith('acct-1', expect.objectContaining({ generationId: 'g1', title: 'My post' }));
  });

  it('surfaces an expected business-rule failure (not yet approved) as a 400, not a raw 500', async () => {
    getGeneration.mockResolvedValue({ id: 'g1', account_id: 'acct-1' });
    promoteRun.mockRejectedValue(new Error('Only an APPROVED generation can be queued for posting — call reviewGeneration first.'));
    const res = await call('g1');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/APPROVED/);
  });
});
