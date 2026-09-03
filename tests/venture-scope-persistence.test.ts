// @vitest-environment happy-dom
//
// VentureScopeProvider (src/components/VentureScopeProvider.tsx) replaces the
// local `useState` scopeId that used to live only in app/page.tsx — nothing
// persisted it and no other page could read it, so a venture chosen on the
// dashboard was not still selected on /assistant. This file proves the two
// things that fix actually needs to do:
//
//   1. A choice made in one mounted tree is visible in another mounted tree
//      reading the same localStorage key (the "two pages" case — in the real
//      app this is dashboard vs /assistant, both wrapped by the SAME
//      provider instance in app/layout.tsx, but the mechanism under test —
//      "write here, read there via localStorage" — is what a genuine RELOAD
//      also exercises, since app/layout.tsx's Provider itself remounts then).
//   2. A fresh mount (a reload) restores the persisted value instead of
//      starting over at "all ventures".
//
// Driven with react-dom/client against a real DOM, same harness as
// tests/message-actions-dom.test.ts (this repo's only other DOM test) — no
// testing-library dependency exists here, so this follows that file's
// pattern rather than introducing a new one.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, createElement, useEffect } from 'react';
import VentureScopeProvider, { useVentureScope, ALL_VENTURES } from '@/components/VentureScopeProvider';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const STORAGE_KEY = 'leadrail:ventureScope';

let container: HTMLDivElement;
let root: Root | null;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = null;
});

afterEach(() => {
  if (root) act(() => { root!.unmount(); });
  container.remove();
});

/** A tiny reader/writer so tests can drive and observe the hook without a
 *  real page component. `onReady` fires with {scopeId, setScopeId} on every
 *  render, so a test can call setScopeId and read the latest scopeId. */
function Probe({ onReady }: { onReady: (v: { scopeId: string; setScopeId: (id: string) => void }) => void }) {
  const { scopeId, setScopeId } = useVentureScope();
  useEffect(() => { onReady({ scopeId, setScopeId }); });
  return null;
}

function mount(onReady: (v: { scopeId: string; setScopeId: (id: string) => void }) => void) {
  root = createRoot(container);
  act(() => {
    root!.render(createElement(VentureScopeProvider, null, createElement(Probe, { onReady })));
  });
}

describe('VentureScopeProvider', () => {
  it('starts at ALL_VENTURES with nothing in storage', () => {
    let latest: any;
    mount((v) => { latest = v; });
    expect(latest.scopeId).toBe(ALL_VENTURES);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('setScopeId persists to localStorage under the shared key', () => {
    let latest: any;
    mount((v) => { latest = v; });
    act(() => { latest.setScopeId('brand_42'); });
    expect(latest.scopeId).toBe('brand_42');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('brand_42');
  });

  it('setScopeId back to ALL_VENTURES clears the stored key rather than storing "all"', () => {
    let latest: any;
    mount((v) => { latest = v; });
    act(() => { latest.setScopeId('brand_42'); });
    act(() => { latest.setScopeId(ALL_VENTURES); });
    expect(latest.scopeId).toBe(ALL_VENTURES);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('a SECOND mounted tree reading the same storage sees the choice the first made — the dashboard -> /assistant case', () => {
    let first: any;
    mount((v) => { first = v; });
    act(() => { first.setScopeId('brand_dashboard_pick'); });

    // A second, independent provider tree (e.g. what /assistant's page gets
    // if it were ever mounted under a fresh provider) restores from the SAME
    // localStorage — proving persistence is not per-component-instance state.
    const container2 = document.createElement('div');
    document.body.appendChild(container2);
    let second: any;
    const root2 = createRoot(container2);
    act(() => {
      root2.render(createElement(VentureScopeProvider, null, createElement(Probe, { onReady: (v) => { second = v; } })));
    });
    expect(second.scopeId).toBe('brand_dashboard_pick');

    act(() => { root2.unmount(); });
    container2.remove();
  });

  it('SURVIVES A RELOAD: unmounting the whole tree and mounting a brand-new provider still recovers the persisted scope', () => {
    let latest: any;
    mount((v) => { latest = v; });
    act(() => { latest.setScopeId('brand_reload_me'); });

    // Simulate a hard reload: tear down the entire tree (a fresh page load
    // has no in-memory state at all) and mount fresh against the same
    // localStorage, which a real reload does not clear.
    act(() => { root!.unmount(); });
    root = null;

    let restored: any;
    mount((v) => { restored = v; });
    expect(restored.scopeId).toBe('brand_reload_me');
  });
});
