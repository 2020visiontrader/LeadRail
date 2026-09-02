// What model does OpenCode Go actually ASK FOR when no caller names one?
//
// TEXT_MODEL is a module-level const read at import time, so the only honest
// way to check it is the WIRE BODY of the request (as in zoask-default-model
// .test.ts) plus the `opencodeModel` value the status route reports — a return
// value would look identical whichever model were sent.
//
// Two separate roles live within three lines of each other in lib/ai/opencode
// .ts and must not drift into each other:
//   - TEXT_MODEL (the default the ladder sends)      -> deepseek-v4-flash
//   - RELIABLE_FALLBACK (the empty-content self-heal) -> deepseek-v4-pro
// The last test pins the second one, because the obvious "tidy-up" after the
// 2026-09-02 default change is to make them match again, which would silently
// move the self-heal backbone onto the faster/weaker model.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function okWith(content: string) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => '',
  };
}

/** The JSON body of the nth request made (0-based). */
function sentBody(n = 0): any {
  return JSON.parse(fetchMock.mock.calls[n][1].body);
}

describe('OpenCode Go default text model', () => {
  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    process.env.OPENCODE_API_KEY = 'test-key';
    delete process.env.OPENCODE_MODEL;
  });

  afterEach(() => {
    delete process.env.OPENCODE_MODEL;
  });

  it('sends deepseek-v4-flash when no model is given and no env override is set', async () => {
    fetchMock.mockResolvedValue(okWith('hi'));
    const { generateText } = await import('@/lib/ai/opencode');
    await generateText({ prompt: 'hello' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentBody().model).toBe('deepseek-v4-flash');
  });

  it('exports that same default as `opencodeModel` (what /api/generate/status reports)', async () => {
    const { opencodeModel } = await import('@/lib/ai/opencode');
    expect(opencodeModel).toBe('deepseek-v4-flash');
  });

  it('still lets OPENCODE_MODEL override the default, on the wire and in the export', async () => {
    process.env.OPENCODE_MODEL = 'glm-5.2';
    fetchMock.mockResolvedValue(okWith('hi'));
    const { generateText, opencodeModel } = await import('@/lib/ai/opencode');
    await generateText({ prompt: 'hello' });
    expect(sentBody().model).toBe('glm-5.2');
    expect(opencodeModel).toBe('glm-5.2');
  });

  it('an explicit per-call model still beats both the default and the env override', async () => {
    process.env.OPENCODE_MODEL = 'glm-5.2';
    fetchMock.mockResolvedValue(okWith('hi'));
    const { generateText } = await import('@/lib/ai/opencode');
    await generateText({ prompt: 'hello', model: 'kimi-k3' });
    expect(sentBody().model).toBe('kimi-k3');
  });

  it('keeps deepseek-v4-pro as the empty-content self-heal fallback (a DIFFERENT role)', async () => {
    fetchMock
      .mockResolvedValueOnce(okWith('')) // non-DeepSeek model returns empty
      .mockResolvedValueOnce(okWith('recovered'));
    const { generateText } = await import('@/lib/ai/opencode');
    const out = await generateText({ prompt: 'hello', model: 'glm-5.2' });
    expect(out).toBe('recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(0).model).toBe('glm-5.2');
    expect(sentBody(1).model).toBe('deepseek-v4-pro');
  });
});
