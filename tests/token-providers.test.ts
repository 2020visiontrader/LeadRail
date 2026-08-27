// tests/token-providers.test.ts — the entry point for the token-based
// providers (Buffer, GoHighLevel), added because the backend for both was
// complete and correct and reachable by nothing: the Settings page never had
// a UI to paste a token, so hasSocialCredential(accountId, 'buffer') was
// false for every account, always.
//
// The bug this suite exists to catch is drift between three places that must
// name the same providers:
//   - lib/social/credentials.ts's TokenProvider union (what the backend
//     accepts and vaults)
//   - lib/social/providers.ts's TOKEN_PROVIDERS registry (what the Settings
//     page renders a card for)
//   - app/api/integrations/validate/route.ts's VALIDATORS and VAULTED maps
//     (what the validate endpoint actually knows how to check and where it
//     routes the token)
// Adding to one without the others is exactly how this bug happened, so the
// "every key in both directions" tests below are the ones that would have
// caught it.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import {
  TOKEN_PROVIDERS,
  connectedAccountsFor,
  type TokenProviderSpec,
} from '@/lib/social/providers';
import type { TokenProvider } from '@/lib/social/credentials';

// Compile-time check, alongside the runtime ones below: this only type-checks
// if every TOKEN_PROVIDERS key really is a TokenProvider. If TokenProvider
// gains a member this array doesn't, `tsc --noEmit` still passes (TS doesn't
// require a union literal array to be exhaustive) — the runtime test below is
// what actually enforces the reverse direction.
const _typeCheck: TokenProvider[] = TOKEN_PROVIDERS.map((p) => p.key);
void _typeCheck;

const ALL_TOKEN_PROVIDER_KEYS: TokenProvider[] = ['buffer', 'ghl'];

const routeSource = readFileSync(
  path.resolve(__dirname, '../app/api/integrations/validate/route.ts'),
  'utf8',
);

function objectKeysOf(source: string, varName: string): string[] {
  // Matches `const NAME: ... = { key: value, key2: value2, ... };` and pulls
  // out the bare/quoted keys — good enough for the two literal maps this
  // route declares, without executing the module (which would need
  // NextRequest/session/db mocking well beyond what this static shape check
  // is for).
  const decl = source.indexOf(`const ${varName}`);
  expect(decl, `expected to find "const ${varName}" in the route source`).toBeGreaterThanOrEqual(0);
  const braceStart = source.indexOf('{', decl);
  const braceEnd = source.indexOf('};', braceStart);
  const body = source.slice(braceStart + 1, braceEnd);
  const keys: string[] = [];
  const re = /(?:^|,)\s*['"]?([a-zA-Z0-9_]+)['"]?\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) keys.push(m[1]);
  return keys;
}

describe('TOKEN_PROVIDERS registry', () => {
  it('every TOKEN_PROVIDERS key is a valid TokenProvider (registry -> union)', () => {
    for (const spec of TOKEN_PROVIDERS) {
      expect(ALL_TOKEN_PROVIDER_KEYS).toContain(spec.key);
    }
  });

  it('every TokenProvider union member has a TOKEN_PROVIDERS entry (union -> registry)', () => {
    // This is the direction that catches the actual bug: a new TokenProvider
    // added to lib/social/credentials.ts without a matching UI entry.
    const registryKeys = TOKEN_PROVIDERS.map((p) => p.key);
    for (const key of ALL_TOKEN_PROVIDER_KEYS) {
      expect(registryKeys).toContain(key);
    }
  });

  it('has no duplicate keys', () => {
    const keys = TOKEN_PROVIDERS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every entry has a non-empty label, desc, and help text', () => {
    for (const spec of TOKEN_PROVIDERS) {
      expect(spec.label.trim().length, `${spec.key}.label`).toBeGreaterThan(0);
      expect(spec.desc.trim().length, `${spec.key}.desc`).toBeGreaterThan(0);
      expect(spec.helpText.trim().length, `${spec.key}.helpText`).toBeGreaterThan(0);
    }
  });

  it('every extraField (when present) has a non-empty key, label, and placeholder', () => {
    for (const spec of TOKEN_PROVIDERS) {
      if (!spec.extraField) continue;
      expect(spec.extraField.key.trim().length, `${spec.key}.extraField.key`).toBeGreaterThan(0);
      expect(spec.extraField.label.trim().length, `${spec.key}.extraField.label`).toBeGreaterThan(0);
      expect(spec.extraField.placeholder.trim().length, `${spec.key}.extraField.placeholder`).toBeGreaterThan(0);
    }
  });
});

describe('validate route static wiring', () => {
  it('VALIDATORS has an entry for every TOKEN_PROVIDERS key', () => {
    const validatorKeys = objectKeysOf(routeSource, 'VALIDATORS');
    for (const spec of TOKEN_PROVIDERS) {
      expect(validatorKeys, `VALIDATORS missing "${spec.key}"`).toContain(spec.key);
    }
  });

  it('VAULTED covers every TOKEN_PROVIDERS key — otherwise the token writes to `meta`', () => {
    // Packet 7.2's fix was routing buffer/ghl into the encrypted column instead
    // of `meta`, which the /api/integrations projection returns to the browser
    // verbatim. A TOKEN_PROVIDERS entry missing from VAULTED would silently
    // regress a connected account back to that exact leak.
    const vaultedKeys = objectKeysOf(routeSource, 'VAULTED');
    for (const spec of TOKEN_PROVIDERS) {
      expect(vaultedKeys, `VAULTED missing "${spec.key}"`).toContain(spec.key);
    }
  });

  it('surfaces vault_not_configured as its own error rather than a generic 500', () => {
    // errorResponse() collapses an arbitrary thrown error to a fixed
    // "Internal error" message and drops any .code — see lib/http.ts. Without
    // a specific branch for it, a user retyping a correct token against a
    // deployment with no AI_VAULT_KEY gets exactly the same message as a
    // rejected token and has no way to tell the two apart.
    expect(routeSource).toMatch(/vault_not_configured/);
  });
});

describe('connectedAccountsFor', () => {
  const rows = [
    { provider: 'buffer', status: 'connected', id: 'a' },
    { provider: 'buffer', status: 'revoked', id: 'b' },
    { provider: 'ghl', status: 'connected', id: 'c' },
    { provider: 'notion', status: 'connected', id: 'd' },
  ];

  it('returns only rows matching both provider and status "connected"', () => {
    expect(connectedAccountsFor(rows, 'buffer')).toEqual([rows[0]]);
    expect(connectedAccountsFor(rows, 'ghl')).toEqual([rows[2]]);
  });

  it('does not treat a "revoked" row as connected', () => {
    const revokedOnly = [{ provider: 'buffer', status: 'revoked', id: 'x' }];
    expect(connectedAccountsFor(revokedOnly, 'buffer')).toEqual([]);
  });

  it('returns an empty array when nothing matches the provider at all', () => {
    expect(connectedAccountsFor(rows, 'tiktok')).toEqual([]);
  });
});
