// @vitest-environment happy-dom
//
// THE PRODUCTION DEFECT (owner's exact words: "why are there two auto
// buttons?"): the composer's model picker and mode picker (src/components/
// AgentConsole.tsx) each carried only an aria-label ("Model"/"Mode") and a
// title tooltip — correct for a screen reader, invisible to a sighted user —
// and both defaulted to an option literally labelled "Auto". Two
// indistinguishable controls, tellable apart only by hovering.
//
// This drives the REAL exported ModelModeSelectors component (the same
// pattern tests/message-actions-dom.test.ts uses for MessageActions) and
// asserts the fix by what a SIGHTED person actually sees in the rendered
// markup — visible text — not just the aria-label/title a screen reader
// would read (those are asserted too, since the brief says keep them).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, createElement } from 'react';
import { ModelModeSelectors } from '@/components/AgentConsole';

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

function baseProps(overrides: Partial<Parameters<typeof ModelModeSelectors>[0]> = {}) {
  return {
    models: [],
    selectedModelId: 'auto',
    onModelChange: vi.fn(),
    mode: 'auto' as const,
    onModeChange: vi.fn(),
    ...overrides,
  };
}

describe('ModelModeSelectors — the two composer pickers are distinguishable without hovering', () => {
  it('REVERT-CHECK TARGET: each control carries its own VISIBLE text label ("Models" / "Mode"), not just an aria-label', () => {
    render(createElement(ModelModeSelectors, baseProps()));
    // Visible text nodes in the rendered DOM — what a sighted person reads
    // at a glance, with no hover and no assistive tech.
    const visibleText = container.textContent || '';
    expect(visibleText).toContain('Models');
    expect(visibleText).toContain('Mode');
    // The aria-labels the task requires kept — but on their own they are
    // exactly the insufficiency this fix addresses, so this is a floor, not
    // the assertion that matters here.
    const selects = Array.from(container.querySelectorAll('select'));
    expect(selects.map((s) => s.getAttribute('aria-label')).sort()).toEqual(['Mode', 'Model']);
  });

  it('the two controls are never both showing only "Auto" with nothing else visible to tell them apart', () => {
    render(createElement(ModelModeSelectors, baseProps()));
    // Each select's own container carries a distinct visible label text —
    // this is the direct fix for "two auto buttons".
    const pills = Array.from(container.querySelectorAll('select')).map((s) => s.parentElement);
    const labels = pills.map((p) => (p?.querySelector('span')?.textContent || '').trim());
    expect(labels).toEqual(['Models', 'Mode']);
    expect(new Set(labels).size).toBe(2); // distinct, not both empty/identical
  });

  it('the model select uses the owner\'s exact word "Models" — not "Model" or "AI Model"', () => {
    render(createElement(ModelModeSelectors, baseProps()));
    const modelSelect = container.querySelector('select[aria-label="Model"]')!;
    const label = modelSelect.parentElement?.querySelector('span')?.textContent;
    expect(label).toBe('Models');
  });

  it('changing the model select calls onModelChange with the chosen id', () => {
    const onModelChange = vi.fn();
    render(createElement(ModelModeSelectors, baseProps({
      models: [{ id: 'm-1', model_id: 'gpt', label: 'GPT', tier: 'std', provider: 'openai' }],
      onModelChange,
    })));
    const modelSelect = container.querySelector('select[aria-label="Model"]') as HTMLSelectElement;
    modelSelect.value = 'm-1';
    act(() => { modelSelect.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(onModelChange).toHaveBeenCalledWith('m-1');
  });

  it('changing the mode select calls onModeChange with the chosen mode', () => {
    const onModeChange = vi.fn();
    render(createElement(ModelModeSelectors, baseProps({ onModeChange })));
    const modeSelect = container.querySelector('select[aria-label="Mode"]') as HTMLSelectElement;
    modeSelect.value = 'plan';
    act(() => { modeSelect.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(onModeChange).toHaveBeenCalledWith('plan');
  });
});
