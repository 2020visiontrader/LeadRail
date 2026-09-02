import { defineConfig } from 'vitest/config';
import path from 'path';

// Minimal vitest setup (Packet 2.3). It exists to run the API=MCP parity check,
// which asserts over static registry data only — no DB, no network, no
// credentials, no environment beyond the AGENT_STAGED_CATALOG flag the test sets
// itself.
//
// The Playwright e2e suite (tests/e2e/*.spec.ts, driven by playwright.config.ts)
// is EXCLUDED here: vitest's default include would otherwise collect those specs
// and fail on Playwright's own test API. `npm run test:e2e` is untouched.

const root = __dirname;

export default defineConfig({
  // JSX in .tsx source (e.g. src/components/*.tsx) needs a runtime here the
  // same way Next's own SWC compiler provides one at build time — tsconfig's
  // "jsx": "preserve" is FOR that build-time compiler, not for vitest's
  // esbuild transform, which otherwise leaves raw JSX calling a global
  // `React` that was never imported ("React is not defined"). Only matters
  // for the one DOM test file (tests/message-actions-dom.test.ts) that
  // imports and renders a real .tsx component; every other test here is
  // plain .ts and unaffected.
  esbuild: { jsx: 'automatic' },
  resolve: {
    // Mirrors tsconfig "paths": "@/*" -> ["./src/*", "./*"]. Only @/components
    // lives under src/; everything else resolves at the repo root.
    alias: [
      { find: /^@\/components(.*)$/, replacement: path.resolve(root, 'src/components$1') },
      { find: /^@\/(.*)$/, replacement: path.resolve(root, '$1') },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'tests/e2e/**', '.next/**'],
    environment: 'node',
    hookTimeout: 30000,
    // The registry-backed suites (parity, regressions, capability-contract)
    // spend ~20-30s in module COLLECTION — they load 443 skills and 108
    // capabilities. Under CPU contention (a concurrent `npm run build`, or CI)
    // that pushes individual tests past vitest's 5s default and the run goes red
    // with nothing actually broken.
    //
    // A suite that fails under load is worse than a slow one: it teaches
    // everyone to re-run instead of read, and a real failure then looks like the
    // flake they have learned to ignore.
    testTimeout: 30000,
  },
});
