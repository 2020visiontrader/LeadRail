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
  },
});
