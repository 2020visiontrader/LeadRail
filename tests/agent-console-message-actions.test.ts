// The message action bar added to src/components/AgentConsole.tsx (copy,
// read aloud, thumbs, retry, edit, relative timestamp). No DOM test
// environment exists in this project (see agent-console-timing.test.ts's
// header for why) — these drive the real pure functions the component's
// handlers call, the same pattern used throughout this file's siblings.
//
// NOT COVERED HERE (said plainly, per the task spec): the actual JSX —
// whether the read-aloud button is physically absent from the DOM when
// speechSynthesis is unavailable, whether navigator.clipboard is actually
// invoked, whether the optimistic vote really repaints the button before the
// network call resolves. Those all require a DOM/component-render harness
// this project does not have. What IS covered is the logic those handlers
// are built on: the toggle rule for a vote, what a failed write should roll
// back to, what Retry resends and from where, and the timestamp label —
// which is where the actual bugs in this kind of feature live (wrong toggle
// direction, reverting to the wrong previous value, retrying the wrong
// message).

import { describe, it, expect } from 'vitest';
import { relativeTimeLabel, nextVoteState, planVoteUpdate, findRetryTarget } from '@/components/AgentConsole';

describe('relativeTimeLabel', () => {
  it('reads "just now" for a very recent timestamp', () => {
    const now = 1_000_000;
    expect(relativeTimeLabel(now - 1000, now)).toBe('just now');
  });

  it('formats past a few seconds using formatDuration, with "ago" appended', () => {
    const now = 1_000_000;
    expect(relativeTimeLabel(now - 88_000, now)).toBe('1m 28s ago');
  });

  it('clamps a future/negative-elapsed timestamp (clock skew) to "just now" rather than a negative duration', () => {
    const now = 1_000_000;
    expect(relativeTimeLabel(now + 5000, now)).toBe('just now');
  });

  it('returns empty for a turn with no timestamp (a rehydrated turn)', () => {
    expect(relativeTimeLabel(undefined, 1_000_000)).toBe('');
  });
});

describe('nextVoteState', () => {
  it('clicking up from no vote selects up', () => {
    expect(nextVoteState(null, true)).toBe(true);
    expect(nextVoteState(undefined, true)).toBe(true);
  });

  it('clicking down from no vote selects down', () => {
    expect(nextVoteState(null, false)).toBe(false);
  });

  it('REVERT-CHECK TARGET: clicking the ALREADY-selected direction toggles it off', () => {
    expect(nextVoteState(true, true)).toBeNull();
    expect(nextVoteState(false, false)).toBeNull();
  });

  it('clicking the opposite direction switches to it', () => {
    expect(nextVoteState(true, false)).toBe(false);
    expect(nextVoteState(false, true)).toBe(true);
  });
});

describe('planVoteUpdate', () => {
  it('records the previous value for rollback, and the optimistic map for immediate display', () => {
    const current = { 'msg-1': null, 'msg-2': true };
    const { optimistic, previous } = planVoteUpdate(current, 'msg-1', true);
    expect(previous).toBeNull();
    expect(optimistic).toEqual({ 'msg-1': true, 'msg-2': true });
    // The original map is untouched — the component still holds `current`
    // until setVotes(optimistic) actually swaps state.
    expect(current['msg-1']).toBeNull();
  });

  it('REVERT-CHECK TARGET: previous is the value BEFORE this click, so a failed write restores exactly what was on screen a moment ago', () => {
    const current = { 'msg-1': true };
    const { previous } = planVoteUpdate(current, 'msg-1', false);
    expect(previous).toBe(true); // not false, not null — what was actually there
  });
});

describe('findRetryTarget', () => {
  const turns = [
    { id: 'u-1', role: 'user', text: 'first question', messageId: 'm-1' },
    { id: 'a-1', role: 'assistant', text: 'first answer', messageId: 'm-2' },
    { id: 'u-2', role: 'user', text: 'second question', messageId: 'm-3' },
    { id: 'a-2', role: 'assistant', text: 'second answer', messageId: 'm-4' },
  ];

  it('REVERT-CHECK TARGET: resends the text of the NEAREST preceding user turn, not the first one in the chat', () => {
    const target = findRetryTarget(turns, 'a-2');
    expect(target).toEqual({ userText: 'second question', truncateAtMessageId: 'm-3' });
  });

  it('works for the very first assistant turn too', () => {
    const target = findRetryTarget(turns, 'a-1');
    expect(target).toEqual({ userText: 'first question', truncateAtMessageId: 'm-1' });
  });

  it('returns null when the assistant turn id is not found', () => {
    expect(findRetryTarget(turns, 'not-a-real-turn')).toBeNull();
  });

  it('returns null (retry unavailable) when the preceding user turn has no learned messageId yet', () => {
    const noId = [
      { id: 'u-1', role: 'user', text: 'q', messageId: undefined },
      { id: 'a-1', role: 'assistant', text: 'a', messageId: 'm-2' },
    ];
    expect(findRetryTarget(noId, 'a-1')).toBeNull();
  });
});
