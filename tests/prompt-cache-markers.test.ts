// Provider-side prompt-cache markers: the gate, the shape, and the retreat.
//
// The saving is real — the static prefix lib/agent/prompt-cache.ts assembles
// is ~10,386 tokens of byte-identical text re-sent on every step of every
// turn — but this is the one change in this batch that alters the body of a
// live provider request, on a service measured at a 69% success rate. So the
// properties under test are mostly about what it REFUSES to do: not marking
// unless told to, not marking a model that has no documented support, and
// never letting the marker be the reason a turn fails.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  process.env.OPENROUTER_API_KEY = 'k';
  delete process.env.AI_PROMPT_CACHE_MARKERS;
  delete process.env.OPENROUTER_MODEL;
});

afterEach(() => {
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_MODEL;
  delete process.env.AI_PROMPT_CACHE_MARKERS;
});

const ok = (content: string) => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });
const fail = (status: number, body: string) => ({ ok: false, status, text: async () => body, headers: { get: () => null } });

/** The parsed body of the Nth fetch this test made. */
function bodyOf(call: number): any {
  return JSON.parse(fetchMock.mock.calls[call]![1].body);
}

describe('marker gating', () => {
  it('supportsCacheMarkers is anthropic/* and nothing else', async () => {
    const { supportsCacheMarkers } = await import('@/lib/ai/prompt-cache-markers');
    expect(supportsCacheMarkers('anthropic/claude-haiku-4.5')).toBe(true);
    expect(supportsCacheMarkers('anthropic/claude-sonnet-5')).toBe(true);
    // Automatic prefix caching, no marker needed — and no marker sent.
    expect(supportsCacheMarkers('openai/gpt-5.6-luna')).toBe(false);
    expect(supportsCacheMarkers('deepseek/deepseek-v4-flash')).toBe(false);
    expect(supportsCacheMarkers('z-ai/glm-5.3-flash')).toBe(false);
  });

  it('cacheMarkersEnabled is OFF unless the operator turns it on', async () => {
    const { cacheMarkersEnabled } = await import('@/lib/ai/prompt-cache-markers');
    expect(cacheMarkersEnabled()).toBe(false);
    for (const v of ['1', 'true', 'TRUE', 'yes']) {
      process.env.AI_PROMPT_CACHE_MARKERS = v;
      expect(cacheMarkersEnabled()).toBe(true);
    }
    process.env.AI_PROMPT_CACHE_MARKERS = '0';
    expect(cacheMarkersEnabled()).toBe(false);
  });

  it('markSystemPrefix puts one breakpoint on the first system block and touches nothing else', async () => {
    const { markSystemPrefix } = await import('@/lib/ai/prompt-cache-markers');
    const marked = markSystemPrefix([
      { role: 'system', content: 'STABLE PREFIX' },
      { role: 'user', content: 'hello' },
    ])!;
    expect(marked[0]).toEqual({
      role: 'system',
      content: [{ type: 'text', text: 'STABLE PREFIX', cache_control: { type: 'ephemeral' } }],
    });
    // Order and every other message survive verbatim: marking is in scope,
    // reordering is not (see the PROMPT BLOCK ORDER rule in loop.ts).
    expect(marked[1]).toEqual({ role: 'user', content: 'hello' });
    expect(marked).toHaveLength(2);
  });

  it('markSystemPrefix returns null when there is no system message to mark', async () => {
    const { markSystemPrefix } = await import('@/lib/ai/prompt-cache-markers');
    expect(markSystemPrefix([{ role: 'user', content: 'hello' }])).toBeNull();
  });
});

describe('openrouter request bodies', () => {
  it('sends a plain string system message when the flag is off — the default', async () => {
    process.env.OPENROUTER_MODEL = 'anthropic/claude-haiku-4.5';
    fetchMock.mockResolvedValue(ok('hi'));

    const { openrouterText } = await import('@/lib/ai/openrouter');
    await openrouterText({ system: 'STABLE', prompt: 'p' });

    expect(bodyOf(0).messages[0]).toEqual({ role: 'system', content: 'STABLE' });
  });

  it('sends a cache_control block when the flag is on and the model is anthropic/*', async () => {
    process.env.AI_PROMPT_CACHE_MARKERS = '1';
    process.env.OPENROUTER_MODEL = 'anthropic/claude-haiku-4.5';
    fetchMock.mockResolvedValue(ok('hi'));

    const { openrouterText } = await import('@/lib/ai/openrouter');
    await openrouterText({ system: 'STABLE', prompt: 'p' });

    expect(bodyOf(0).messages[0]).toEqual({
      role: 'system',
      content: [{ type: 'text', text: 'STABLE', cache_control: { type: 'ephemeral' } }],
    });
  });

  it('leaves a non-anthropic model alone even with the flag on', async () => {
    process.env.AI_PROMPT_CACHE_MARKERS = '1';
    process.env.OPENROUTER_MODEL = 'openai/gpt-5.6-luna';
    fetchMock.mockResolvedValue(ok('hi'));

    const { openrouterText } = await import('@/lib/ai/openrouter');
    await openrouterText({ system: 'STABLE', prompt: 'p' });

    expect(bodyOf(0).messages[0]).toEqual({ role: 'system', content: 'STABLE' });
  });
});

describe('degrading safely', () => {
  it('retries ONCE without the marker when the request 400s, and the turn still succeeds', async () => {
    process.env.AI_PROMPT_CACHE_MARKERS = '1';
    process.env.OPENROUTER_MODEL = 'anthropic/claude-haiku-4.5';
    fetchMock
      .mockResolvedValueOnce(fail(400, 'Extra inputs are not permitted, field: messages.0.content.0.cache_control'))
      .mockResolvedValueOnce(ok('recovered'));

    const { openrouterText } = await import('@/lib/ai/openrouter');
    expect(await openrouterText({ system: 'STABLE', prompt: 'p' })).toBe('recovered');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(Array.isArray(bodyOf(0).messages[0].content)).toBe(true);   // marked
    expect(bodyOf(1).messages[0]).toEqual({ role: 'system', content: 'STABLE' }); // bare
  });

  it('retries at most once — a second failure is not retried again', async () => {
    process.env.AI_PROMPT_CACHE_MARKERS = '1';
    process.env.OPENROUTER_MODEL = 'anthropic/claude-haiku-4.5';
    fetchMock.mockResolvedValue(fail(400, 'cache_control not permitted'));

    const { openrouterText } = await import('@/lib/ai/openrouter');
    await expect(openrouterText({ system: 'STABLE', prompt: 'p' })).rejects.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a failure the marker cannot explain — 429 falls through to the normal chain', async () => {
    process.env.AI_PROMPT_CACHE_MARKERS = '1';
    process.env.OPENROUTER_MODEL = 'anthropic/claude-haiku-4.5';
    fetchMock.mockResolvedValue(fail(429, 'rate limited'));

    const { openrouterText } = await import('@/lib/ai/openrouter');
    await expect(openrouterText({ system: 'STABLE', prompt: 'p' })).rejects.toBeTruthy();
    // Spending the turn's remaining budget re-running the same rate limit
    // without a marker would buy nothing.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('implicatesCacheMarkers: 4xx yes, credit/auth/rate-limit and 5xx no', async () => {
    const { implicatesCacheMarkers } = await import('@/lib/ai/prompt-cache-markers');
    expect(implicatesCacheMarkers(400, 'bad request')).toBe(true);
    expect(implicatesCacheMarkers(404, '')).toBe(true);
    expect(implicatesCacheMarkers(422, '')).toBe(true);
    expect(implicatesCacheMarkers(401, '')).toBe(false);
    expect(implicatesCacheMarkers(402, '')).toBe(false);
    expect(implicatesCacheMarkers(403, '')).toBe(false);
    expect(implicatesCacheMarkers(429, '')).toBe(false);
    expect(implicatesCacheMarkers(500, '')).toBe(false);
    // A stream that died after the headers has no status at all — retrying
    // it would re-emit deltas the caller already saw.
    expect(implicatesCacheMarkers(0, '')).toBe(false);
    // ...unless the gateway names the field, whatever the status.
    expect(implicatesCacheMarkers(500, 'unknown field cache_control')).toBe(true);
  });
});
