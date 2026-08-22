// tests/chokepoint.test.ts — runTool is the ONE door every capability walks through.
//
// The chat loop (streaming and non-streaming, including the post-approval
// resume) and the MCP server all execute capabilities through runTool(). That
// makes it the place the monthly spend limit is enforced, and the reason the
// limit cannot be forgotten when someone adds a new spend-gated capability.
//
// It had no tests. The three properties below are the ones a bypass would
// break, and a bypass is not hypothetical: Packet 0.3 found the MCP server
// calling runTool with no sensitivity check at all, and nothing caught it until
// a person happened to read the file.
//
//   ORDER      validate -> budget -> run. Money that has already left cannot be
//              un-spent by a later check, so the budget test must happen before
//              tool.run(), and validation before that so the budget hook sees
//              parsed arguments.
//   COVERAGE   the gate fires on gate==='spend' OR spendsMoney(args). "Reaches
//              a third party" and "costs money" are different axes; a
//              capability that commits spend through its ARGUMENTS must still
//              be caught.
//   CONTAINMENT runTool never throws. It returns {ok:false}. A throw here takes
//              down a turn that could have recovered and told the user why.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const budget = vi.hoisted(() => ({ overLimit: false, calls: [] as string[] }));

vi.mock('@/lib/budgets/store', () => ({
  assertWithinBudget: async (_accountId: string, label: string) => {
    budget.calls.push(label);
    if (budget.overLimit) throw new Error('Monthly spend limit reached for this account.');
  },
}));

const { runTool, TOOLS } = await import('@/lib/agent/tools');
const { CAPABILITY_BY_NAME } = await import('@/lib/capabilities/registry');

const ACCOUNT = 'acct_test';

/** Swap in a fake `run` so nothing touches a real service, and report whether
 *  it was reached — "did the gate stop it" is the whole question here.
 *
 *  Patches the TOOLS entry, not the Capability: TOOLS is built once at module
 *  load and COPIES `run` off each capability, so runTool would still call the
 *  original if we reassigned the capability's method here. */
function stub(name: string, impl?: () => any) {
  const tool: any = (TOOLS as any)[name];
  if (!tool) throw new Error(`no tool ${name}`);
  const original = tool.run;
  const spy = vi.fn(impl ?? (() => ({ ok: 1 })));
  tool.run = spy;
  return { spy, restore: () => { tool.run = original; } };
}

beforeEach(() => { budget.overLimit = false; budget.calls = []; });

describe('unknown and malformed calls never reach a capability', () => {
  it('an unknown tool is refused', async () => {
    const res = await runTool('noSuchTool', ACCOUNT, {});
    expect(res).toMatchObject({ ok: false });
    expect(res.error).toMatch(/unknown tool/i);
  });

  it('arguments are validated before the capability runs', async () => {
    // sendEmail requires contactId + subject. A model that hallucinates a call
    // must be stopped by the schema, not by the email service.
    const { spy, restore } = stub('sendEmail');
    try {
      const res = await runTool('sendEmail', ACCOUNT, { subject: 'no contact id' });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/invalid arguments/i);
      expect(spy).not.toHaveBeenCalled();
    } finally { restore(); }
  });

  it('validation happens before the budget is consulted', async () => {
    // Otherwise a malformed call would burn budget-check work, and worse, the
    // spendsMoney hook would inspect unparsed arguments.
    const { restore } = stub('launchCampaign');
    try {
      await runTool('launchCampaign', ACCOUNT, { notAnId: true });
      expect(budget.calls).toHaveLength(0);
    } finally { restore(); }
  });
});

describe('the spend gate cannot be walked past', () => {
  it('a spend-gated capability is checked against the budget', async () => {
    const { spy, restore } = stub('launchCampaign');
    try {
      await runTool('launchCampaign', ACCOUNT, { id: 'cmp_1', dailyBudget: 50 });
      expect(budget.calls).toHaveLength(1);
      expect(spy).toHaveBeenCalled();
    } finally { restore(); }
  });

  it('over budget, the capability never runs and the reason survives', async () => {
    // The refusal text is written by assertWithinBudget for a human. runTool
    // converts the throw into its {ok,error} contract WITHOUT flattening the
    // message, so the model can explain the block rather than retry it.
    budget.overLimit = true;
    const { spy, restore } = stub('launchCampaign');
    try {
      const res = await runTool('launchCampaign', ACCOUNT, { id: 'cmp_1', dailyBudget: 50 });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/spend limit/i);
      expect(spy).not.toHaveBeenCalled();
    } finally { restore(); }
  });

  it('a read capability is not charged against the budget', async () => {
    const { restore } = stub('listVentures', () => []);
    try {
      await runTool('listVentures', ACCOUNT, {});
      expect(budget.calls).toHaveLength(0);
    } finally { restore(); }
  });

  it('spendsMoney catches spend committed through the ARGUMENTS', async () => {
    // setAdStatus is external_send on every call, but only status ACTIVE
    // restarts a live ad. The gate must be argument-aware or that spend escapes.
    const cap: any = (CAPABILITY_BY_NAME as any)['setAdStatus'];
    if (!cap?.spendsMoney) return; // capability not present in this build
    expect(cap.spendsMoney({ status: 'ACTIVE' })).toBe(true);

    const { restore } = stub('setAdStatus');
    try {
      budget.calls = [];
      await runTool('setAdStatus', ACCOUNT, { metaObjectId: 'ad_1', status: 'ACTIVE' });
      const chargedForActive = budget.calls.length;
      budget.calls = [];
      await runTool('setAdStatus', ACCOUNT, { metaObjectId: 'ad_1', status: 'PAUSED' });
      const chargedForPaused = budget.calls.length;
      // Restarting a live ad resumes spend; pausing one cannot.
      expect(chargedForActive).toBe(1);
      expect(chargedForPaused).toBe(0);
    } finally { restore(); }
  });
});

describe('brand scope is enforced, not requested', () => {
  // THE BUG THIS PREVENTS. 23 capabilities declare a `brandId`, and the model
  // had to remember to pass it on every call. When it forgot, the tool ran
  // across EVERY brand in the account and nothing said so.
  //
  // Observed live: with Rentahub selected — which has zero companies —
  // listCompanies returned all nine belonging to filmops and retentionrail, and
  // the answer then attributed them to whichever brand the question named. Nine
  // WRITES are in that set (createLead, createCampaign, createDeal…), so records
  // could also be created under the wrong brand.
  //
  // Scope has to be applied at the tool boundary. A prompt asking the model to
  // remember is not a control.
  it('fills an absent brandId on a capability that declares one', async () => {
    const { spy, restore } = stub('listCompanies', () => []);
    try {
      await runTool('listCompanies', ACCOUNT, {}, undefined, undefined, 'rentahub');
      expect(spy).toHaveBeenCalled();
      expect((spy.mock.calls[0] as any[])[1]).toMatchObject({ brandId: 'rentahub' });
    } finally { restore(); }
  });

  it('an explicit brandId from the model always wins', async () => {
    // "What about FilmOps?" while Rentahub is selected is a real request, not a
    // mistake. The default fills a gap; it must never override an instruction.
    const { spy, restore } = stub('listCompanies', () => []);
    try {
      await runTool('listCompanies', ACCOUNT, { brandId: 'filmops' }, undefined, undefined, 'rentahub');
      expect((spy.mock.calls[0] as any[])[1]).toMatchObject({ brandId: 'filmops' });
    } finally { restore(); }
  });

  it('scopes WRITES too, not just reads', async () => {
    const { spy, restore } = stub('createCompany', () => ({ id: 'c1' }));
    try {
      await runTool('createCompany', ACCOUNT, { name: 'Acme' }, undefined, undefined, 'rentahub');
      expect((spy.mock.calls[0] as any[])[1]).toMatchObject({ name: 'Acme', brandId: 'rentahub' });
    } finally { restore(); }
  });

  it('leaves capabilities that declare no brandId untouched', async () => {
    // listVentures must keep listing every brand — defaulting a scope onto it
    // would hide the other brands from the operator entirely.
    const { spy, restore } = stub('listVentures', () => []);
    try {
      await runTool('listVentures', ACCOUNT, {}, undefined, undefined, 'rentahub');
      expect((spy.mock.calls[0] as any[])[1]).not.toHaveProperty('brandId');
    } finally { restore(); }
  });

  it('changes nothing when no brand is selected', async () => {
    // The MCP server passes no default — an API key has no selected brand.
    const { spy, restore } = stub('listCompanies', () => []);
    try {
      await runTool('listCompanies', ACCOUNT, {}, undefined, undefined, undefined);
      expect((spy.mock.calls[0] as any[])[1]).not.toHaveProperty('brandId');
    } finally { restore(); }
  });
});

describe('containment — a failing capability degrades, it does not crash the turn', () => {
  it('a throwing capability becomes {ok:false} with its message intact', async () => {
    const { restore } = stub('listVentures', () => { throw new Error('upstream exploded'); });
    try {
      const res = await runTool('listVentures', ACCOUNT, {});
      expect(res).toMatchObject({ ok: false, error: 'upstream exploded' });
    } finally { restore(); }
  });

  it('a capability rejecting asynchronously is contained the same way', async () => {
    const { restore } = stub('listVentures', () => Promise.reject(new Error('timeout')));
    try {
      const res = await runTool('listVentures', ACCOUNT, {});
      expect(res).toMatchObject({ ok: false, error: 'timeout' });
    } finally { restore(); }
  });

  it('a capability throwing a non-Error still yields a usable message', async () => {
    const { restore } = stub('listVentures', () => { throw 'just a string'; });
    try {
      const res = await runTool('listVentures', ACCOUNT, {});
      expect(res.ok).toBe(false);
      expect(typeof res.error).toBe('string');
      expect(res.error!.length).toBeGreaterThan(0);
    } finally { restore(); }
  });
});
