// tests/account-export.test.ts — drift tests for lib/privacy.ts's account
// export (Bug 1: under-inclusive EXPORT_TABLES allow-list; Bug 2:
// over-inclusive on secrets — integration_connections.secret_encrypted was
// exported unredacted; Bug 3: sequence_enrollments and referrals have no
// account_id column, so exporting them with a hard-coded `.eq('account_id',
// accountId)` silently wrote `{ error: ... }` into the bundle instead of
// data; Bug 4: approvals.args_encrypted / args_hash aren't shaped like any
// of the older secret-pattern words and shipped unredacted).
//
// These bugs share a shape: a hand-maintained list, or a hard-coded
// assumption, silently rotted as the schema grew. A test that only checks
// EXPORT_TABLES/SCRUB against themselves can't see that — it would pass
// forever even as tables and columns kept being added and missed. So ground
// truth here is read straight off migrations/*.sql on disk, not off
// lib/privacy.ts's own lists. A new account-scoped table, a new secret-shaped
// column, or a declared scope column that doesn't actually exist turns one of
// these tests red — that's the point: the allow-list, and the scoping, can no
// longer rot invisibly.
//
// No real DB, no network: the migration checks are static parsing of SQL, and
// the isolation checks below run exportAccountData() against an in-memory
// fake of the Supabase query builder (see makeExportClient), not a live
// database.

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// --- fake Supabase client for exportAccountData isolation tests -----------
//
// Mocked before importing lib/privacy so the module picks up the fake. Reads
// from a mutable TABLES map each call, so each test can seed its own rows.
// Supports exactly what exportAccountData's three scope kinds use:
// select/eq/or/in/limit, as a thenable (awaited directly, like the real
// supabase-js query builder).

let TABLES: Record<string, any[]> = {};

function makeExportClient() {
  return {
    from(table: string) {
      let rows = TABLES[table] || [];
      let selectCols: string | null = null;
      const builder: any = {
        select(cols: string) {
          selectCols = cols;
          return builder;
        },
        eq(col: string, val: any) {
          rows = rows.filter((r) => r[col] === val);
          return builder;
        },
        or(expr: string) {
          // "col1.eq.val1,col2.eq.val2" — matches if ANY clause matches.
          const clauses = expr.split(',').map((c) => {
            const [col, , ...rest] = c.split('.');
            return { col, val: rest.join('.') };
          });
          rows = rows.filter((r) => clauses.some((cl) => String(r[cl.col]) === cl.val));
          return builder;
        },
        in(col: string, vals: any[]) {
          const set = new Set(vals);
          rows = rows.filter((r) => set.has(r[col]));
          return builder;
        },
        limit() {
          return builder;
        },
        then(resolve: any, reject: any) {
          const data =
            selectCols && selectCols !== '*'
              ? rows.map((r) => {
                  const out: Record<string, any> = {};
                  for (const c of selectCols!.split(',').map((s) => s.trim())) out[c] = r[c];
                  return out;
                })
              : rows;
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

vi.mock('@/lib/db', () => ({ supabase: makeExportClient(), dbReady: () => true }));

import {
  EXPORT_TABLES,
  EXPORT_TABLE_NAMES,
  EXPORT_EXCLUDED,
  SCRUB_ALLOW,
  isSecretColumn,
  scrub,
  exportAccountData,
  type ExportScope,
} from '@/lib/privacy';

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

const migrationFiles = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const migrationsText = migrationFiles
  .map((f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'))
  .join('\n');

// --- Ground truth #1: every table with an account_id column -------------
//
// Independent of lib/privacy.ts. Walks CREATE TABLE bodies (balanced-paren
// extraction, since column lists span many lines) for a top-level
// `account_id` column, plus `ALTER TABLE ... ADD COLUMN account_id` for
// tables that gained it after creation.

function extractBalancedParens(text: string, openParenIdx: number): string {
  let depth = 0;
  for (let i = openParenIdx; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return text.slice(openParenIdx, i + 1);
    }
  }
  return text.slice(openParenIdx);
}

function tablesWithAccountId(sql: string): Set<string> {
  const tables = new Set<string>();
  const createRe = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = createRe.exec(sql))) {
    const table = m[1].toLowerCase();
    const openParenIdx = createRe.lastIndex - 1;
    const body = extractBalancedParens(sql, openParenIdx);
    if (/^\s*account_id\b/m.test(body)) tables.add(table);
  }
  const alterRe = /ALTER TABLE\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+ADD COLUMN(?:\s+IF NOT EXISTS)?\s+account_id\b/gi;
  while ((m = alterRe.exec(sql))) tables.add(m[1].toLowerCase());
  return tables;
}

const ACCOUNT_SCOPED_TABLES = tablesWithAccountId(migrationsText);

// --- Ground truth #2: every column name shaped like a secret -------------
//
// Deliberately re-implemented here rather than imported, so a change to the
// production pattern that narrows it (e.g. someone drops "refresh" from the
// regex) shows up as a real column falling out of coverage rather than the
// test silently agreeing with whatever the code now does.

const SECRET_COLUMN_PATTERN = /secret|token|api_key|password|credential|key_hash|private|refresh|_encrypted|_hash/i;

function secretShapedColumns(sql: string): Set<string> {
  const cols = new Set<string>();
  const createRe = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = createRe.exec(sql))) {
    const openParenIdx = createRe.lastIndex - 1;
    const body = extractBalancedParens(sql, openParenIdx);
    for (const line of body.split('\n')) {
      const colMatch = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s+[A-Za-z]/.exec(line.replace(/,\s*$/, ''));
      if (!colMatch) continue;
      const col = colMatch[1].toLowerCase();
      if (['primary', 'foreign', 'unique', 'check', 'constraint', 'references'].includes(col)) continue;
      if (SECRET_COLUMN_PATTERN.test(col)) cols.add(col);
    }
  }
  const alterColRe = /ALTER TABLE\s+[a-zA-Z_][a-zA-Z0-9_]*\s+ADD COLUMN(?:\s+IF NOT EXISTS)?\s+([a-zA-Z_][a-zA-Z0-9_]*)\b/gi;
  while ((m = alterColRe.exec(sql))) {
    const col = m[1].toLowerCase();
    if (SECRET_COLUMN_PATTERN.test(col)) cols.add(col);
  }
  return cols;
}

const SECRET_SHAPED_COLUMNS = secretShapedColumns(migrationsText);

// --- Ground truth #3: every table's full column set ----------------------
//
// Used to check that a declared ExportScope's column(s) actually exist —
// this is what would have caught sequence_enrollments/referrals being
// scoped by a plain `account_id` that neither table has.

function allTableColumns(sql: string): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const ensure = (t: string) => {
    if (!map.has(t)) map.set(t, new Set());
    return map.get(t)!;
  };
  const createRe = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = createRe.exec(sql))) {
    const table = m[1].toLowerCase();
    const openParenIdx = createRe.lastIndex - 1;
    const body = extractBalancedParens(sql, openParenIdx);
    const cols = ensure(table);
    for (const line of body.split('\n')) {
      const colMatch = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s+[A-Za-z]/.exec(line.replace(/,\s*$/, ''));
      if (!colMatch) continue;
      const col = colMatch[1].toLowerCase();
      if (['primary', 'foreign', 'unique', 'check', 'constraint', 'references'].includes(col)) continue;
      cols.add(col);
    }
  }
  const alterColRe = /ALTER TABLE\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+ADD COLUMN(?:\s+IF NOT EXISTS)?\s+([a-zA-Z_][a-zA-Z0-9_]*)\b/gi;
  while ((m = alterColRe.exec(sql))) {
    ensure(m[1].toLowerCase()).add(m[2].toLowerCase());
  }
  return map;
}

const TABLE_COLUMNS = allTableColumns(migrationsText);

describe('sanity: the migration parser actually found something', () => {
  it('found a substantial number of account-scoped tables', () => {
    // Guards against the parser silently matching nothing (e.g. a migrations
    // dir move) and every real assertion below going green for free.
    expect(ACCOUNT_SCOPED_TABLES.size).toBeGreaterThan(60);
  });

  it('found secret-shaped columns in migrations', () => {
    expect(SECRET_SHAPED_COLUMNS.size).toBeGreaterThan(5);
  });

  it('found columns for a substantial number of tables', () => {
    expect(TABLE_COLUMNS.size).toBeGreaterThan(60);
  });
});

describe('EXPORT_TABLES / EXPORT_EXCLUDED cover every account-scoped table', () => {
  const exportSet = new Set(Object.keys(EXPORT_TABLES));
  const excludedSet = new Set(Object.keys(EXPORT_EXCLUDED));

  it.each([...ACCOUNT_SCOPED_TABLES].sort())(
    '%s is classified as exported or excluded',
    (table) => {
      const inExport = exportSet.has(table);
      const inExcluded = excludedSet.has(table);
      expect(
        inExport || inExcluded,
        `${table} has an account_id column but is in neither EXPORT_TABLES nor EXPORT_EXCLUDED`,
      ).toBe(true);
      expect(
        inExport && inExcluded,
        `${table} is in BOTH EXPORT_TABLES and EXPORT_EXCLUDED`,
      ).toBe(false);
    },
  );

  it('every EXPORT_EXCLUDED entry has a non-empty reason', () => {
    for (const [table, reason] of Object.entries(EXPORT_EXCLUDED)) {
      expect(typeof reason, `${table}'s reason is not a string`).toBe('string');
      expect(reason.trim().length, `${table} has an empty/whitespace-only reason`).toBeGreaterThan(0);
    }
  });

  it('EXPORT_TABLE_NAMES has no duplicates', () => {
    expect(EXPORT_TABLE_NAMES.length).toBe(new Set(EXPORT_TABLE_NAMES).size);
  });
});

// --- Bug 1: every declared scope's column(s) must actually exist ---------
//
// This is the test that would have caught sequence_enrollments and
// referrals being (incorrectly) scoped by a bare `account_id` column that
// neither table has. A scope naming a column absent from the schema now
// fails here instead of shipping a silent `{ error: ... }` in place of a
// table's data.
describe('every EXPORT_TABLES scope names columns that actually exist in the schema', () => {
  it.each(Object.entries(EXPORT_TABLES))('%s', (table, scope: ExportScope) => {
    const cols = TABLE_COLUMNS.get(table);
    expect(cols, `${table} was not found as a CREATE TABLE in migrations`).toBeDefined();

    if (scope.kind === 'column') {
      expect(cols!.has(scope.column), `${table}.${scope.column} does not exist`).toBe(true);
    } else if (scope.kind === 'or') {
      expect(scope.columns.length, `${table}'s 'or' scope lists no columns`).toBeGreaterThan(0);
      for (const c of scope.columns) {
        expect(cols!.has(c), `${table}.${c} does not exist`).toBe(true);
      }
    } else if (scope.kind === 'indirect') {
      expect(cols!.has(scope.localColumn), `${table}.${scope.localColumn} does not exist`).toBe(true);
      const parentCols = TABLE_COLUMNS.get(scope.parentTable);
      expect(parentCols, `${scope.parentTable} (${table}'s indirect parent) was not found in migrations`).toBeDefined();
      expect(
        parentCols!.has(scope.parentColumn),
        `${scope.parentTable}.${scope.parentColumn} does not exist`,
      ).toBe(true);
      expect(
        parentCols!.has(scope.parentScopeColumn),
        `${scope.parentTable}.${scope.parentScopeColumn} does not exist`,
      ).toBe(true);
    } else {
      throw new Error(`${table} has an unrecognized scope kind`);
    }
  });
});

describe('the specific compliance gap: assistant chat history is exported', () => {
  it('agent_conversations is in EXPORT_TABLES', () => {
    expect(Object.keys(EXPORT_TABLES)).toContain('agent_conversations');
  });

  it('agent_memory is in EXPORT_TABLES', () => {
    expect(Object.keys(EXPORT_TABLES)).toContain('agent_memory');
  });
});

describe('secret-shaped columns are all classified', () => {
  it.each([...SECRET_SHAPED_COLUMNS].sort())(
    '%s is either scrubbed by the predicate or explicitly allow-listed',
    (col) => {
      const scrubbed = isSecretColumn(col);
      const allowed = SCRUB_ALLOW.has(col);
      expect(
        scrubbed || allowed,
        `${col} matches the secret pattern but scrub() would pass it through, and it is not in SCRUB_ALLOW`,
      ).toBe(true);
      expect(
        scrubbed && allowed,
        `${col} is both scrubbed and allow-listed — pick one`,
      ).toBe(false);
    },
  );
});

describe('the specific compliance gap: secret_encrypted is redacted', () => {
  it('integration_connections.secret_encrypted is redacted by scrub()', () => {
    const [row] = scrub([{ id: 'x', secret_encrypted: 'ciphertext-abc', provider: 'google' }]);
    expect(row.secret_encrypted).toBe('[redacted]');
    expect(row.provider).toBe('google'); // untouched
  });

  it('other real secret columns found in migrations are redacted', () => {
    const input = {
      api_key_encrypted: 'k1',
      oauth_client_secret_encrypted: 'k2',
      oauth_access_token_encrypted: 'k3',
      oauth_refresh_token_encrypted: 'k4',
      key_hash: 'k5',
    };
    const [row] = scrub([input]);
    for (const k of Object.keys(input)) {
      expect(row[k], `${k} was not redacted`).toBe('[redacted]');
    }
  });
});

// --- Bug 4: approvals.args_encrypted / args_hash ---------------------------
//
// Neither column contains "secret", "token", "password", "api_key",
// "credential", "key_hash", "private", or "refresh" — the older word-based
// pattern missed both. args_redacted is the deliberately-safe form (secret-ish
// keys already redacted by the app before storage) and must survive export
// untouched, or the export loses the only readable copy of what was proposed.
describe('the specific compliance gap: approvals.args_encrypted / args_hash are redacted', () => {
  it('args_encrypted is redacted', () => {
    const [row] = scrub([{ id: 'a1', args_encrypted: 'ciphertext-of-full-args' }]);
    expect(row.args_encrypted).toBe('[redacted]');
  });

  it('args_hash is redacted', () => {
    const [row] = scrub([{ id: 'a1', args_hash: 'sha256-abc123' }]);
    expect(row.args_hash).toBe('[redacted]');
  });

  it('args_redacted is NOT redacted — it is already the safe form', () => {
    const [row] = scrub([{ id: 'a1', args_redacted: { to: 'someone@example.com' } }]);
    expect(row.args_redacted).toEqual({ to: 'someone@example.com' });
  });
});

describe('known false positives pass through scrub() untouched', () => {
  it.each(['token_estimate', 'tokens_in', 'tokens_out', 'max_output_tokens', 'oauth_token_url'])(
    '%s is NOT redacted',
    (col) => {
      const [row] = scrub([{ [col]: 42, other: 'x' }]);
      expect(row[col]).toBe(42);
    },
  );
});

describe('non-secret fields pass through scrub() unchanged', () => {
  it('leaves ordinary columns alone', () => {
    const [row] = scrub([{ id: '1', name: 'Acme', created_at: '2026-01-01' }]);
    expect(row).toEqual({ id: '1', name: 'Acme', created_at: '2026-01-01' });
  });
});

// --- Tenant isolation: each scope kind, seeded with two accounts ----------
//
// Scoping is a tenant-isolation boundary, not a cosmetic filter: getting it
// wrong leaks one account's rows into another account's "download my data"
// export. Each test below seeds account A and account B, exports A, and
// asserts the bundle contains ONLY A's rows for the table under test — for
// every scope kind exportAccountData supports, including the two new ones
// (indirect, or) that Bug 1 was about.

const ACCOUNT_A = 'acct-aaaaaaaa';
const ACCOUNT_B = 'acct-bbbbbbbb';

describe('tenant isolation: default column scope (account_id)', () => {
  it('A export contains only A rows, never B rows', async () => {
    TABLES = {
      contacts: [
        { id: 'c1', account_id: ACCOUNT_A, name: 'A contact' },
        { id: 'c2', account_id: ACCOUNT_B, name: 'B contact' },
      ],
    };
    const bundle = await exportAccountData(ACCOUNT_A);
    expect(bundle.contacts).toEqual([{ id: 'c1', account_id: ACCOUNT_A, name: 'A contact' }]);
  });
});

describe('tenant isolation: alternate column scope (accounts -> id)', () => {
  it('A export contains only the A account row', async () => {
    TABLES = {
      accounts: [
        { id: ACCOUNT_A, name: 'Account A' },
        { id: ACCOUNT_B, name: 'Account B' },
      ],
    };
    const bundle = await exportAccountData(ACCOUNT_A);
    expect(bundle.accounts).toEqual([{ id: ACCOUNT_A, name: 'Account A' }]);
  });
});

describe('tenant isolation: OR scope across two account columns (referrals)', () => {
  it('A export includes rows where EITHER referral column is A, and no B-only row', async () => {
    TABLES = {
      referrals: [
        { id: 'r1', referrer_account_id: ACCOUNT_A, referred_account_id: null, status: 'pending' },
        { id: 'r2', referrer_account_id: null, referred_account_id: ACCOUNT_A, status: 'qualified' },
        // Belongs entirely to B on both columns — must NOT appear in A's export.
        { id: 'r3', referrer_account_id: ACCOUNT_B, referred_account_id: ACCOUNT_B, status: 'pending' },
        // Referred B via a code A issued — appears in B's export (referred_account_id=B),
        // not in A's, since referrer_account_id here is B too.
        { id: 'r4', referrer_account_id: ACCOUNT_B, referred_account_id: null, status: 'pending' },
      ],
    };
    const bundle = await exportAccountData(ACCOUNT_A);
    const ids = (bundle.referrals as any[]).map((r) => r.id).sort();
    expect(ids).toEqual(['r1', 'r2']);
  });

  it('B export includes its own rows and none of A-only row r1/r2', async () => {
    const bundle = await exportAccountData(ACCOUNT_B);
    const ids = (bundle.referrals as any[]).map((r) => r.id).sort();
    expect(ids).toEqual(['r3', 'r4']);
  });
});

describe('tenant isolation: indirect scope through a parent table (sequence_enrollments)', () => {
  it('A export includes only enrollments whose sequence belongs to A', async () => {
    TABLES = {
      sequences: [
        { id: 'seq-a', account_id: ACCOUNT_A, name: 'A sequence' },
        { id: 'seq-b', account_id: ACCOUNT_B, name: 'B sequence' },
      ],
      sequence_enrollments: [
        { id: 'e1', sequence_id: 'seq-a', contact_id: 'c1', status: 'active' },
        { id: 'e2', sequence_id: 'seq-b', contact_id: 'c2', status: 'active' },
      ],
    };
    const bundle = await exportAccountData(ACCOUNT_A);
    expect(bundle.sequence_enrollments).toEqual([
      { id: 'e1', sequence_id: 'seq-a', contact_id: 'c1', status: 'active' },
    ]);
  });

  it('an account with no sequences gets [] for sequence_enrollments, not an error and not every row', async () => {
    TABLES = {
      sequences: [{ id: 'seq-b', account_id: ACCOUNT_B, name: 'B sequence' }],
      sequence_enrollments: [{ id: 'e2', sequence_id: 'seq-b', contact_id: 'c2', status: 'active' }],
    };
    const bundle = await exportAccountData(ACCOUNT_A);
    expect(bundle.sequence_enrollments).toEqual([]);
  });
});
