// Per-client half of the turn-deadline fix (see lib/ai/deadline.ts and the
// THE MECHANISM/THE FIX comments in this change). Each of zoask/opencode/
// openrouter gets its abort timer tightened to min(providerTimeout,
// remaining), refuses to start an attempt once the deadline has already
// passed, and — for openrouter, which owns a MODEL_CHAIN retry loop — stops
// trying further models rather than burning the whole chain past the
// deadline. Every test also proves the additive guarantee: omit deadlineAt
// and the client behaves exactly as it did before this file existed.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  // Cleanup must not depend on reaching the end of a test body — an
  // assertion that throws mid-test would otherwise leak this into later
  // tests (observed: a failing assertion above left OPENROUTER_MODEL set,
  // which then broke an unrelated later test's own sanity check).
  delete process.env.OPENROUTER_MODEL;
});

// ---------------------------------------------------------------------------
// Zo Ask — single attempt, no internal chain.
// ---------------------------------------------------------------------------
describe('zoask abort timer', () => {
  it('uses the full TIMEOUT_MS with no deadline (additive guarantee)', async () => {
    process.env.ZO_API_KEY = 'k';
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ output: 'hi' }) });
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    const { zoAskText } = await import('@/lib/ai/zoask');

    await zoAskText({ prompt: 'hi' });

    const ms = setTimeoutSpy.mock.calls[0][1];
    expect(ms).toBe(120_000);
  });

  it('tightens the timer to the remaining time when a deadline is closer', async () => {
    process.env.ZO_API_KEY = 'k';
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ output: 'hi' }) });
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    const { zoAskText } = await import('@/lib/ai/zoask');

    await zoAskText({ prompt: 'hi', deadlineAt: Date.now() + 4_000 });

    const ms = setTimeoutSpy.mock.calls[0][1] as number;
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(4_000);
    // Never larger than today's constant — this may only tighten.
    expect(ms).toBeLessThan(120_000);
  });

  it('refuses to start an attempt once the deadline has already passed', async () => {
    process.env.ZO_API_KEY = 'k';
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ output: 'hi' }) });
    const { zoAskText } = await import('@/lib/ai/zoask');

    await expect(zoAskText({ prompt: 'hi', deadlineAt: Date.now() - 1 })).rejects.toMatchObject({
      code: 'deadline_exceeded',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// OpenCode — single attempt plus one internal self-heal retry.
// ---------------------------------------------------------------------------
describe('opencode abort timer', () => {
  it('uses the full TIMEOUT_MS with no deadline (additive guarantee)', async () => {
    process.env.OPENCODE_API_KEY = 'k';
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'hi' } }] }),
    });
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    const { generateText } = await import('@/lib/ai/opencode');

    await generateText({ prompt: 'hi' });

    expect(setTimeoutSpy.mock.calls[0][1]).toBe(35_000);
  });

  it('tightens the timer to the remaining time when a deadline is closer', async () => {
    process.env.OPENCODE_API_KEY = 'k';
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'hi' } }] }),
    });
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    const { generateText } = await import('@/lib/ai/opencode');

    await generateText({ prompt: 'hi', deadlineAt: Date.now() + 3_000 });

    const ms = setTimeoutSpy.mock.calls[0][1] as number;
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(3_000);
    expect(ms).toBeLessThan(35_000);
  });

  it('refuses to start an attempt once the deadline has already passed', async () => {
    process.env.OPENCODE_API_KEY = 'k';
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'hi' } }] }),
    });
    const { generateText } = await import('@/lib/ai/opencode');

    await expect(generateText({ prompt: 'hi', deadlineAt: Date.now() - 1 })).rejects.toMatchObject({
      code: 'deadline_exceeded',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips the empty-content self-heal retry once the deadline has passed mid-call', async () => {
    // A non-DeepSeek model returning empty content normally triggers ONE
    // retry on the reliable DeepSeek backbone — itself a second attempt with
    // its own fresh timer, the same unbounded-sum shape this fix exists to
    // close. Simulate the round trip itself consuming the whole remaining
    // budget: the deadline is still open when the call STARTS, but has
    // passed by the time the (empty) response comes back.
    process.env.OPENCODE_API_KEY = 'k';
    vi.useFakeTimers();
    const start = Date.now();
    const deadlineAt = start + 100;
    fetchMock.mockImplementation(async () => {
      vi.setSystemTime(start + 500); // deadline is now in the past
      return { ok: true, json: async () => ({ choices: [{ message: { content: '' } }] }) };
    });
    const { generateText } = await import('@/lib/ai/opencode');

    const result = await generateText({ prompt: 'hi', model: 'some-other-model', deadlineAt });

    expect(result).toBe('');
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry attempt started
  });
});

// ---------------------------------------------------------------------------
// OpenRouter — the MODEL_CHAIN loop this fix is primarily about.
// ---------------------------------------------------------------------------
describe('openrouter abort timer', () => {
  it('uses the full TIMEOUT_MS with no deadline (additive guarantee)', async () => {
    process.env.OPENROUTER_API_KEY = 'k';
    process.env.OPENROUTER_MODEL = 'test/single-model'; // pin the chain to one entry
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'hi' } }] }),
    });
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    const { openrouterText } = await import('@/lib/ai/openrouter');

    await openrouterText({ prompt: 'hi' });

    expect(setTimeoutSpy.mock.calls[0][1]).toBe(30_000);
    delete process.env.OPENROUTER_MODEL;
  });

  it('tightens the timer to the remaining time when a deadline is closer', async () => {
    process.env.OPENROUTER_API_KEY = 'k';
    process.env.OPENROUTER_MODEL = 'test/single-model';
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'hi' } }] }),
    });
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    const { openrouterText } = await import('@/lib/ai/openrouter');

    await openrouterText({ prompt: 'hi', deadlineAt: Date.now() + 2_000 });

    const ms = setTimeoutSpy.mock.calls[0][1] as number;
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(2_000);
    expect(ms).toBeLessThan(30_000);
    delete process.env.OPENROUTER_MODEL;
  });

  it('refuses to start the FIRST attempt once the deadline has already passed', async () => {
    process.env.OPENROUTER_API_KEY = 'k';
    fetchMock.mockResolvedValue({ ok: false, status: 429, text: async () => '' });
    const { openrouterText } = await import('@/lib/ai/openrouter');

    await expect(openrouterText({ prompt: 'hi', deadlineAt: Date.now() - 1 })).rejects.toMatchObject({
      code: 'deadline_exceeded',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops the MODEL_CHAIN before exhausting it once the deadline passes (non-streaming)', async () => {
    process.env.OPENROUTER_API_KEY = 'k';
    vi.useFakeTimers();
    const start = Date.now();
    // Every candidate 429s (shouldTryNextModel keeps the chain going) and
    // each attempt is simulated to cost 5s of wall time — mirroring a real
    // per-call timeout elapsing before the upstream answers.
    fetchMock.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 5_000);
      return { ok: false, status: 429, text: async () => 'rate limited', headers: { get: () => null } };
    });
    const { openrouterText, MODEL_CHAIN } = await import('@/lib/ai/openrouter');
    expect(MODEL_CHAIN.length).toBeGreaterThan(5); // sanity: this is really the long chain

    await expect(
      openrouterText({ prompt: 'hi', deadlineAt: start + 12_000 }),
    ).rejects.toMatchObject({ code: 'deadline_exceeded' });

    // 12s budget / 5s per attempt = at most 3 attempts before the deadline
    // check stops a 4th — nowhere near the full ~17-model chain.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.length).toBeLessThan(MODEL_CHAIN.length);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('stops the MODEL_CHAIN before exhausting it once the deadline passes (streaming)', async () => {
    process.env.OPENROUTER_API_KEY = 'k';
    vi.useFakeTimers();
    const start = Date.now();
    fetchMock.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 5_000);
      return { ok: false, status: 429, text: async () => 'rate limited', headers: { get: () => null } };
    });
    const { openrouterStreamChat, MODEL_CHAIN } = await import('@/lib/ai/openrouter');

    await expect(
      openrouterStreamChat({ messages: [{ role: 'user', content: 'hi' }], deadlineAt: start + 12_000 }, () => {}),
    ).rejects.toMatchObject({ code: 'deadline_exceeded' });

    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.length).toBeLessThan(MODEL_CHAIN.length);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);
  });
});
