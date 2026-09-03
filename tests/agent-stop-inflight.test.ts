// The IN-FLIGHT half of cooperative stop (see tests/agent-stop-loop.test.ts
// for the between-steps half, which this is additive to). Before this, a
// stop clicked while a model call was already in flight waited out the rest
// of that call — production numbers put a single call's p50 at 39s, p90 at
// 74s, and the common turn shape (route -> final -> compose) makes two such
// calls. lib/agent/stop-watch.ts's withStopWatch polls isStopRequested every
// 3s while a call is in flight and aborts it the moment a stop lands; this
// file proves loop.ts actually wires that watcher around each model call and
// ends the turn through the SAME salvage path the between-steps check uses.
//
// These drive the REAL runAgent / runAgentStream loops, same harness as
// tests/agent-stop-loop.test.ts — not a reimplementation.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const generateChat = vi.fn();
const streamChat = vi.fn();
const runToolMock = vi.fn();
const isStopRequestedMock = vi.fn();

vi.mock('@/lib/ai/router', () => ({
  generateChat: (...a: any[]) => generateChat(...a),
  streamChat: (...a: any[]) => streamChat(...a),
  textConfigured: () => true,
}));
vi.mock('@/lib/credits', () => ({
  markParseOutcome: vi.fn(),
  recordAiUsage: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() },
}));
vi.mock('@/lib/agent/tools', () => ({
  TOOLS: {
    draftOutreach: { title: 'Draft outreach email', sensitive: false },
    listTags: { title: 'List Tags', sensitive: false },
  },
  runTool: (...a: any[]) => runToolMock(...a),
  toolCatalogForPrompt: () => 'TOOLS',
  toolCatalogStaged: () => 'TOOLS',
  AGENT_STAGED_CATALOG: false,
  capabilityFor: () => undefined,
  toolsFromCapabilities: () => ({}),
}));
vi.mock('@/lib/capabilities/external-mcp', () => ({ loadExternalCapabilities: async () => [] }));
vi.mock('@/lib/agent/personas', () => ({
  loadPersonaForAgent: async () => null,
  resolveMentionedPersonas: async () => [],
  getCoordinator: async () => null,
  selectPersonasForRequest: async () => [],
  buildPersonaSystemBlock: () => '',
  buildCoordinatorSystemBlock: () => '',
  parseMentions: () => [],
}));
vi.mock('@/lib/skills/store', () => ({ loadEnabledSkillsForAgent: async () => [] }));
// composeAnswer is the REAL module here (not mocked) — the whole point of
// several tests below is that it now forwards `signal` to generateChat and
// rethrows a StoppedError instead of swallowing it into the draft. Only the
// router underneath it is mocked.
vi.mock('@/lib/approvals/store', () => ({
  createApproval: async () => null,
  consumeApprovalForExecution: vi.fn(),
  markApprovedByToolAndArgs: vi.fn(),
  ApprovalExecutionError: class extends Error {},
}));
vi.mock('@/lib/approvals/grants', () => ({ consumeGrant: async () => null, isGrantable: () => false }));
vi.mock('@/lib/capabilities/delegation', () => ({
  beginDelegationScope: vi.fn(), endDelegationScope: vi.fn(), setDelegationContext: vi.fn(),
}));
vi.mock('@/lib/ai/hermes', () => ({ hermesRoute: async () => ({ skillIds: [] }) }));
vi.mock('@/lib/db', () => ({ supabase: { from: () => ({}) }, dbReady: () => false }));
// Only isStopRequested is faked — everything else (including the running_since
// comparison the in-flight watcher itself relies on) stays real.
vi.mock('@/lib/agent/memory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent/memory')>();
  return { ...actual, isStopRequested: (...a: any[]) => isStopRequestedMock(...a) };
});

const STOP_POLL_MS = 3_000;

beforeEach(() => {
  vi.resetModules();
  generateChat.mockReset();
  streamChat.mockReset();
  runToolMock.mockReset();
  isStopRequestedMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A generateChat mock that never resolves on its own — it hangs until its
 *  own `opts.signal` aborts, exactly like a real in-flight fetch would. */
function hangingGenerateChat(StoppedError: typeof import('@/lib/ai/abort').StoppedError) {
  return vi.fn((opts: any) => new Promise((_resolve, reject) => {
    opts.signal?.addEventListener('abort', () => reject(new StoppedError('router: stop requested')));
  }));
}

/** Same shape as hangingGenerateChat, for streamChat's (opts, onDelta)
 *  signature — the streaming loop's composeAnswer call uses streamChat, not
 *  generateChat, whenever an onDelta callback is supplied. */
function hangingStreamChat(StoppedError: typeof import('@/lib/ai/abort').StoppedError) {
  return vi.fn((opts: any, _onDelta: (chunk: string) => void) => new Promise((_resolve, reject) => {
    opts.signal?.addEventListener('abort', () => reject(new StoppedError('router: stop requested')));
  }));
}

describe('runAgent (JSON, non-streaming) — in-flight stop', () => {
  it('aborts a model call that is already in flight when a stop flips mid-call, and ends the turn via the SAME salvage path as a between-steps stop', async () => {
    vi.useFakeTimers();
    const { StoppedError } = await import('@/lib/ai/abort');
    // Not stopped at the top of step 0 (the between-steps check); the
    // watcher's own polls then see: not yet, not yet, stopped.
    isStopRequestedMock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    generateChat.mockImplementation(hangingGenerateChat(StoppedError));

    const { runAgent } = await import('@/lib/agent/loop');
    const promise = runAgent({ accountId: 'acct-1', message: 'summarize my pipeline', conversationId: 'conv-1' });
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(STOP_POLL_MS); // watcher poll #1: false
    await vi.advanceTimersByTimeAsync(STOP_POLL_MS); // watcher poll #2: false
    await vi.advanceTimersByTimeAsync(STOP_POLL_MS); // watcher poll #3: true -> aborts

    const res = await promise;

    // Nothing had completed yet (the abort happened on the FIRST model
    // call), so this is the stop-specific empty message — never the generic
    // outage message, and never described as a timeout.
    expect(res.status).toBe('error');
    expect(res.message).toMatch(/stopped/i);
    expect(res.message).not.toBe('LeadRail AI is temporarily unavailable. Please try again.');
    expect(res.message).not.toMatch(/ran out of time/i);
    // The call was aborted, not retried — only ONE generateChat attempt.
    expect(generateChat).toHaveBeenCalledTimes(1);
  });

  it('salvages already-completed tool work when the in-flight abort happens on a LATER step', async () => {
    vi.useFakeTimers();
    const { StoppedError } = await import('@/lib/ai/abort');
    runToolMock.mockResolvedValue({ ok: true, result: { subject: 'hi Markus', body: 'quick note' } });
    // Step 0: a tool call, completes normally (generateChat resolves fast,
    // no signal ever aborts it).
    generateChat.mockImplementationOnce(async () => JSON.stringify({ action: 'tool', tool: 'draftOutreach', args: { contactId: 'c1' } }));
    // Step 1: the route-pass call for the NEXT step hangs until the watcher
    // aborts it.
    generateChat.mockImplementationOnce(hangingGenerateChat(StoppedError));
    isStopRequestedMock
      .mockResolvedValueOnce(false) // between-steps, before step 0
      .mockResolvedValueOnce(false) // between-steps, before step 1 (post-tool check)
      .mockResolvedValueOnce(false) // watcher poll #1 during step 1's call
      .mockResolvedValueOnce(true); // watcher poll #2: stop

    const { runAgent } = await import('@/lib/agent/loop');
    const promise = runAgent({ accountId: 'acct-1', message: 'draft outreach', conversationId: 'conv-1' });
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(STOP_POLL_MS);
    await vi.advanceTimersByTimeAsync(STOP_POLL_MS);

    const res = await promise;

    expect(res.status).toBe('salvage');
    expect(res.message).toMatch(/stopped/i);
    // The tool work from step 0 is not discarded.
    expect(res.message).toContain('Draft outreach email');
    expect(res.message).toContain('hi Markus');
    expect(generateChat).toHaveBeenCalledTimes(2);
  });

  it('a normal call that completes before any stop is unaffected, and the watcher leaves no timer running afterwards', async () => {
    vi.useFakeTimers();
    isStopRequestedMock.mockResolvedValue(false);
    generateChat.mockResolvedValueOnce(JSON.stringify({ action: 'final', message: 'all done' }));

    const { runAgent } = await import('@/lib/agent/loop');
    const res = await runAgent({ accountId: 'acct-1', message: 'hello', conversationId: 'conv-1' });

    expect(res.status).toBe('done');
    expect(res.message).toBe('all done');
    const callsAtCompletion = isStopRequestedMock.mock.calls.length;
    // A leaked watcher timer would keep polling; advancing well past several
    // poll intervals must not produce any more calls.
    await vi.advanceTimersByTimeAsync(STOP_POLL_MS * 10);
    expect(isStopRequestedMock.mock.calls.length).toBe(callsAtCompletion);
  });

  it('aborts an in-flight COMPOSE call specifically (the route pass already succeeded) and ends via the same salvage path — composeAnswer does not silently swallow a stop into the draft', async () => {
    vi.useFakeTimers();
    const { StoppedError } = await import('@/lib/ai/abort');
    // Route pass resolves immediately with a final action.
    generateChat.mockImplementationOnce(async () => JSON.stringify({ action: 'final', message: 'draft answer' }));
    // The compose pass (composeAnswer's OWN call to the same generateChat,
    // since composeAnswer is the real, unmocked module here) hangs until the
    // watcher aborts it.
    generateChat.mockImplementationOnce(hangingGenerateChat(StoppedError));
    isStopRequestedMock
      .mockResolvedValueOnce(false) // between-steps, before step 0's route call
      .mockResolvedValueOnce(false) // DEFECT A check, immediately before compose
      .mockResolvedValueOnce(false) // watcher poll #1 during compose
      .mockResolvedValueOnce(true); // watcher poll #2: stop

    const { runAgent } = await import('@/lib/agent/loop');
    const promise = runAgent({ accountId: 'acct-1', message: 'summarize my pipeline', conversationId: 'conv-1' });
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(STOP_POLL_MS);
    await vi.advanceTimersByTimeAsync(STOP_POLL_MS);
    const res = await promise;

    // composeAnswer actually ran (its own generateChat call happened) —
    // confirms this exercised the compose site, not just the route site.
    expect(generateChat).toHaveBeenCalledTimes(2);
    // Ended through the stop-salvage path, NEVER carrying the pre-compose
    // draft as if the turn had completed normally.
    expect(res.status).toBe('error');
    expect(res.message).toMatch(/stopped/i);
    expect(res.message).not.toContain('draft answer');
  });

  it('no conversationId means no in-flight watcher at all — a slow call is never polled or aborted', async () => {
    vi.useFakeTimers();
    let resolveCall!: (v: string) => void;
    generateChat.mockImplementationOnce((opts: any) => {
      expect(opts.signal).toBeUndefined();
      return new Promise<string>((res) => { resolveCall = res; });
    });

    const { runAgent } = await import('@/lib/agent/loop');
    const promise = runAgent({ accountId: 'acct-1', message: 'draft outreach' }); // no conversationId
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(STOP_POLL_MS * 5);
    expect(isStopRequestedMock).not.toHaveBeenCalled();

    resolveCall(JSON.stringify({ action: 'final', message: 'done' }));
    const res = await promise;
    expect(res.status).toBe('done');
  });
});

describe('runAgentStream (streaming) — in-flight stop (must match runAgentImpl)', () => {
  it('aborts an in-flight model call and emits a terminal "final" event through the salvage path, never a bare crash', async () => {
    vi.useFakeTimers();
    const { StoppedError } = await import('@/lib/ai/abort');
    runToolMock.mockResolvedValue({ ok: true, result: { subject: 'hi Markus', body: 'quick note' } });
    generateChat.mockImplementationOnce(async () => JSON.stringify({ action: 'tool', tool: 'draftOutreach', args: { contactId: 'c1' } }));
    generateChat.mockImplementationOnce(hangingGenerateChat(StoppedError));
    isStopRequestedMock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const { runAgentStream } = await import('@/lib/agent/loop');
    const events: any[] = [];
    const promise = runAgentStream(
      { accountId: 'acct-1', message: 'draft outreach', conversationId: 'conv-1' },
      (e) => events.push(e),
    );
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(STOP_POLL_MS);
    await vi.advanceTimersByTimeAsync(STOP_POLL_MS);
    await promise;

    const finalEvents = events.filter((e) => e.type === 'final');
    expect(finalEvents.length).toBe(1);
    expect(finalEvents[0].salvage).toBe(true);
    expect(finalEvents[0].message).toMatch(/stopped/i);
    expect(finalEvents[0].message).toContain('Draft outreach email');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(generateChat).toHaveBeenCalledTimes(2);
  });

  it('aborts an in-flight COMPOSE call specifically, mirroring runAgentImpl (CLAUDE.md: both loops stay identical)', async () => {
    vi.useFakeTimers();
    const { StoppedError } = await import('@/lib/ai/abort');
    // The route pass uses generateChat; the compose pass here uses
    // streamChat (an onDelta callback is supplied) — see compose.ts.
    generateChat.mockImplementationOnce(async () => JSON.stringify({ action: 'final', message: 'draft answer' }));
    streamChat.mockImplementationOnce(hangingStreamChat(StoppedError));
    isStopRequestedMock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const { runAgentStream } = await import('@/lib/agent/loop');
    const events: any[] = [];
    const promise = runAgentStream(
      { accountId: 'acct-1', message: 'summarize my pipeline', conversationId: 'conv-1' },
      (e) => events.push(e),
    );
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(STOP_POLL_MS);
    await vi.advanceTimersByTimeAsync(STOP_POLL_MS);
    await promise;

    expect(generateChat).toHaveBeenCalledTimes(1);
    expect(streamChat).toHaveBeenCalledTimes(1);
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeTruthy();
    expect(errorEvent.message).toMatch(/stopped/i);
    expect(events.some((e) => e.type === 'final')).toBe(false);
    expect(JSON.stringify(events)).not.toContain('draft answer');
  });

  it('no conversationId means no in-flight watcher for the streaming loop either', async () => {
    vi.useFakeTimers();
    let resolveCall!: (v: string) => void;
    generateChat.mockImplementationOnce((opts: any) => {
      expect(opts.signal).toBeUndefined();
      return new Promise<string>((res) => { resolveCall = res; });
    });

    const { runAgentStream } = await import('@/lib/agent/loop');
    const events: any[] = [];
    const promise = runAgentStream({ accountId: 'acct-1', message: 'draft outreach' }, (e) => events.push(e));
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(STOP_POLL_MS * 5);
    expect(isStopRequestedMock).not.toHaveBeenCalled();

    resolveCall(JSON.stringify({ action: 'final', message: 'done' }));
    await promise;
    expect(events.some((e) => e.type === 'final')).toBe(true);
  });
});
