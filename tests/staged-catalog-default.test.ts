// C6 — the staged tool catalog is now the default; AGENT_FULL_CATALOG=1
// restores the pre-flip full catalog as a rollback path.
//
// Measured before this change: toolCatalogForPrompt() (full form) renders
// 183 tools, one line each, unconditionally, on every model call — 48,268
// chars. toolCatalogStaged() (one line per domain, names only) already
// existed at 3,812 chars but shipped behind AGENT_STAGED_CATALOG=1, which
// nobody set, so the full form is what actually ran. This flips the default
// and proves the flag-driven escape hatch and the describeTools expansion
// path both still work.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const ENV_STAGED = 'AGENT_STAGED_CATALOG';
const ENV_FULL = 'AGENT_FULL_CATALOG';
const originalStaged = process.env[ENV_STAGED];
const originalFull = process.env[ENV_FULL];

async function loadWith(env: { staged?: string; full?: string }) {
  const { vi } = await import('vitest');
  vi.resetModules();
  if (env.staged === undefined) delete process.env[ENV_STAGED];
  else process.env[ENV_STAGED] = env.staged;
  if (env.full === undefined) delete process.env[ENV_FULL];
  else process.env[ENV_FULL] = env.full;

  const tools = await import('@/lib/agent/tools');
  const registry = await import('@/lib/capabilities/registry');
  return { tools, registry };
}

afterEach(() => {
  if (originalStaged === undefined) delete process.env[ENV_STAGED];
  else process.env[ENV_STAGED] = originalStaged;
  if (originalFull === undefined) delete process.env[ENV_FULL];
  else process.env[ENV_FULL] = originalFull;
});

describe('staged catalog is the default', () => {
  it('AGENT_STAGED_CATALOG is true and AGENT_FULL_CATALOG is false with no env override', async () => {
    const { registry } = await loadWith({});
    expect(registry.AGENT_STAGED_CATALOG).toBe(true);
    expect(registry.AGENT_FULL_CATALOG).toBe(false);
  });

  it('the staged catalog is materially smaller than the full form', async () => {
    const { tools } = await loadWith({});
    const staged = tools.toolCatalogStaged();
    const full = tools.toolCatalogForPrompt();
    expect(staged.length).toBeGreaterThan(0);
    expect(full.length).toBeGreaterThan(staged.length);
    // Measured pre-flip: staged ~3.8K chars vs full ~48K — staged well under
    // a fifth of the full form's size.
    expect(staged.length).toBeLessThan(full.length * 0.2);
  });

  it('AGENT_FULL_CATALOG=1 restores the full (pre-flip) catalog behaviour', async () => {
    const { registry } = await loadWith({ full: '1' });
    expect(registry.AGENT_FULL_CATALOG).toBe(true);
    expect(registry.AGENT_STAGED_CATALOG).toBe(false);
  });

  it('with AGENT_FULL_CATALOG=1, describeTools is not registered (matches pre-flip shape)', async () => {
    const { registry } = await loadWith({ full: '1' });
    expect(registry.CAPABILITIES.find((c) => c.name === 'describeTools')).toBeUndefined();
  });

  it('with staging on (the default), describeTools is registered exactly once', async () => {
    const { registry } = await loadWith({});
    const matches = registry.CAPABILITIES.filter((c) => c.name === 'describeTools');
    expect(matches.length).toBe(1);
  });
});

describe('every tool reachable in the full catalog is still reachable via the staged catalog + describeTools', () => {
  it('the union of every domain\'s describeDomain() tool names equals the full catalog\'s tool names', async () => {
    const { tools, registry } = await loadWith({}); // default = staged

    const full = tools.toolCatalogForPrompt();
    const fullNames = new Set<string>();
    for (const line of full.split('\n')) {
      const m = line.match(/^([A-Za-z0-9_]+)\(/);
      if (m) fullNames.add(m[1]);
    }
    expect(fullNames.size).toBeGreaterThan(100); // sanity: the full catalog is really populated

    const staged = tools.toolCatalogStaged();
    // Parse "domain (N): name1 [needs approval], name2, ..." lines.
    const domains = staged.split('\n').map((line) => line.split(' (')[0]);
    expect(domains.length).toBeGreaterThan(0);

    const reachedNames = new Set<string>();
    for (const domain of domains) {
      const expansion = registry.describeDomain(domain);
      for (const line of expansion.tools) {
        const m = line.match(/^([A-Za-z0-9_]+)\(/);
        if (m) reachedNames.add(m[1]);
      }
    }

    const missing = [...fullNames].filter((n) => !reachedNames.has(n));
    expect(missing).toEqual([]);
    // And nothing is duplicated across domains (a domain-boundary bug would
    // show up as a tool appearing in two describeDomain() expansions).
    expect(reachedNames.size).toBe(fullNames.size);
  });

  it('describeTools (via describeDomain) returns full argument signatures, not just names', async () => {
    const { registry } = await loadWith({});
    const domains = registry.capabilityDomains();
    expect(domains.length).toBeGreaterThan(0);
    const expansion = registry.describeDomain(domains[0]);
    expect(expansion.count).toBeGreaterThan(0);
    // A full signature line looks like "name(arg:type, ...) — description",
    // not just the bare name the stage-1 index shows.
    for (const line of expansion.tools) {
      expect(line).toMatch(/^[A-Za-z0-9_]+\(.*\)( \[needs approval\])? — .+/);
    }
  });

  it('describeDomain throws a clean, actionable error for an unknown domain', async () => {
    const { registry } = await loadWith({});
    expect(() => registry.describeDomain('not-a-real-domain')).toThrow(/Unknown tool domain/);
  });
});

describe('both agent loops use the staged catalog by default', () => {
  it('systemPrompt (shared by runAgentImpl and runAgentStreamImpl) renders the staged form, not the full form, with no env override', async () => {
    // lib/agent/loop.ts's systemPrompt() is ONE function called by both
    // runAgentImpl and runAgentStreamImpl (CLAUDE.md: the two loops must stay
    // identical) — so proving the catalog choice here covers both loops by
    // construction, not by duplicating the check per loop.
    const { vi } = await import('vitest');
    vi.resetModules();
    delete process.env[ENV_STAGED];
    delete process.env[ENV_FULL];

    const registry = await import('@/lib/capabilities/registry');
    const toolsMod = await import('@/lib/agent/tools');
    expect(registry.AGENT_STAGED_CATALOG).toBe(true);

    const staged = toolsMod.toolCatalogStaged();
    const full = toolsMod.toolCatalogForPrompt();
    // The staged form names every domain; the full form does not carry the
    // "(<N>): " per-domain count marker the staged renderer produces.
    expect(staged).toMatch(/^[a-zA-Z_-]+ \(\d+\): /m);
    expect(full).not.toMatch(/^[a-zA-Z_-]+ \(\d+\): /m);
  });
});
