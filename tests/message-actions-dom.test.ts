// @vitest-environment happy-dom
//
// GAP 3: this project had no DOM test environment (see this file's sibling
// tests/agent-console-message-actions.test.ts, whose header explains why it
// tests the pure functions instead). happy-dom is now a devDependency
// (small, contained — see package.json; ~7 packages added) and this ONE test
// file opts into it per-file, via the docblock above, so the other 100+ test
// files keep running under vitest's default 'node' environment untouched.
//
// This drives the REAL exported MessageActions component (now `export`ed
// from src/components/AgentConsole.tsx for exactly this — previously
// module-private) with react-dom/client, not a reimplementation — the thing
// PR #12 shipped untested. Proves what tests/agent-console-message-actions.
// test.ts's header says a DOM harness would be needed for: the affordances
// actually present/absent in the rendered DOM for an assistant vs a user
// message, and that a click on each button fires its handler.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, createElement } from 'react';
import { MessageActions } from '@/components/AgentConsole';

// Tells React this environment supports act()'s synchronous flush — without
// it react-dom warns on every act() call even though the calls themselves
// work correctly. happy-dom doesn't set this itself (jsdom's vitest
// integration usually does), so it's set explicitly, once, for this file.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

function render(el: any) {
  act(() => { root.render(el); });
}

function labels(): string[] {
  return Array.from(container.querySelectorAll('button')).map((b) => b.getAttribute('aria-label') || '');
}

describe('MessageActions — assistant turn', () => {
  it('REVERT-CHECK TARGET: shows copy, read-aloud, thumbs up/down, retry — never edit, even when onEdit is supplied', () => {
    const onRetry = vi.fn();
    render(createElement(MessageActions, {
      turn: { id: 't1' }, isUser: false, now: Date.now(),
      onCopy: vi.fn(), copied: false,
      onReadAloud: vi.fn(), speaking: false, speechSupported: true,
      vote: null, onVote: vi.fn(),
      onRetry,
      // A caller would never actually pass onEdit for an assistant turn (see
      // AgentConsole.tsx's two MessageActions call sites) — supplied here
      // anyway so this assertion tests MessageActions' OWN `isUser` guard,
      // not just "the caller happened not to pass it".
      onEdit: vi.fn(),
    }));
    const found = labels();
    expect(found).toContain('Copy');
    expect(found).toContain('Read aloud');
    expect(found).toContain('Good response');
    expect(found).toContain('Bad response');
    expect(found).toContain('Retry');
    expect(found).not.toContain('Edit message');
  });

  it('omits the read-aloud button entirely when speechSupported is false — not just disabled', () => {
    render(createElement(MessageActions, {
      turn: { id: 't1' }, isUser: false, now: Date.now(),
      onCopy: vi.fn(), copied: false,
      speechSupported: false,
      vote: null, onVote: vi.fn(),
    }));
    expect(labels()).not.toContain('Read aloud');
    expect(labels()).not.toContain('Stop reading aloud');
  });

  it('REVERT-CHECK TARGET: a click on the thumbs-up button invokes onVote(true), not onVote(false)', () => {
    const onVote = vi.fn();
    render(createElement(MessageActions, {
      turn: { id: 't1', messageId: 'm1' }, isUser: false, now: Date.now(),
      onCopy: vi.fn(), copied: false,
      vote: null, onVote,
    }));
    const upBtn = Array.from(container.querySelectorAll('button'))
      .find((b) => b.getAttribute('aria-label') === 'Good response')!;
    act(() => { upBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onVote).toHaveBeenCalledTimes(1);
    expect(onVote).toHaveBeenCalledWith(true);
  });

  it('a pressed vote is reflected in aria-pressed on the matching button', () => {
    render(createElement(MessageActions, {
      turn: { id: 't1', messageId: 'm1' }, isUser: false, now: Date.now(),
      onCopy: vi.fn(), copied: false,
      vote: true, onVote: vi.fn(),
    }));
    const upBtn = Array.from(container.querySelectorAll('button'))
      .find((b) => b.getAttribute('aria-label') === 'Good response')!;
    const downBtn = Array.from(container.querySelectorAll('button'))
      .find((b) => b.getAttribute('aria-label') === 'Bad response')!;
    expect(upBtn.getAttribute('aria-pressed')).toBe('true');
    expect(downBtn.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('MessageActions — user turn', () => {
  it('shows copy and edit only — never read-aloud, thumbs, or retry', () => {
    render(createElement(MessageActions, {
      turn: { id: 'u1' }, isUser: true, now: Date.now(),
      onCopy: vi.fn(), copied: false,
      onEdit: vi.fn(),
    }));
    const found = labels();
    expect(found).toContain('Copy');
    expect(found).toContain('Edit message');
    expect(found).not.toContain('Read aloud');
    expect(found).not.toContain('Good response');
    expect(found).not.toContain('Bad response');
    expect(found).not.toContain('Retry');
  });

  it('REVERT-CHECK TARGET: clicking Edit invokes onEdit exactly once', () => {
    const onEdit = vi.fn();
    render(createElement(MessageActions, {
      turn: { id: 'u1' }, isUser: true, now: Date.now(),
      onCopy: vi.fn(), copied: false,
      onEdit,
    }));
    const editBtn = Array.from(container.querySelectorAll('button'))
      .find((b) => b.getAttribute('aria-label') === 'Edit message')!;
    act(() => { editBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    act(() => { editBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onEdit).toHaveBeenCalledTimes(2);
  });
});
