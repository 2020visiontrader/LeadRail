// Paid tiers first for substantive work; free tiers take the easy/cheap
// work. `cost_per_mtok_out > 0` is the paid signal — reliable since the
// production cleanup that gave every OpenRouter `:free` model cost 0 instead
// of NULL — NOT the `:free` substring, which is an OpenRouter naming
// convention, not a cost fact, and doesn't exist for non-OpenRouter
// providers at all.
//
// Cheap vs substantive is read off the existing `ai_models.good` task-tag
// vocabulary (migration 023) rather than inventing a new one:
//   cheap:       classify, extract
//   substantive: reason, long, draft, code

import { describe, it, expect } from 'vitest';
import { isPaidModel, orderByCost, type ResolvedModel } from '@/lib/ai/providers';

function model(id: string, costOut: number | null): ResolvedModel {
  return {
    provider: {
      id: `p-${id}`, account_id: 'acct-1', name: id, kind: 'custom',
      base_url: null, api_key_encrypted: null, enabled: true,
      created_at: '', updated_at: '',
    },
    model: {
      id, provider_id: `p-${id}`, model_id: id, label: id, tier: 'balanced',
      good: [], reliable: true, enabled: true, max_output_tokens: null,
      context_window: null, cost_per_mtok_in: costOut === null ? null : costOut,
      cost_per_mtok_out: costOut, created_at: '',
    },
  };
}

describe('isPaidModel', () => {
  it('is true only for a positive cost_per_mtok_out', () => {
    expect(isPaidModel(model('a', 0.2).model)).toBe(true);
  });

  it('is false for zero — the documented free-model value, not unknown', () => {
    expect(isPaidModel(model('a', 0).model)).toBe(false);
  });

  it('is false for NULL — unknown is not free, but it is also not paid', () => {
    expect(isPaidModel(model('a', null).model)).toBe(false);
  });
});

describe('orderByCost — substantive tasks prefer paid', () => {
  const free = model('free-model', 0);
  const paid = model('paid-model', 0.25);
  const unknown = model('unknown-cost-model', null);

  for (const task of ['reason', 'long', 'draft', 'code']) {
    it(`moves the paid model ahead of free/unknown for task="${task}"`, () => {
      const ordered = orderByCost([free, unknown, paid], task);
      expect(ordered.map((r) => r.model.id)).toEqual(['paid-model', 'free-model', 'unknown-cost-model']);
    });
  }

  it('is a stable sort within each half — original relative order is preserved', () => {
    const paidA = model('paid-a', 0.1);
    const paidB = model('paid-b', 0.2);
    const freeA = model('free-a', 0);
    const freeB = model('free-b', 0);
    const ordered = orderByCost([freeA, paidA, freeB, paidB], 'reason');
    expect(ordered.map((r) => r.model.id)).toEqual(['paid-a', 'paid-b', 'free-a', 'free-b']);
  });
});

describe('orderByCost — cheap tasks may take a free model', () => {
  const free = model('free-model', 0);
  const paid = model('paid-model', 0.25);

  for (const task of ['classify', 'extract']) {
    it(`moves the free model ahead of paid for task="${task}" — no reason to spend on cheap work`, () => {
      const ordered = orderByCost([paid, free], task);
      expect(ordered.map((r) => r.model.id)).toEqual(['free-model', 'paid-model']);
    });
  }
});

describe('orderByCost — a task outside the vocabulary is left untouched', () => {
  it('does not reorder for an unrecognized task tag', () => {
    const free = model('free-model', 0);
    const paid = model('paid-model', 0.25);
    const ordered = orderByCost([free, paid], 'summarize');
    // Unchanged from input order — no cost-based opinion for a task this
    // rule doesn't recognize.
    expect(ordered.map((r) => r.model.id)).toEqual(['free-model', 'paid-model']);
  });
});
