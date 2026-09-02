// A digest is PREPENDED to the raw payload, never substituted for it.
//
// THE PRODUCTION DEFECT (agent_conversations, project kqimpzbphdogvchqmtos,
// queried 2026-09-02). The largest message ever stored is 281,956 characters.
// It opens with a correct, useful digest — "61 leads returned. By status: 61
// new. Includes: Markus Holzinger, Marvin Molenaar, Julieth Quiceno." — and is
// then followed by ~282k characters of raw lead rows. Two independent
// conversations each hold one, and the more recent was written by the code
// currently on main (that conversation's updated_at is 2026-09-02), so this is
// live behaviour and not a historical artefact. Those two messages alone are
// 563,912 of the 1,090,511 characters of user-role content in the project —
// 52% of every transcript in it, for two tool calls.
//
// It is not a cap that failed. BUDGET.observationChars resolves to 400,000, so
// 281,956 is legally under the ceiling. The fix changes the SHAPE of what is
// stored: lib/agent/observation-reduce.ts.
//
// WHAT MUST NOT BREAK, and is asserted here as hard as the reduction itself:
//   - every id survives EXACTLY (an agent that cannot see ids cannot act);
//   - the digest text survives intact;
//   - a small result is BYTE-IDENTICAL to what it was before;
//   - the payload is never cut mid-JSON.
//
// CLAUDE.md: the two loops must stay identical, so the loop-level assertions
// run against runAgent AND runAgentStream on the same fixture.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  reduceObservationPayload,
  REDUCE_THRESHOLD_WITH_DIGEST,
  REDUCE_THRESHOLD_NO_DIGEST,
  MAX_ROW_FIELDS,
} from '@/lib/agent/observation-reduce';

// ---------------------------------------------------------------------------
// The real payload shape. Columns are the actual `contacts` table (queried from
// production); `enriched` is the jsonb blob that makes a lead row ~4.6kB, which
// is where 61 rows x ~4.6kB = the observed 282,000 characters comes from.
// ---------------------------------------------------------------------------

const uuid = (n: number) => `4eeae0ec-4bf8-4aec-98c5-${String(n).padStart(12, '0')}`;

function leadRow(n: number) {
  return {
    id: uuid(n),
    account_id: uuid(9000 + n),
    company_id: uuid(8000 + n),
    brand_id: 'brand-alpha',
    name: `Lead Number ${n}`,
    email: `lead${n}@example.com`,
    company: `Company ${n} GmbH`,
    title: 'Head of Social Media',
    segment: 'agency',
    score: n,
    status: 'new',
    source: 'apollo',
    linkedin_url: `https://www.linkedin.com/in/lead-number-${n}`,
    phone: null,
    enrichment_status: 'enriched',
    fit_verdict: 'good',
    notes: `Long free-text note about lead ${n}. `.repeat(40),
    created_at: '2026-08-19T12:57:57.848Z',
    updated_at: '2026-08-27T06:25:28.740Z',
    deleted_at: null,
    custom_fields: { utm: { source: 'linkedin', campaign: 'q3' }, tags: ['agency', 'dach'] },
    enriched: {
      apollo_id: `apollo-${n}`,
      headline: `Founder & Head of Social at Company ${n} `.repeat(6),
      bio: `Career summary paragraph for lead ${n}. `.repeat(60),
      employment_history: Array.from({ length: 6 }, (_, i) => ({
        title: `Role ${i}`, organization_name: `Prior Company ${i}`,
        description: `What they did in role ${i}. `.repeat(20),
      })),
      organization: { name: `Company ${n} GmbH`, description: `About the company. `.repeat(40) },
    },
  };
}

const SIXTY_ONE = Array.from({ length: 61 }, (_, i) => leadRow(i + 1));
const DIGEST = '61 leads returned. By status: 61 new. Includes: Lead Number 1, Lead Number 2, Lead Number 3.';

describe('reduceObservationPayload — the 61-lead production payload', () => {
  const raw = JSON.stringify(SIXTY_ONE);

  it('the fixture really is the size the defect is about', () => {
    // Guards the whole file: a fixture that quietly shrank below the threshold
    // would make every assertion below vacuously true.
    expect(raw.length).toBeGreaterThan(200_000);
    expect(raw.length).toBeGreaterThan(REDUCE_THRESHOLD_WITH_DIGEST);
  });

  it('is reduced dramatically, and says so', () => {
    const out = reduceObservationPayload(SIXTY_ONE, raw, true);
    expect(out.note).toBe('… reduced: 61 rows, ids and key fields only (full payload omitted).');
    expect(out.raw.length).toBeLessThan(raw.length / 20);
  });

  it('preserves every id EXACTLY', () => {
    const out = reduceObservationPayload(SIXTY_ONE, raw, true);
    // Assert the REDUCED form is what is being inspected. Without this the
    // test passes against an unreduced payload — the ids are trivially intact
    // when nothing happened — and would report a safety that is not there.
    expect(out.note).not.toBeNull();
    const rows = JSON.parse(out.raw);
    expect(rows).toHaveLength(61);
    for (let i = 0; i < 61; i++) {
      // Not "contains a uuid-looking thing": the same value, character for
      // character, on the same key. Every lead/campaign/post capability takes
      // an id, so a reformatted id is a broken agent.
      expect(rows[i].id).toBe(SIXTY_ONE[i].id);
      expect(rows[i].account_id).toBe(SIXTY_ONE[i].account_id);
      expect(rows[i].company_id).toBe(SIXTY_ONE[i].company_id);
      expect(rows[i].brand_id).toBe(SIXTY_ONE[i].brand_id);
    }
  });

  it('keeps a few short scalars per row and drops the bulk', () => {
    const rows = JSON.parse(reduceObservationPayload(SIXTY_ONE, raw, true).raw);
    expect(rows[0].name).toBe('Lead Number 1');
    expect(rows[0].status).toBe('new');
    // The bulk: nested objects, arrays and long prose.
    expect(rows[0].enriched).toBeUndefined();
    expect(rows[0].custom_fields).toBeUndefined();
    expect(rows[0].notes).toBeUndefined();
    const nonId = Object.keys(rows[0]).filter((k) => !/(^id$|_id$)/.test(k));
    expect(nonId.length).toBeLessThanOrEqual(MAX_ROW_FIELDS);
  });

  it('emits well-formed JSON — never a half-object', () => {
    const out = reduceObservationPayload(SIXTY_ONE, raw, true);
    expect(out.note).not.toBeNull(); // same reason as above
    expect(() => JSON.parse(out.raw)).not.toThrow();
    expect(out.raw.endsWith(']')).toBe(true);
    // The note is NOT inside the JSON; it rides on the digest line, so
    // observation-render.ts can still parse the payload.
    expect(out.raw).not.toContain('reduced:');
  });
});

describe('reduceObservationPayload — a small result is untouched', () => {
  it('is byte-identical, with no note, digest or not', () => {
    const small = [leadRow(1)];
    const raw = JSON.stringify(small);
    expect(raw.length).toBeLessThan(REDUCE_THRESHOLD_WITH_DIGEST);
    for (const hasDigest of [true, false]) {
      const out = reduceObservationPayload(small, raw, hasDigest);
      expect(out.raw).toBe(raw); // identity, not equality of parsed shape
      expect(out.note).toBeNull();
    }
  });

  it('leaves every non-row shape alone whatever its size', () => {
    const prose = { report: 'x'.repeat(REDUCE_THRESHOLD_NO_DIGEST + 5_000) };
    const raw = JSON.stringify(prose);
    const out = reduceObservationPayload(prose, raw, true);
    // Nothing here is an array of rows, so there is no honest reduction to
    // make; the existing per-observation cap remains what bounds it.
    expect(out.raw).toBe(raw);
    expect(out.note).toBeNull();
  });
});

describe('reduceObservationPayload — the NO-DIGEST path is more conservative', () => {
  // With no digest the payload is the only signal the model has, so the
  // threshold is three times higher: reducing early would delete the result's
  // meaning with nothing to put in its place.
  const between = Array.from(
    { length: 61 },
    (_, i) => ({ id: uuid(i), name: `Lead ${i}`, bio: 'y'.repeat(320) }),
  );

  it('a payload between the two thresholds is reduced WITH a digest and kept without one', () => {
    const raw = JSON.stringify(between);
    expect(raw.length).toBeGreaterThan(REDUCE_THRESHOLD_WITH_DIGEST);
    expect(raw.length).toBeLessThan(REDUCE_THRESHOLD_NO_DIGEST);

    expect(reduceObservationPayload(between, raw, true).note).toContain('61 rows');
    const noDigest = reduceObservationPayload(between, raw, false);
    expect(noDigest.raw).toBe(raw);
    expect(noDigest.note).toBeNull();
  });

  it('but is still bounded — a big enough dump is reduced even with no digest', () => {
    const raw = JSON.stringify(SIXTY_ONE);
    expect(raw.length).toBeGreaterThan(REDUCE_THRESHOLD_NO_DIGEST);
    const out = reduceObservationPayload(SIXTY_ONE, raw, false);
    expect(out.note).toContain('61 rows');
    expect(JSON.parse(out.raw)[0].id).toBe(SIXTY_ONE[0].id);
  });
});

describe('reduceObservationPayload — wrapped rows and hostile input', () => {
  it('reduces rows nested under a wrapper key and keeps the wrapper facts', () => {
    const wrapped = { candidates: SIXTY_ONE, total: 1621, status: 'ok' };
    const raw = JSON.stringify(wrapped);
    const out = reduceObservationPayload(wrapped, raw, true);
    const parsed = JSON.parse(out.raw);
    expect(out.note).toContain('61 rows');
    expect(parsed.total).toBe(1621); // the wrapper's own facts are small and load-bearing
    expect(parsed.status).toBe('ok');
    expect(parsed.candidates[60].id).toBe(SIXTY_ONE[60].id);
  });

  it('never throws, and never returns something larger than doing nothing', () => {
    const cases: any[] = [null, undefined, 0, 'a string', [1, 2, 3], [[]], { a: undefined }];
    for (const c of cases) {
      const raw = JSON.stringify(c);
      const out = reduceObservationPayload(c, raw, true);
      expect(out.raw).toBe(raw);
      expect(out.note).toBeNull();
    }
    // A circular result would already have thrown in the caller's
    // JSON.stringify; this asserts we add no NEW throw of our own.
    const circular: any = { rows: [{ id: 'a' }] };
    circular.rows[0].self = circular;
    expect(() => reduceObservationPayload(circular, 'x'.repeat(50_000), true)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The real loops. Same mock frame as tests/agent-reads.test.ts. This is the
// part that proves the reduction is on the PATH — successObservation() is
// module-private, and a test that re-implemented it could not see a wiring bug.
// ---------------------------------------------------------------------------

const generateChat = vi.fn();
const runTool = vi.fn();

vi.mock('@/lib/ai/router', () => ({
  generateChat: (...a: any[]) => generateChat(...a),
  streamChat: vi.fn(),
  textConfigured: () => true,
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() } }));
vi.mock('@/lib/agent/tools', () => ({
  TOOLS: { listLeads: { title: 'List leads', sensitive: false } },
  runTool: (...a: any[]) => runTool(...a),
  toolCatalogForPrompt: () => 'TOOLS',
  toolCatalogStaged: () => 'TOOLS',
  AGENT_STAGED_CATALOG: false,
  capabilityFor: (n: string) =>
    n === 'listLeads'
      ? { gate: 'read', digest: () => DIGEST }
      : undefined,
  toolsFromCapabilities: () => ({}),
}));
vi.mock('@/lib/capabilities/external-mcp', () => ({ loadExternalCapabilities: async () => [] }));
vi.mock('@/lib/agent/personas', () => ({
  loadPersonaForAgent: async () => null,
  resolveMentionedPersonas: async () => [],
  getCoordinator: async () => null,
  selectPersonasForRequest: async () => [],
  buildPersonaSystemBlock: () => '',
  buildCoordinatorSystemBlock: () => '',
  parseMentions: () => [],
}));
vi.mock('@/lib/skills/store', () => ({ loadEnabledSkillsForAgent: async () => [] }));
vi.mock('@/lib/agent/compose', () => ({ composeAnswer: async (a: any) => a?.draft ?? '' }));
vi.mock('@/lib/approvals/store', () => ({
  createApproval: vi.fn(),
  consumeApprovalForExecution: vi.fn(),
  markApprovedByToolAndArgs: vi.fn(),
  ApprovalExecutionError: class extends Error {},
}));
vi.mock('@/lib/capabilities/delegation', () => ({
  beginDelegationScope: vi.fn(), endDelegationScope: vi.fn(), setDelegationContext: vi.fn(),
}));
vi.mock('@/lib/ai/hermes', () => ({ hermesRoute: async () => ({ skillIds: [] }) }));
vi.mock('@/lib/credits', () => ({ markParseOutcome: vi.fn(), recordAiUsage: vi.fn() }));
vi.mock('@/lib/db', () => ({ supabase: { from: () => ({}) }, dbReady: () => false }));

const CALL = JSON.stringify({ plan: 'List the leads.', narration: 'Listing leads…', action: 'tool', tool: 'listLeads', args: { limit: 61 } });
const FINAL = JSON.stringify({ plan: 'Done.', narration: 'Writing it up…', action: 'final', message: 'All done.' });

beforeEach(() => {
  vi.resetModules();
  generateChat.mockReset();
  runTool.mockReset();
});

const observationsFrom = async (result: any) => {
  runTool.mockImplementation(async () => ({ ok: true, result }));
  generateChat.mockResolvedValueOnce(CALL).mockResolvedValueOnce(FINAL);
  const { runAgent } = await import('@/lib/agent/loop');
  const res = await runAgent({ accountId: 'acct-1', message: 'list my leads', conversationId: 'conv-1' });
  const step = res.steps.find((s) => s.tool === 'listLeads')!;
  const msg = res.transcript.find((m) => m.content.startsWith('OBSERVATION:'))!;
  return { step: step.observation!, message: msg.content };
};

const streamObservationsFrom = async (result: any) => {
  runTool.mockImplementation(async () => ({ ok: true, result }));
  generateChat.mockResolvedValueOnce(CALL).mockResolvedValueOnce(FINAL);
  const { runAgentStream } = await import('@/lib/agent/loop');
  const events: any[] = [];
  await runAgentStream({ accountId: 'acct-1', message: 'list my leads', conversationId: 'conv-1' }, (e) => events.push(e));
  return events.find((e) => e.type === 'observation' && e.tool === 'listLeads').text as string;
};

describe('the transcript no longer carries the whole lead list (non-streaming loop)', () => {
  it('keeps the digest, states the reduction, keeps every id, and is far smaller', async () => {
    const before = JSON.stringify(SIXTY_ONE).length;
    const { step, message } = await observationsFrom(SIXTY_ONE);

    expect(message.startsWith(`OBSERVATION: ${DIGEST} … reduced: 61 rows`)).toBe(true);
    expect(message.length).toBeLessThan(before / 20);

    const payload = step.slice(step.indexOf('\n') + 1);
    const rows = JSON.parse(payload); // parseable: never cut mid-JSON
    expect(rows.map((r: any) => r.id)).toEqual(SIXTY_ONE.map((r) => r.id));
  });

  it('a small result reaches the transcript exactly as it did before', async () => {
    const small = [leadRow(1)];
    const { message } = await observationsFrom(small);
    expect(message).toBe(`OBSERVATION: ${DIGEST}\n${JSON.stringify(small)}`);
  });
});

describe('the streaming loop does exactly the same thing', () => {
  it('reduces the same payload identically (CLAUDE.md: the loops stay identical)', async () => {
    const big = await streamObservationsFrom(SIXTY_ONE);
    expect(big.startsWith(`${DIGEST} … reduced: 61 rows`)).toBe(true);
    const rows = JSON.parse(big.slice(big.indexOf('\n') + 1));
    expect(rows.map((r: any) => r.id)).toEqual(SIXTY_ONE.map((r) => r.id));

    const small = [leadRow(1)];
    expect(await streamObservationsFrom(small)).toBe(`${DIGEST}\n${JSON.stringify(small)}`);
  });
});
