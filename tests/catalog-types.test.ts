// Revert-check for the catalogLine() arg-type fix (lib/agent/tools.ts).
//
// The catalog used to render `name(arg1, arg2?)` — keys only, the schema's
// `type` discarded even though every property declares one. The model could
// not tell a `string` arg from an `array` arg and guessed, tripping runTool()'s
// zod validation. This test pins the typed rendering so a regression back to
// keys-only is caught immediately.
import { describe, it, expect } from 'vitest';
import { toolCatalogForPrompt } from '@/lib/agent/tools';
import { CAPABILITIES, describeDomain } from '@/lib/capabilities/registry';

describe('catalog arg types', () => {
  const catalog = toolCatalogForPrompt();

  it('renders a required array argument as name:arr', () => {
    // enrollInSequence(sequenceId: string, contactIds: array) — both required.
    const line = catalog.split('\n').find((l) => l.startsWith('enrollInSequence('));
    expect(line).toBeDefined();
    expect(line).toContain('sequenceId:str');
    expect(line).toContain('contactIds:arr');
    // Neither arg is optional — must not carry a `?`.
    expect(line).not.toContain('sequenceId?');
    expect(line).not.toContain('contactIds?');
  });

  it('renders an optional string argument as name?:str', () => {
    // enrichLead's args are all optional identity hints.
    const line = catalog.split('\n').find((l) => l.startsWith('enrichLead('));
    expect(line).toBeDefined();
    expect(line).toContain('contactId?:str');
    expect(line).toContain('email?:str');
  });
});

// Equivalence check between the two catalog renderers.
//
// lib/agent/tools.ts's catalogLine() (feeding toolCatalogForPrompt, stage 1's
// full form) and lib/capabilities/registry.ts's fullLineOf() (feeding
// describeDomain, the staged catalog's stage-2 domain expansion) render the
// SAME logical thing — one line per capability: name(args) [needs approval] —
// description. Commit 91b13be taught catalogLine to render argument types but,
// per its task brief, did not touch registry.ts, which had its own duplicate
// of the old untyped rendering logic. That is the same "two things that must
// stay identical, one updated" failure CLAUDE.md names for runAgentImpl and
// runAgentStreamImpl. Both renderers now call the single shared
// renderCatalogLine() (lib/capabilities/registry.ts), so this test — which
// would have caught the original drift — should pass by construction. It
// covers every one of the 182 registered capabilities, not a sample: a fix
// applied to only one renderer is a fix applied to neither, and a sample
// could miss the exact capability that would have exposed it.
describe('catalog line renderer parity (full form vs staged stage-2)', () => {
  const fullCatalog = toolCatalogForPrompt();
  const fullLinesByName = new Map<string, string>();
  for (const line of fullCatalog.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_]+)\(/);
    if (m) fullLinesByName.set(m[1], line);
  }

  const domains = Array.from(new Set(CAPABILITIES.map((c) => c.domain)));
  const stagedLinesByDomain = new Map(domains.map((d) => [d, describeDomain(d).tools]));

  it('covers all registered capabilities (sanity on the test itself)', () => {
    expect(CAPABILITIES.length).toBeGreaterThanOrEqual(182);
    expect(fullLinesByName.size).toBe(CAPABILITIES.length);
  });

  it.each(CAPABILITIES.map((c) => [c.name, c.domain] as const))(
    'stage-2 line for %s matches the full-catalog line',
    (name, domain) => {
      const fullLine = fullLinesByName.get(name);
      expect(fullLine, `no full-catalog line found for ${name}`).toBeDefined();

      const staged = stagedLinesByDomain.get(domain) ?? [];
      const stagedLine = staged.find((l) => l.startsWith(`${name}(`));
      expect(stagedLine, `no staged domain line found for ${name} in domain ${domain}`).toBeDefined();

      expect(stagedLine).toBe(fullLine);
    },
  );
});
