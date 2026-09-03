// tests/parity.test.ts — Packet 2.3: API = MCP parity.
//
// Packet 2.1 made ONE capability registry feed four surfaces: the chat loop's
// prompt catalog, the MCP server's tools/list, the approval gate, and the audit
// trail. That consolidation is only worth anything for as long as the surfaces
// stay in step.
//
// They have not, historically. Packet 0.3 found the MCP server calling runTool()
// with no sensitivity check and no rate limit — the very tools the chat loop put
// behind an approval card were freely callable over MCP by anyone holding one
// shared static secret. Nothing caught it; someone eventually read the file.
//
// This file is the standing guarantee that the same class of drift cannot recur
// unnoticed. It asserts over STATIC registry data only: no DB, no network, no
// credentials, no fixtures on disk. The only environment it touches is the
// AGENT_FULL_CATALOG flag, which it sets itself (see "Both flag modes" below).
//
// Both flag modes
// ---------------
// Packet 10.3 added the two-stage catalog behind AGENT_STAGED_CATALOG. C6
// (2026-09-03) flipped the default so staging is now ON unless
// AGENT_FULL_CATALOG=1 restores the old shape — AGENT_STAGED_CATALOG is no
// longer read from the environment at all; it's derived in
// lib/capabilities/registry.ts as `!AGENT_FULL_CATALOG`. The flag still
// changes registry MEMBERSHIP the same way it always did: with full-catalog
// mode active `describeTools` is filtered out of both ALL and CATALOG_ORDER;
// with staging active (the default) the capability is an ordinary registry
// member and appears in MCP tools/list. Parity must hold in both. Rather than
// assert one mode and argue the other follows, each mode is loaded into a
// fresh module graph (vi.resetModules() + dynamic import) and the full
// assertion set runs against both.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Capability } from '@/lib/capabilities/types';

const ENV_KEY = 'AGENT_FULL_CATALOG';
const ORIGINAL_FLAG = process.env[ENV_KEY];

interface Surfaces {
  capabilities: Capability[];
  capabilityByName: Record<string, Capability>;
  tools: Record<string, { title: string; description: string; inputSchema: any; zod: any; sensitive?: boolean }>;
  specs: { name: string; description: string; inputSchema: any }[];
  promptCatalog: string;
  stagedCatalog: string;
  domains: string[];
  describeDomain: (d: string) => { domain: string; count: number; tools: string[] };
  isSensitive: (c: Capability) => boolean;
  sensitiveGates: string[];
  stagedFlag: boolean;
}

/** Load the registry AND its adapter in a fresh module graph under a given flag
 *  value. Both must come from the same graph — importing one fresh and reading
 *  the other from cache would compare two different registries and pass
 *  vacuously. */
async function loadSurfaces(staged: boolean): Promise<Surfaces> {
  vi.resetModules();
  // staged mode is now the default: it's active whenever AGENT_FULL_CATALOG
  // is unset, and full-catalog mode requires setting it to '1'.
  if (staged) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = '1';

  const registry = await import('@/lib/capabilities/registry');
  const tools = await import('@/lib/agent/tools');
  const types = await import('@/lib/capabilities/types');

  return {
    capabilities: registry.CAPABILITIES,
    capabilityByName: registry.CAPABILITY_BY_NAME,
    tools: tools.TOOLS as any,
    specs: tools.toolSpecs(),
    promptCatalog: tools.toolCatalogForPrompt(),
    stagedCatalog: tools.toolCatalogStaged(),
    domains: registry.capabilityDomains(),
    describeDomain: registry.describeDomain,
    isSensitive: types.isSensitive,
    sensitiveGates: types.SENSITIVE_GATES as unknown as string[],
    stagedFlag: registry.AGENT_STAGED_CATALOG,
  };
}

/** Capability names as they appear in the chat prompt catalog: one line per
 *  tool, `name(args) [needs approval] — description`. */
function namesFromPromptCatalog(text: string): string[] {
  return text.split('\n').filter(Boolean).map((line) => {
    const m = /^([A-Za-z0-9_]+)\(/.exec(line);
    if (!m) throw new Error(`Unparseable prompt catalog line: ${line}`);
    return m[1];
  });
}

/** Capability names as they appear in the stage-1 staged catalog: one line per
 *  domain, `domain (n): nameA [needs approval], nameB`. */
function namesFromStagedCatalog(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n').filter(Boolean)) {
    const idx = line.indexOf('): ');
    if (idx === -1) throw new Error(`Unparseable staged catalog line: ${line}`);
    for (const entry of line.slice(idx + 3).split(', ')) {
      const m = /^([A-Za-z0-9_]+)/.exec(entry.trim());
      if (!m) throw new Error(`Unparseable staged catalog entry: ${entry}`);
      out.push(m[1]);
    }
  }
  return out;
}

/** A JSON value satisfying a JSON-Schema node's declared TYPE. Deliberately
 *  type-level only — it is used to probe which KEYS each side demands, not to
 *  satisfy value-level constraints (url format, enums, min length), which the
 *  two schemas are not required to state identically. */
function sampleForType(schema: any): any {
  if (Array.isArray(schema?.enum) && schema.enum.length) return schema.enum[0];
  switch (schema?.type) {
    case 'number':
    case 'integer': return 1;
    case 'boolean': return true;
    case 'array': return schema.items ? [sampleForType(schema.items)] : [];
    case 'object': {
      const o: Record<string, any> = {};
      for (const k of (schema.required || [])) o[k] = sampleForType(schema.properties?.[k] ?? { type: 'string' });
      return o;
    }
    default: return 'x';
  }
}

afterAll(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_FLAG;
});

for (const staged of [false, true]) {
  describe(`API=MCP parity — ${ENV_KEY}=${staged ? 'unset' : "'1'"} (staged=${staged})`, () => {
    let S: Surfaces;
    beforeAll(async () => { S = await loadSurfaces(staged); });

    it('loads the registry in the flag mode under test', () => {
      // Guards the whole file: if resetModules/dynamic-import ever stopped
      // re-evaluating the registry, every assertion below would silently be
      // testing one mode twice.
      expect(S.stagedFlag).toBe(staged);
      expect(S.capabilities.length).toBeGreaterThan(0);
    });

    // --- 1. The two front doors expose the SAME set of names -----------------

    it('every capability appears in MCP tools/list', () => {
      const exposed = new Set(S.specs.map((s) => s.name));
      const missing = S.capabilities.map((c) => c.name).filter((n) => !exposed.has(n));
      expect(missing).toEqual([]);
    });

    it('no MCP tool exists that is not a registered capability', () => {
      const registered = new Set(S.capabilities.map((c) => c.name));
      const orphans = S.specs.map((s) => s.name).filter((n) => !registered.has(n));
      expect(orphans).toEqual([]);
    });

    it('the MCP surface and the chat surface list identical names, in identical order', () => {
      // Order matters as well as membership: toolCatalogForPrompt() renders in
      // CATALOG_ORDER and the model's routing accuracy is sensitive to it
      // (see the CATALOG ORDER note in lib/capabilities/registry.ts).
      const registryNames = S.capabilities.map((c) => c.name);
      expect(S.specs.map((s) => s.name)).toEqual(registryNames);
      expect(namesFromPromptCatalog(S.promptCatalog)).toEqual(registryNames);
    });

    it('the staged catalog covers exactly the same names', () => {
      // Stage 1 is what the routing pass sees when the flag is on. A capability
      // absent here is invisible to the model even though MCP will happily run
      // it — the same asymmetry Packet 0.3 found, in the other direction.
      expect(namesFromStagedCatalog(S.stagedCatalog).sort()).toEqual(
        S.capabilities.map((c) => c.name).sort(),
      );
    });

    it('every capability is reachable through CAPABILITY_BY_NAME and its domain', () => {
      for (const c of S.capabilities) {
        expect(S.capabilityByName[c.name]).toBeDefined();
        expect(S.domains).toContain(c.domain);
        expect(S.describeDomain(c.domain).tools.some((line) => line.startsWith(`${c.name}(`))).toBe(true);
      }
    });

    // --- 2. Names ------------------------------------------------------------

    it('capability names are unique and camelCase', () => {
      const names = S.capabilities.map((c) => c.name);
      expect(new Set(names).size).toBe(names.length);
      expect(names.filter((n) => !/^[a-z][A-Za-z0-9]*$/.test(n))).toEqual([]);
    });

    // --- 3. The sensitivity classification is the SAME on both sides ---------

    it('sensitive classification matches on both sides for every name', () => {
      // app/api/mcp/route.ts gates on `TOOLS[name]?.sensitive` — the identical
      // flag lib/agent/loop.ts reads. Compared strictly against === true, not
      // truthiness: a capability whose flag went `undefined` would slip through
      // the MCP route's `if (def?.sensitive && ...)` with no approval and no
      // audit row, which is exactly the 0.3 bug.
      const drift: string[] = [];
      for (const c of S.capabilities) {
        const expected = S.sensitiveGates.includes(c.gate);
        expect(S.isSensitive(c)).toBe(expected);
        const flag = S.tools[c.name]?.sensitive;
        if (flag !== expected) drift.push(`${c.name} (gate=${c.gate}): registry=${expected} TOOLS.sensitive=${String(flag)}`);
      }
      expect(drift).toEqual([]);
    });

    it('every sensitive capability carries the approval marker in both catalogs', () => {
      // The marker is a safety property, not formatting: without it the model
      // plans around a gate it cannot see and proposes sensitive actions
      // believing they run immediately.
      const promptLines = new Map(
        S.promptCatalog.split('\n').filter(Boolean).map((l) => [/^([A-Za-z0-9_]+)\(/.exec(l)![1], l]),
      );
      const stagedEntries = new Map<string, string>();
      for (const line of S.stagedCatalog.split('\n').filter(Boolean)) {
        for (const entry of line.slice(line.indexOf('): ') + 3).split(', ')) {
          stagedEntries.set(/^([A-Za-z0-9_]+)/.exec(entry.trim())![1], entry.trim());
        }
      }
      for (const c of S.capabilities) {
        const marked = S.isSensitive(c);
        expect(promptLines.get(c.name)!.includes('[needs approval]')).toBe(marked);
        expect(stagedEntries.get(c.name)!.includes('[needs approval]')).toBe(marked);
      }
    });

    // --- 4. The two schema declarations agree on required keys ---------------

    it('inputSchema and zod agree on which keys are required', () => {
      // MCP clients are handed inputSchema; runTool() validates with zod. If they
      // disagree, an MCP caller builds a call the JSON Schema says is complete
      // and gets an "Invalid arguments" error it has no way to anticipate — or
      // worse, omits a key the JSON Schema failed to mark required.
      //
      // Type-level fixtures only (see sampleForType): this asserts key agreement,
      // not value agreement.
      const drift: string[] = [];
      for (const c of S.capabilities) {
        const required = (c.inputSchema.required || []) as string[];
        const properties = c.inputSchema.properties || {};

        for (const r of required) {
          if (!(r in properties)) drift.push(`${c.name}: required key "${r}" is not in properties`);
        }

        // No required keys <=> an empty argument object is acceptable.
        const emptyOk = c.zod.safeParse({}).success;
        if (emptyOk !== (required.length === 0)) {
          drift.push(`${c.name}: inputSchema.required=[${required.join(', ')}] but zod ${emptyOk ? 'accepts' : 'rejects'} {}`);
        }

        // Each individually required key really is demanded by zod too.
        const full: Record<string, any> = {};
        for (const r of required) full[r] = sampleForType(properties[r]);
        for (const r of required) {
          const partial = { ...full };
          delete partial[r];
          if (c.zod.safeParse(partial).success) {
            drift.push(`${c.name}: inputSchema requires "${r}" but zod accepts args without it`);
          }
        }
      }
      expect(drift).toEqual([]);
    });

    // --- 5. CATALOG_ORDER covers every capability ----------------------------

    it('CATALOG_ORDER covers every capability, with no unknown entries', () => {
      // The registry throws at import time on either failure, so reaching this
      // point already proves it. Assert the resulting GUARANTEE rather than
      // re-deriving the check: CAPABILITIES is built by mapping CATALOG_ORDER,
      // so it is exactly as long as the registry is wide, holds no duplicates,
      // and every entry resolved to a real capability.
      const names = S.capabilities.map((c) => c.name);
      expect(names.filter(Boolean).length).toBe(names.length);
      expect(new Set(names).size).toBe(names.length);
      for (const c of S.capabilities) {
        expect(typeof c.run).toBe('function');
        expect(c.inputSchema).toBeTruthy();
        expect(c.zod).toBeTruthy();
      }
    });
  });
}

// --- 6. Cross-mode: the flag changes membership and NOTHING else ------------

describe('the staged/full-catalog flag changes registry membership only by the staged-only set', () => {
  let off: Surfaces;
  let on: Surfaces;
  beforeAll(async () => {
    off = await loadSurfaces(false);
    on = await loadSurfaces(true);
  });

  it('staging adds exactly describeTools, and removes nothing', () => {
    const offNames = off.capabilities.map((c) => c.name);
    const onNames = on.capabilities.map((c) => c.name);
    expect(onNames.filter((n) => !offNames.includes(n))).toEqual(['describeTools']);
    expect(offNames.filter((n) => !onNames.includes(n))).toEqual([]);
  });

  it('the staged-only capability reaches MCP tools/list only when staging is on', () => {
    // Not cosmetic: a capability in the registry is callable through
    // app/api/mcp/route.ts. Flag-off it must be absent from tools/list AND from
    // TOOLS, or it is reachable over MCP while invisible to the chat loop.
    expect(off.specs.map((s) => s.name)).not.toContain('describeTools');
    expect(off.tools.describeTools).toBeUndefined();
    expect(on.specs.map((s) => s.name)).toContain('describeTools');
    expect(on.tools.describeTools).toBeDefined();
  });

  it('the shared capabilities keep identical order and identical gates across modes', () => {
    const offNames = off.capabilities.map((c) => c.name);
    expect(on.capabilities.map((c) => c.name).filter((n) => n !== 'describeTools')).toEqual(offNames);
    for (const c of off.capabilities) {
      expect(on.capabilityByName[c.name].gate).toBe(c.gate);
      expect(on.tools[c.name].sensitive).toBe(off.tools[c.name].sensitive);
    }
  });
});
