// C10 — compose stops re-reading everything.
//
// Two behaviours pinned here:
//   1. Compose receives only the last two OBSERVATION: entries from the
//      route-pass transcript, newest first — not every observation up to
//      composeBlockChars (160k).
//   2. Compose's system prompt no longer carries the full grounding/
//      agentContext block — the defect this closes: asked to "pull 2 more
//      leads and enrich them", compose answered with the leads and then
//      recited "You have 41 leads on file across your 3 ventures… connected
//      social accounts include…", lifted out of that block.
//
// The model call itself is mocked; these tests assert on what compose SENDS
// to generateChat, never on live model output.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateChat = vi.fn();
const streamChat = vi.fn();

vi.mock('@/lib/ai/router', () => ({
  generateChat: (...a: any[]) => generateChat(...a),
  streamChat: (...a: any[]) => streamChat(...a),
}));
vi.mock('@/lib/ai/humanizer', () => ({
  stripAiMarkers: (s: string) => s,
  HUMANIZE_RULES: ['rule one', 'rule two'],
}));

import { composeAnswer } from '../lib/agent/compose';

beforeEach(() => {
  generateChat.mockReset();
  streamChat.mockReset();
  generateChat.mockResolvedValue('the final answer');
});

const obs = (n: number) => ({ role: 'user' as const, content: `OBSERVATION: result number ${n}` });

describe('C10 — only the last two observations', () => {
  it('sends only the last two OBSERVATION lines from a longer transcript', async () => {
    const transcript = [
      { role: 'assistant' as const, content: 'ROUTE: something' },
      obs(1), obs(2), obs(3), obs(4), obs(5),
    ];
    await composeAnswer({ accountId: 'acc', userMessage: 'hi', draft: 'draft text', transcript });

    const call = generateChat.mock.calls[0][0];
    const userTurn: string = call.messages[0].content;
    expect(userTurn).toContain('result number 5');
    expect(userTurn).toContain('result number 4');
    expect(userTurn).not.toContain('result number 3');
    expect(userTurn).not.toContain('result number 2');
    expect(userTurn).not.toContain('result number 1');
  });

  it('keeps the newest-first order of the two observations kept', async () => {
    const transcript = [obs(1), obs(2), obs(3)];
    await composeAnswer({ accountId: 'acc', draft: 'x', transcript });
    const userTurn: string = generateChat.mock.calls[0][0].messages[0].content;
    expect(userTurn.indexOf('result number 3')).toBeLessThan(userTurn.indexOf('result number 2'));
  });

  it('keeps the digest line of a digest-then-JSON observation (successObservation layout)', async () => {
    // Mirrors lib/agent/loop.ts's successObservation(): digest first line,
    // raw JSON after it, both under one OBSERVATION: prefix.
    const digestThenJson = 'OBSERVATION: 3 leads added: alice@x.com, bob@y.com, carol@z.com\n{"added":3,"ids":["1","2","3"]}';
    const transcript = [{ role: 'user' as const, content: digestThenJson }];
    await composeAnswer({ accountId: 'acc', draft: 'x', transcript });
    const userTurn: string = generateChat.mock.calls[0][0].messages[0].content;
    expect(userTurn).toContain('3 leads added: alice@x.com');
    expect(userTurn).toContain('"added":3');
  });

  it('handles fewer than two observations without error', async () => {
    const transcript = [obs(1)];
    const result = await composeAnswer({ accountId: 'acc', draft: 'x', transcript });
    expect(result).toBe('the final answer');
    const userTurn: string = generateChat.mock.calls[0][0].messages[0].content;
    expect(userTurn).toContain('result number 1');
  });

  it('handles zero observations without error', async () => {
    const result = await composeAnswer({ accountId: 'acc', draft: 'fallback draft', transcript: [] });
    expect(result).toBe('the final answer');
    const userTurn: string = generateChat.mock.calls[0][0].messages[0].content;
    expect(userTurn).toContain('No observations available');
  });
});

describe('C10 — compose no longer carries the grounding block', () => {
  it('does not include agentContext text in the system prompt', async () => {
    const agentContext = [
      'ACCOUNT SNAPSHOT (source: live database, fetched now):',
      '- Ventures (3): Acme [id-1], Beta [id-2], Gamma [id-3]',
      '- Leads on file: 41',
      'CONNECTED SOCIAL ACCOUNTS (source: live database):',
      '- Instagram: @acme_official (id: 999)',
    ].join('\n');
    await composeAnswer({ accountId: 'acc', draft: 'draft', transcript: [obs(1)], agentContext });
    const system: string = generateChat.mock.calls[0][0].system;
    expect(system).not.toContain('ACCOUNT SNAPSHOT');
    expect(system).not.toContain('Leads on file: 41');
    expect(system).not.toContain('CONNECTED SOCIAL ACCOUNTS');
    expect(system).not.toContain('@acme_official');
  });

  it('still writes a normal system prompt (persona block preserved, core instructions intact) with agentContext omitted', async () => {
    await composeAnswer({
      accountId: 'acc',
      draft: 'draft',
      transcript: [obs(1)],
      agentContext: 'ACCOUNT SNAPSHOT: 41 leads',
      personaBlock: 'You are Ada, the finance persona.',
    });
    const system: string = generateChat.mock.calls[0][0].system;
    expect(system).toContain('You are Ada, the finance persona.');
    expect(system).toContain('operator copilot');
    expect(system).not.toContain('ACCOUNT SNAPSHOT');
  });
});
