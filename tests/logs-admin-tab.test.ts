// tests/logs-admin-tab.test.ts
//
// /logs used to be a plain 'use client' page with NO role guard of its own —
// reachable by any signed-in user, hidden only by a nav link that was itself
// gated on role === 'owner' and by /api/logs 403ing once the (already
// rendered) page tried to fetch. It is now a tab inside the Admin console
// (src/components/admin/LogsPanel.tsx, rendered from app/admin/page.tsx),
// which early-returns before rendering anything for a non-owner.
//
// These tests are STRUCTURAL: they assert the nav no longer offers a direct
// route to a standalone Logs page, and that the Admin console's tab list
// carries a `logs` entry. They do NOT assert that unauthorized users cannot
// read log rows — that property is enforced entirely by /api/logs (owner OR
// admin, account-scoped), which this change does not touch. A test here
// claiming otherwise would be misleading: nothing in AppShell.tsx or
// app/admin/page.tsx is the access-control boundary for the data itself.
//
// Parsed rather than imported/rendered, matching tests/public-routes.test.ts:
// there is no jsdom/testing-library environment configured (vitest.config.ts
// runs environment: 'node'), and these are 'use client' components with no
// server-renderable default export suitable for a plain node import.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const appShellSrc = readFileSync(join(process.cwd(), 'src/components/AppShell.tsx'), 'utf8');
const adminSrc = readFileSync(join(process.cwd(), 'app/admin/page.tsx'), 'utf8');

function block(src: string, constName: string): string {
  // Matches e.g. `const OWNER_NAV: NavItem[] = [ ... ];` — non-greedy up to
  // the first closing `];`, same technique tests/public-routes.test.ts uses.
  const m = src.match(new RegExp(`const ${constName}[^=]*=\\s*\\[([\\s\\S]*?)\\];`));
  if (!m) throw new Error(`${constName} not found`);
  return m[1];
}

describe('the primary nav no longer links directly to a standalone Logs page', () => {
  const ownerNav = block(appShellSrc, 'OWNER_NAV');

  it('OWNER_NAV does not contain /logs', () => {
    expect(ownerNav).not.toMatch(/'\/logs'/);
  });

  it('OWNER_NAV still contains /admin (Logs is reached from inside it now)', () => {
    expect(ownerNav).toMatch(/'\/admin'/);
  });

  it('ALL_ITEMS is still built by spreading OWNER_NAV, so it inherits the removal', () => {
    // Guards against someone reintroducing a /logs entry via a second,
    // independent list instead of OWNER_NAV.
    expect(appShellSrc).toMatch(/ALL_ITEMS[\s\S]*?OWNER_NAV/);
  });

  it('nothing else in AppShell.tsx references the retired /logs route', () => {
    expect(appShellSrc).not.toMatch(/href:\s*'\/logs'/);
  });
});

describe('the Admin console has a Logs tab', () => {
  it("app/admin/page.tsx declares a tab with id 'logs'", () => {
    expect(adminSrc).toMatch(/id:\s*'logs'/);
  });

  it("the Admin 'Full logs' shortcut switches tabs instead of navigating to /logs", () => {
    // Regression guard for the old `<Link href="/logs">` inside the activity
    // tab's actions — it should now just flip `active` within the same console.
    expect(adminSrc).not.toMatch(/href="\/logs"/);
    expect(adminSrc).toMatch(/setActive\('logs'\)/);
  });
});

describe('an unknown ?tab= value falls back to the default tab', () => {
  // TAB_IDS / DEFAULT_TAB are extracted from the real source so this test
  // tracks the actual list rather than a hand-copied one going stale.
  const tabIdsMatch = adminSrc.match(/const TAB_IDS = \[([^\]]*)\]/);
  const defaultTabMatch = adminSrc.match(/const DEFAULT_TAB = '([^']+)'/);
  if (!tabIdsMatch || !defaultTabMatch) throw new Error('TAB_IDS/DEFAULT_TAB not found in app/admin/page.tsx');
  const TAB_IDS = [...tabIdsMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const DEFAULT_TAB = defaultTabMatch[1];

  // Reimplements the effect's resolution rule exactly:
  //   const tab = q.get('tab');
  //   if (tab && TAB_IDS.includes(tab)) setActive(tab);
  // i.e. `active` only ever changes away from its initial DEFAULT_TAB state
  // when the incoming value is a known tab id.
  function resolveTab(queryTabValue: string | null): string {
    if (queryTabValue && (TAB_IDS as readonly string[]).includes(queryTabValue)) return queryTabValue;
    return DEFAULT_TAB;
  }

  it('a known tab id (logs) is honored', () => {
    expect(resolveTab('logs')).toBe('logs');
  });

  it('an unknown tab id falls back to the default tab, not an empty console', () => {
    expect(resolveTab('nonexistent-tab')).toBe(DEFAULT_TAB);
    expect(TAB_IDS).not.toContain('nonexistent-tab');
  });

  it('an absent ?tab= falls back to the default tab', () => {
    expect(resolveTab(null)).toBe(DEFAULT_TAB);
  });

  it('DEFAULT_TAB is itself one of the valid tab ids', () => {
    expect(TAB_IDS).toContain(DEFAULT_TAB);
  });

  it('logs is a valid tab id', () => {
    expect(TAB_IDS).toContain('logs');
  });
});
