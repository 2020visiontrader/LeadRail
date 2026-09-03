// GET /api/agent/models — the composer's model picker source list.
//
// Drives the REAL route (app/api/agent/models/route.ts) against a small
// in-memory stand-in for supabase.from, not a reimplementation of
// listSelectableModels — proves: only ENABLED models reach the response,
// and only for the session's account (a disabled provider/model, and
// another account's rows entirely, are both excluded).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const ACC = 'acct-1';
const OTHER_ACC = 'acct-2';

let providers: any[] = [];
let models: any[] = [];

function makeSupabase() {
  return {
    from(table: string) {
      if (table === 'ai_providers') {
        return {
          select: () => ({
            eq: (col1: string, val1: any) => ({
              eq: (col2: string, val2: any) => {
                const rows = providers.filter((p) => p[col1] === val1 && p[col2] === val2);
                return Promise.resolve({ data: rows, error: null });
              },
            }),
          }),
        };
      }
      if (table === 'ai_models') {
        return {
          select: () => ({
            in: (col: string, vals: any[]) => ({
              eq: (col2: string, val2: any) => ({
                order: () => {
                  const rows = models.filter((m) => vals.includes(m[col]) && m[col2] === val2);
                  return Promise.resolve({ data: rows, error: null });
                },
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

vi.mock('@/lib/db', () => ({ supabase: makeSupabase(), dbReady: () => true }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() },
  requestStore: { run: (_store: any, fn: any) => fn() },
  enrichContext: vi.fn(),
  currentContext: () => undefined as any,
}));
vi.mock('@/lib/session', () => ({
  verifySession: vi.fn(async () => ({ email: 'op@example.com', accountId: ACC, role: 'owner', exp: 0 })),
  SESSION_COOKIE: 'ma_session',
}));

beforeEach(() => {
  vi.clearAllMocks();
  providers = [
    { id: 'prov-1', account_id: ACC, name: 'Anthropic', enabled: true },
    { id: 'prov-2', account_id: ACC, name: 'Disabled Co', enabled: false },
    { id: 'prov-3', account_id: OTHER_ACC, name: 'Other Account Provider', enabled: true },
  ];
  models = [
    { id: 'model-1', provider_id: 'prov-1', model_id: 'claude-sonnet-5', label: 'Claude Sonnet 5', tier: 'heavy', enabled: true, created_at: '2026-01-01' },
    { id: 'model-2', provider_id: 'prov-1', model_id: 'claude-old', label: 'Claude Old', tier: 'fast', enabled: false, created_at: '2026-01-02' },
    // Belongs to a DISABLED provider — must not appear even though the model row itself is enabled.
    { id: 'model-3', provider_id: 'prov-2', model_id: 'some-model', label: 'Some Model', tier: 'fast', enabled: true, created_at: '2026-01-03' },
    // Belongs to another account entirely.
    { id: 'model-4', provider_id: 'prov-3', model_id: 'other-acct-model', label: 'Other Acct Model', tier: 'fast', enabled: true, created_at: '2026-01-04' },
  ];
});

function makeRequest() {
  return new NextRequest('http://localhost/api/agent/models', { method: 'GET' });
}

describe('GET /api/agent/models', () => {
  it('returns only ENABLED models (through an enabled provider) for the session account', async () => {
    const { GET } = await import('@/app/api/agent/models/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.models).toHaveLength(1);
    expect(body.models[0]).toMatchObject({ id: 'model-1', model_id: 'claude-sonnet-5', provider: 'Anthropic' });
  });

  it('never returns another account\'s configuration', async () => {
    const { GET } = await import('@/app/api/agent/models/route');
    const res = await GET(makeRequest());
    const body = await res.json();

    const ids = body.models.map((m: any) => m.id);
    expect(ids).not.toContain('model-4');
  });
});
