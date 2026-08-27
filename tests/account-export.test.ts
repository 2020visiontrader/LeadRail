// tests/account-export.test.ts — drift tests for lib/privacy.ts's account
// export (Bug 1: under-inclusive EXPORT_TABLES allow-list; Bug 2:
// over-inclusive on secrets — integration_connections.secret_encrypted was
// exported unredacted).
//
// Both bugs share a shape: a hand-maintained list silently rotted as the
// schema grew. A test that only checks EXPORT_TABLES/SCRUB against
// themselves can't see that — it would pass forever even as tables and
// columns kept being added and missed. So ground truth here is read
// straight off migrations/*.sql on disk (the same schema that produced the
// 88-table / 15-secret-column count this fix was built against), not off
// lib/privacy.ts's own lists. A new account-scoped table or secret-shaped
// column that isn't classified turns one of these tests red — that's the
// point: the allow-list can no longer rot invisibly.
//
// No DB, no network: everything here is static parsing of migration SQL
// plus calls into lib/privacy.ts's exported pure functions.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  EXPORT_TABLES,
  EXPORT_EXCLUDED,
  SCRUB_ALLOW,
  isSecretColumn,
  scrub,
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

const SECRET_COLUMN_PATTERN = /secret|token|api_key|password|credential|key_hash|private|refresh/i;

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

describe('sanity: the migration parser actually found something', () => {
  it('found a substantial number of account-scoped tables', () => {
    // Guards against the parser silently matching nothing (e.g. a migrations
    // dir move) and every real assertion below going green for free.
    expect(ACCOUNT_SCOPED_TABLES.size).toBeGreaterThan(60);
  });

  it('found secret-shaped columns in migrations', () => {
    expect(SECRET_SHAPED_COLUMNS.size).toBeGreaterThan(5);
  });
});

describe('EXPORT_TABLES / EXPORT_EXCLUDED cover every account-scoped table', () => {
  const exportSet = new Set(EXPORT_TABLES);
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

  it('EXPORT_TABLES has no duplicates', () => {
    expect(EXPORT_TABLES.length).toBe(new Set(EXPORT_TABLES).size);
  });
});

describe('the specific compliance gap: assistant chat history is exported', () => {
  it('agent_conversations is in EXPORT_TABLES', () => {
    expect(EXPORT_TABLES).toContain('agent_conversations');
  });

  it('agent_memory is in EXPORT_TABLES', () => {
    expect(EXPORT_TABLES).toContain('agent_memory');
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
