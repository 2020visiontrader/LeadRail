// THE PRODUCTION DEFECT this guards against (observed in production today):
// the assistant's visible trace showed
//
//     Checking what you have saved
//     No documents are saved to the library. {"documents":[]}
//
// — raw JSON, rendered straight into what a person reads. CLAUDE.md is
// explicit: "Results reaching a human are readable prose. Raw JSON in a
// user-facing message is a defect regardless of which tool produced it.
// Render by payload shape, never by a tool-name allowlist."
//
// WHY THIS TEST IS DRIVEN OFF THE REGISTRY, NOT A FIXTURE LIST. A hand-picked
// list of "the tools I checked" is exactly how this defect reached 86 of 195
// capabilities unnoticed — nobody updates a fixture for a capability they
// didn't know needed one. This file enumerates CAPABILITIES at runtime and
// feeds every one of them a set of representative RESULT SHAPES (an empty
// list, a populated list, a created record, a boolean, a count, the exact
// production shape, …) through the SAME digest+raw pipeline
// lib/agent/loop.ts's successObservation() builds and the SAME renderer
// (renderObservation, from lib/agent/observation-render.ts) the live SSE
// trace now applies before a person ever sees the text (see loop.ts's
// displayObservation()). A capability added tomorrow is covered on the day
// it's added — no edit to this file required.
//
// What "readable prose" means here is deliberately narrow and mechanical:
// the rendered text must not contain the raw-JSON markers `{"`, `":[`, or
// `":{` — the literal fingerprints of an un-rendered `JSON.stringify(...)`
// dump. That is what actually reached the user in production; it is not a
// style opinion about prose quality.

import { describe, it, expect } from 'vitest';
import { CAPABILITIES } from '@/lib/capabilities/registry';
import type { Capability } from '@/lib/capabilities/types';
import { renderObservation } from '@/lib/agent/observation-render';

const DISPLAY_BUDGET = 20_000; // generous — this test is about shape, not truncation.

/** The exact raw-JSON fingerprints the production defect actually showed a
 *  person: an opening `{"key"`, a `"key":[` array field, or a `"key":{`
 *  nested object field. Deliberately NOT "any brace" — a rendered record is
 *  allowed to say `tags: ["vip","cold"]` (a labelled field's own value,
 *  already established and tested behaviour of observation-render.ts); what
 *  must never appear is the raw envelope dump itself. */
const RAW_JSON_MARKERS = ['{"', '":[', '":{'];

function findRawJsonMarker(text: string): string | undefined {
  return RAW_JSON_MARKERS.find((m) => text.includes(m));
}

/** Mirrors lib/agent/loop.ts's successObservation() exactly: digest (if any,
 *  and if it doesn't throw) goes first, the raw JSON follows on its own line;
 *  no digest means raw JSON alone. This is deliberately a copy rather than an
 *  import — successObservation is not exported, by design (it is loop.ts's
 *  internal plumbing) — but the shape it produces is a stable, documented
 *  contract (loop.ts lines around "successObservation", CLAUDE.md's digest
 *  rule) that this test pins independently of loop.ts's internals. */
function buildObservationText(c: Capability, args: any, result: any): string {
  const raw = JSON.stringify(result);
  let digest = '';
  try {
    digest = (c.digest?.(args, result) || '').trim();
  } catch {
    digest = '';
  }
  return digest ? `${digest}\n${raw}` : raw;
}

/** What a person actually sees in the live trace today (loop.ts's
 *  displayObservation()). */
function displayFor(c: Capability, args: any, result: any): string {
  return renderObservation(buildObservationText(c, args, result), DISPLAY_BUDGET);
}

// A generous, plausible args object — same idea as capability-digest-guard's
// fixture: real enough that a digest reading `args.email` or `args.id`
// doesn't throw, but never load-bearing for what this file actually checks.
const ARGS = {
  id: 'rec-1', accountId: 'acct-1', contactId: 'contact-1', sequenceId: 'seq-1',
  contactIds: ['contact-1', 'contact-2'], subject: 'Hello', html: '<p>hi</p>',
  dailyBudget: 50, platform: 'facebook', accountExternalId: 'page-1', message: 'hi',
  text: 'hi', commentId: 'comment-1', recipientId: 'person-1', channelId: 'chan-1',
  dueAt: '2026-09-09T10:00:00Z', metaObjectId: 'act-1', status: 'ACTIVE', hide: true,
  inboxMessageId: 'inbox-1', bodyHtml: '<p>hi</p>', externalId: 'apollo-1',
  email: 'a@b.com', name: 'Ada', company: 'Acme', limit: 25, document: 'doc-1',
  includeThisChat: false, query: 'budget', offset: 0,
};

// Representative RESULT shapes — chosen to cover the families the task calls
// out by name: an empty list, a list of N, a created/updated record with an
// id, a boolean outcome, a count — plus the exact production shape
// (`{documents:[]}`) and a couple of edge shapes (null, a bare string/number)
// that a real capability can and does return.
const SHAPES: Array<[string, any]> = [
  ['empty array', []],
  ['empty object', {}],
  ['null', null],
  ['a bare string', 'ok'],
  ['a bare number', 42],
  ['a bare boolean (true)', true],
  ['a bare boolean (false)', false],
  ['a count wrapper', { count: 5 }],
  ['a created record with an id', { id: 'new-rec-42', created: true, name: 'New thing' }],
  ['a list of 3 records', [
    { id: 'a', name: 'Ada', title: 'CEO' },
    { id: 'b', name: 'Grace', title: 'CTO' },
    { id: 'c', name: 'Alan', title: 'COO' },
  ]],
  // The exact production shape.
  ['the production case — {documents:[]}', { documents: [] }],
  ['a populated wrapped list', { documents: [{ id: 'd1', name: 'Brand book' }, { id: 'd2', name: 'Price list' }] }],
];

describe('every capability, fed representative result shapes, renders prose — never raw JSON', () => {
  it('the registry actually loaded (a vacuous pass would mean nothing was checked)', () => {
    expect(CAPABILITIES.length).toBeGreaterThan(100);
  });

  for (const [label, result] of SHAPES) {
    it(`no capability leaks a raw-JSON marker for: ${label}`, () => {
      const offenders: string[] = [];
      for (const c of CAPABILITIES) {
        const out = displayFor(c, ARGS, result);
        const marker = findRawJsonMarker(out);
        if (marker) offenders.push(`${c.name}: found "${marker}" in ${JSON.stringify(out).slice(0, 200)}`);
      }
      expect(offenders).toEqual([]);
    });
  }
});

// THE EXACT PRODUCTION LINE. listDocuments already carries a digest ("No
// documents are saved to the library." / "N document(s) saved and
// readable."); the defect was never that this digest was missing — it's that
// the raw JSON appended after it (`{"documents":[]}`) was shown to the person
// verbatim. This asserts the actual, named tool and the actual, named result.
describe('the production case, by name', () => {
  it('listDocuments with zero saved documents renders no raw JSON', () => {
    const listDocuments = CAPABILITIES.find((c) => c.name === 'listDocuments');
    expect(listDocuments).toBeTruthy();
    const out = displayFor(listDocuments!, {}, { documents: [] });
    expect(findRawJsonMarker(out)).toBeUndefined();
    expect(out).toContain('No documents are saved to the library.');
  });
});

// THE GUARD ACTUALLY GUARDS. A digest that leaks JSON must be caught, not
// silently accepted — this is the revert-check for the guard mechanism
// itself: a deliberately broken capability proves the assertion above is
// live, not vacuous.
describe('the guard catches a deliberately JSON-leaking capability', () => {
  it('flags a capability whose digest itself dumps raw JSON', () => {
    const leaking: Capability = {
      name: 'zzzDeliberatelyBroken',
      domain: 'knowledge',
      title: 'Deliberately broken for the test',
      description: 'n/a',
      gate: 'read',
      inputSchema: { type: 'object', properties: {}, required: [] } as any,
      zod: undefined as any,
      run: async () => ({}),
      digest: (_a: any, r: any) => `Here is what happened: ${JSON.stringify(r)}`,
    };
    const out = displayFor(leaking, {}, { documents: [] });
    expect(findRawJsonMarker(out)).toBe('{"');
  });

  it('does NOT flag the same capability once its digest is fixed to prose (sanity: the check is not always-true)', () => {
    const fixed: Capability = {
      name: 'zzzDeliberatelyBroken',
      domain: 'knowledge',
      title: 'Deliberately broken for the test',
      description: 'n/a',
      gate: 'read',
      inputSchema: { type: 'object', properties: {}, required: [] } as any,
      zod: undefined as any,
      run: async () => ({}),
      digest: () => 'Nothing to report.',
    };
    const out = displayFor(fixed, {}, { documents: [] });
    expect(findRawJsonMarker(out)).toBeUndefined();
  });
});
