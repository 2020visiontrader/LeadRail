// @vitest-environment happy-dom
//
// The generations grid (app/content/page.tsx's "Generations" tab,
// src/components/GenerationsBoard.tsx). Drives the real exported
// GenerationCard component with react-dom/client — not a reimplementation —
// covering the state that's easy to get wrong: a PUBLISHED generation whose
// bytes have been purged must render as "on the channel" with a link, never
// as a broken <img>; and a published row with no channel_url (currently
// possible for Facebook/Instagram/Threads) must not claim to be downloadable
// either.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, createElement } from 'react';
import { GenerationCard, type GenerationRecord } from '@/components/GenerationsBoard';

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

const BASE: GenerationRecord = {
  id: 'gen-1',
  brand_id: null,
  kind: 'image',
  source_tool: 'generateImage',
  prompt: 'a scooter on a beach',
  model: 'test-model',
  storage_path: 'acct/gen-1.png',
  external_url: null,
  review_state: 'PENDING',
  review_note: null,
  content_item_id: null,
  published_at: null,
  purged_at: null,
  channel_url: null,
  created_at: new Date().toISOString(),
  url: 'https://signed.example.com/gen-1.png',
};

function noop() {}

describe('GenerationCard — the three review states render distinctly', () => {
  it('PENDING shows Approve/Reject and the "Awaiting review" badge', () => {
    render(createElement(GenerationCard, { generation: BASE, onApprove: noop, onReject: noop, onPromote: noop }));
    expect(container.textContent).toContain('Awaiting review');
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).toContain('Approve');
    expect(buttons).toContain('Reject');
    expect(buttons).not.toContain('Promote to content');
  });

  it('APPROVED (not yet promoted) shows the Approved badge and a Promote action, not Approve/Reject', () => {
    render(createElement(GenerationCard, {
      generation: { ...BASE, review_state: 'APPROVED' }, onApprove: noop, onReject: noop, onPromote: noop,
    }));
    expect(container.textContent).toContain('Approved');
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).toContain('Promote to content');
    expect(buttons).not.toContain('Approve');
    expect(buttons).not.toContain('Reject');
  });

  it('REJECTED shows the Rejected badge and its reason, not Approve/Reject/Promote', () => {
    render(createElement(GenerationCard, {
      generation: { ...BASE, review_state: 'REJECTED', review_note: 'blurry' }, onApprove: noop, onReject: noop, onPromote: noop,
    }));
    expect(container.textContent).toContain('Rejected');
    expect(container.textContent).toContain('blurry');
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).not.toContain('Reject');
    expect(buttons).not.toContain('Promote to content');
  });

  it('REVERT-CHECK TARGET: the three review-state badges are visually distinct (different data-review-state on the card)', () => {
    for (const state of ['PENDING', 'APPROVED', 'REJECTED'] as const) {
      render(createElement(GenerationCard, { generation: { ...BASE, review_state: state }, onApprove: noop, onReject: noop, onPromote: noop }));
      const card = container.querySelector('[data-testid="generation-card"]')!;
      expect(card.getAttribute('data-review-state')).toBe(state);
    }
  });
});

describe('GenerationCard — purged + published renders as "on the channel", never a broken image', () => {
  it('REVERT-CHECK TARGET: a row with purged_at + channel_url set shows the channel link and no <img>', () => {
    const row: GenerationRecord = {
      ...BASE,
      review_state: 'APPROVED',
      storage_path: null,
      published_at: new Date().toISOString(),
      purged_at: new Date().toISOString(),
      channel_url: 'https://instagram.com/p/abc123',
      url: null, // resolveGenerationUrl has nothing left to sign — storage_path is null
    };
    render(createElement(GenerationCard, { generation: row, onApprove: noop, onReject: noop, onPromote: noop }));
    expect(container.querySelector('[data-testid="generation-media-on-channel"]')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    const link = container.querySelector('a') as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.href).toBe('https://instagram.com/p/abc123');
    expect(container.textContent).toContain('Now on the channel');
  });

  it('a merely-approved row with an intact url still renders as a real <img>, not the channel state', () => {
    render(createElement(GenerationCard, { generation: { ...BASE, review_state: 'APPROVED' }, onApprove: noop, onReject: noop, onPromote: noop }));
    expect(container.querySelector('[data-testid="generation-media-on-channel"]')).toBeNull();
    expect(container.querySelector('img')).toBeTruthy();
  });
});

describe('GenerationCard — published with no channel_url is honest, not "downloadable"', () => {
  it('REVERT-CHECK TARGET: published_at set, channel_url null, bytes still present -> "still stored" note, no channel link, no purged/broken state', () => {
    const row: GenerationRecord = {
      ...BASE,
      review_state: 'APPROVED',
      published_at: new Date().toISOString(),
      channel_url: null,
      purged_at: null,
      // storage_path/url still present — purge only ever runs once channel_url is set.
    };
    render(createElement(GenerationCard, { generation: row, onApprove: noop, onReject: noop, onPromote: noop }));
    expect(container.querySelector('[data-testid="generation-media-on-channel"]')).toBeNull();
    expect(container.querySelector('img')).toBeTruthy();
    expect(container.querySelector('[data-testid="generation-still-stored-note"]')).toBeTruthy();
    expect(container.textContent).toContain('still stored');
    expect(container.textContent).not.toContain('Now on the channel');
    // No anchor claiming a downloadable/channel link exists for this row.
    expect(container.querySelector('a')).toBeNull();
  });
});
