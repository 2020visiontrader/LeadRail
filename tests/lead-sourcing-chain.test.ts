// The source -> reveal chain, which had no working path at all: sourceLeads
// hands back candidates keyed by `external_id`, and enrichLead had no parameter
// that accepted one. These pin the contract between the two tools, because a
// break here is invisible — it does not error, it returns the wrong person.

import { describe, it, expect } from 'vitest';
import { CAPABILITY_BY_NAME } from '@/lib/capabilities/registry';

const sourceLeads = CAPABILITY_BY_NAME['sourceLeads'];
const enrichLead = CAPABILITY_BY_NAME['enrichLead'];

describe('sourceLeads', () => {
  it('clamps an over-large limit instead of rejecting it', () => {
    // A request for 50 used to fail validation and hand the model a raw zod
    // dump, costing a step to learn a cap the tool never stated.
    const parsed = (sourceLeads.zod as any).parse({ titles: ['CMO'], limit: 50 });
    expect(parsed.limit).toBe(25);
  });

  it('leaves a limit within range alone', () => {
    expect((sourceLeads.zod as any).parse({ limit: 10 }).limit).toBe(10);
  });

  it('floors a fractional limit to at least one', () => {
    expect((sourceLeads.zod as any).parse({ limit: 0 }).limit).toBe(1);
  });

  it('states the cap in its description, so the model does not have to discover it', () => {
    expect(sourceLeads.description).toMatch(/capped at 25/i);
  });

  it('tells the model that candidates carry an external_id', () => {
    // The only thing that makes the next step possible.
    expect(sourceLeads.description).toMatch(/external_id/);
  });
});

describe('enrichLead', () => {
  it('accepts the external_id a sourced candidate carries', () => {
    const parsed = (enrichLead.zod as any).parse({ externalId: '66f82079f1da2100010c6d54' });
    expect(parsed.externalId).toBe('66f82079f1da2100010c6d54');
  });

  it('advertises externalId in the schema the model is shown', () => {
    expect(Object.keys((enrichLead.inputSchema as any).properties)).toContain('externalId');
  });

  it('warns that a masked candidate cannot be revealed by name', () => {
    // apollo.ts: matching an obfuscated name returns a still-masked record or
    // the wrong person. That failure is silent, so the guidance has to be loud.
    expect(enrichLead.description).toMatch(/masked/i);
  });

  it('names the sourced candidate on the approval card', () => {
    // "contactId: abc123" tells a reviewer nothing; the reviewer is the whole
    // point of a spend gate.
    const line = enrichLead.summarize!({ externalId: '66f82079f1da2100010c6d54' });
    expect(line).toContain('66f82079f1da2100010c6d54');
  });

  it('is still gated on spend', () => {
    expect(enrichLead.gate).toBe('spend');
    expect(sourceLeads.gate).toBe('spend');
  });
});
