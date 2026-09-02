// getAiUsageSummary must not say more than it knows.
//
// TWO PRODUCTION DEFECTS, both measured on 2026-09-02 and both fixed in the
// same aggregate:
//
//  (a) A 7-day success rate hid recovery. The `opencode` tier read 13% —
//      3 ok / 24 calls — on a week where the last of its 21 failures was
//      2026-08-28 and its 3 successes were 2026-09-02. It had been healthy
//      for days and the panel reported it as broken. A rate alone cannot
//      express that; last_ok_at / last_failure_at can.
//
//  (b) The token totals were a covered subset labelled as a total. Zo Ask
//      answered 125 successful calls in that window and reported tokens on
//      none of them (its `{output}` body has no usage field), so the headline
//      "TOKENS IN 13,412,860" was the sum of the providers that report,
//      presented as the sum of everything. And with failed calls now carrying
//      OUR estimate (lib/ai/router.ts::failureUsage), silently adding those
//      in would turn the same figure into a mix of measurement and guess.
//
// Rows are fed through a stub `supabase` so this asserts on the aggregation
// itself, which is where both defects lived.

import { describe, it, expect, vi, beforeEach } from 'vitest';

let rows: any[] = [];

vi.mock('@/lib/db', () => ({
  supabase: {
    from() {
      const q: any = {
        select() { return q; },
        eq() { return q; },
        gte() { return q; },
        then(resolve: any) { return resolve({ data: rows, error: null }); },
      };
      return q;
    },
  },
}));

function row(over: Partial<Record<string, any>> = {}) {
  return {
    provider_id: 'p1', model_id: 'm1', model_label: 'opencode',
    tokens_in: null, tokens_out: null, ok: true,
    usage_source: 'none', created_at: '2026-09-02T10:00:00+00:00',
    ...over,
  };
}

describe('getAiUsageSummary', () => {
  beforeEach(() => { rows = []; });

  it('reports last success and last failure per model, so a recovered provider stops reading as dead', async () => {
    // The real opencode shape: all failures old, all successes recent.
    rows = [
      ...Array.from({ length: 21 }, () => row({ ok: false, created_at: '2026-08-28T13:45:40+00:00' })),
      ...Array.from({ length: 3 }, () => row({ ok: true, created_at: '2026-09-02T07:39:23+00:00' })),
    ];

    const { getAiUsageSummary } = await import('@/lib/credits');
    const [m] = await getAiUsageSummary('acct-1', 7);

    // The rate on its own still says 13% — that is not wrong, it is just
    // not enough, which is exactly the point.
    expect(m!.calls).toBe(24);
    expect(m!.ok_calls).toBe(3);
    expect(m!.last_failure_at).toBe('2026-08-28T13:45:40+00:00');
    expect(m!.last_ok_at).toBe('2026-09-02T07:39:23+00:00');
    expect(Date.parse(m!.last_ok_at!)).toBeGreaterThan(Date.parse(m!.last_failure_at!));
  });

  it('leaves last_ok_at / last_failure_at null when there has been no such call', async () => {
    rows = [row({ ok: false, created_at: '2026-08-28T13:45:40+00:00' })];
    const { getAiUsageSummary } = await import('@/lib/credits');
    const [m] = await getAiUsageSummary('acct-1', 7);
    expect(m!.last_ok_at).toBeNull();
    expect(m!.last_failure_at).toBe('2026-08-28T13:45:40+00:00');
  });

  it('keeps estimated tokens OUT of the reported total and reports them separately', async () => {
    rows = [
      row({ ok: true, usage_source: 'provider', tokens_in: 1000, tokens_out: 50 }),
      row({ ok: false, usage_source: 'estimated', tokens_in: 9000, tokens_out: null }),
    ];

    const { getAiUsageSummary } = await import('@/lib/credits');
    const [m] = await getAiUsageSummary('acct-1', 7);

    expect(m!.tokens_in).toBe(1000);             // NOT 10000
    expect(m!.tokens_in_estimated).toBe(9000);
    expect(m!.tokens_out).toBe(50);
  });

  it('reports how many calls the token totals actually cover', async () => {
    // The Zo Ask shape: successful calls that report nothing at all.
    rows = [
      row({ ok: true, usage_source: 'provider', tokens_in: 500, tokens_out: 10 }),
      row({ ok: true, usage_source: 'none', tokens_in: null, tokens_out: null }),
      row({ ok: true, usage_source: 'none', tokens_in: null, tokens_out: null }),
    ];

    const { getAiUsageSummary } = await import('@/lib/credits');
    const [m] = await getAiUsageSummary('acct-1', 7);

    expect(m!.calls).toBe(3);
    expect(m!.reported_calls).toBe(1);
    expect(m!.tokens_in).toBe(500);
  });
});
