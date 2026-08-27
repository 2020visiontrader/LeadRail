// Schema drift detection.
//
// WHY THIS EXISTS, and it is not hypothetical. Four migrations — 039, 042, 043
// and 044 — sat unapplied against production for weeks. Nothing noticed,
// because nothing checks that the schema the deployed code writes against is
// the schema that is actually there. The symptom, when it finally arrived, was
// a modal saying "Internal error" while the real cause sat in a log line
// nobody was reading: PGRST204, column 'allow_auto' not found.
//
// Every one of those was silently broken the whole time:
//   039  mcp_api_keys missing        — MCP API keys could not be issued at all
//   042  secret_encrypted missing    — social tokens were never stored encrypted
//   043  brand_id missing            — scheduled runs lost their venture grounding
//   044  allow_auto missing          — EVERY attempt to add an MCP server 500'd
//
// A missing column does not announce itself. It waits for someone to press the
// one button that touches it, which for 044 was weeks after the code shipped.
// This turns that into a line on a page an owner already looks at.
//
// WHAT IT CHECKS, and what it deliberately does not. This asserts the presence
// of tables and columns the application CODE depends on — not that every
// migration ran, which is a different and less useful question (a migration
// can be a comment, an index, or a backfill). The list below is therefore
// hand-maintained and load-bearing: when a migration adds something the code
// reads or writes, it belongs here, and the cost of forgetting is exactly the
// six weeks of silence described above.
//
// Types are NOT compared. A column that exists with the wrong type is a real
// problem, but a rarer one than absence, and reading type metadata across
// Postgres's naming (character varying vs text, ARRAY vs _text) produces false
// alarms that teach people to ignore the check. Absence is unambiguous.

import { supabase, dbReady } from '@/lib/db';

interface Expectation {
  table: string;
  /** Columns the code reads or writes. Empty means "the table must exist". */
  columns: string[];
  /** Which migration introduced this, so a failure names its own fix. */
  migration: string;
  /** What breaks when it is missing — written for whoever sees the red line. */
  breaks: string;
}

// Ordered by migration so a run of failures reads as "everything from N is
// missing", which is the usual shape when a deploy skipped a batch.
const EXPECTATIONS: Expectation[] = [
  { table: 'agent_conversations', columns: ['transcript', 'carryover'], migration: '022', breaks: 'the assistant cannot persist or reload a chat' },
  { table: 'skills', columns: ['instructions'], migration: '025', breaks: 'no skill guidance reaches the assistant' },
  { table: 'mcp_clients', columns: ['url', 'transport', 'auth_header_encrypted'], migration: '026', breaks: 'external MCP servers cannot be registered' },
  { table: 'scheduled_tasks', columns: ['last_status'], migration: '027', breaks: 'scheduled runs cannot record an outcome' },
  { table: 'approvals', columns: ['args_hash', 'state'], migration: '028', breaks: 'the approval gate cannot verify a resumed action' },
  { table: 'content_pipeline_runs', columns: ['stages', 'output'], migration: '032', breaks: 'the content pipeline cannot store a run' },
  { table: 'agent_memory', columns: ['embedding'], migration: '036', breaks: 'semantic recall silently degrades to recency-only' },
  { table: 'approvals', columns: ['executed_at'], migration: '037', breaks: 'an approved action could be executed twice' },
  { table: 'ai_models', columns: ['max_output_tokens'], migration: '038', breaks: 'output budgets fall back to a conservative default' },
  { table: 'mcp_api_keys', columns: ['key_hash', 'allow_sensitive'], migration: '039', breaks: 'MCP API keys cannot be issued or verified' },
  { table: 'social_automations', columns: ['daily_cap', 'enabled'], migration: '040', breaks: 'social automation rules cannot be stored' },
  { table: 'integration_connections', columns: ['secret_encrypted'], migration: '042', breaks: 'provider tokens are not stored encrypted' },
  { table: 'scheduled_tasks', columns: ['brand_id'], migration: '043', breaks: 'scheduled runs lose their venture grounding' },
  { table: 'mcp_clients', columns: ['allow_auto'], migration: '044', breaks: 'adding an MCP server fails with an internal error' },
  { table: 'brand_strategies', columns: ['strategy'], migration: '047', breaks: 'brand strategies cannot be saved' },
  { table: 'brand_goals', columns: ['objective', 'success_criterion'], migration: '048', breaks: 'venture goals cannot be tracked' },
  { table: 'content_items', columns: ['status', 'hook', 'body', 'cta', 'platforms'], migration: '050', breaks: 'the content board cannot store a piece' },
  { table: 'content_pillars', columns: ['pain', 'promise'], migration: '050', breaks: 'content has no pillar rotation' },
  { table: 'platform_specs', columns: ['char_limit', 'hashtag_strategy'], migration: '050', breaks: 'generated content is not held to platform limits' },
  { table: 'character_refs', columns: ['image_url', 'description'], migration: '050', breaks: 'a recurring character drifts between generations' },
  { table: 'brands', columns: ['tone_of_voice', 'content_examples'], migration: '050', breaks: 'the generator cannot read the brand voice' },
  { table: 'skills', columns: ['capabilities', 'screen_status'], migration: '051', breaks: 'skills cannot declare tools and screen results are not recorded' },
  { table: 'skill_repairs', columns: ['proposed', 'status'], migration: '051', breaks: 'blocked skills cannot be repaired' },
  { table: 'mcp_clients', columns: ['auth_mode', 'oauth_client_id', 'oauth_access_token_encrypted'], migration: '053', breaks: 'OAuth-protected MCP servers cannot be connected' },
  { table: 'mcp_oauth_states', columns: ['code_verifier', 'expires_at'], migration: '053', breaks: 'the MCP OAuth handshake cannot start' },
  { table: 'brands', columns: ['core_thesis', 'banned_terms', 'thesis_embedding'], migration: '054', breaks: 'content is not held to a brand thesis and drift cannot be scored' },
  { table: 'content_items', columns: ['intent', 'linearity_score'], migration: '054', breaks: 'organic and paid content cannot be told apart, and off-brand copy is not flagged' },
  { table: 'platform_specs', columns: ['aspect_ratios', 'format_family', 'hook_hold_seconds'], migration: '054', breaks: 'the format router cannot tell short-form from static, and safe zones are unknown' },
  { table: 'research_findings', columns: ['pass', 'finding', 'superseded_at'], migration: '055', breaks: 'research is not stored, so every sweep starts from nothing' },
  { table: 'brand_intakes', columns: ['raw_description', 'status'], migration: '055', breaks: 'a brand description cannot be captured, so the front door does not open' },
];

export interface DriftFinding {
  table: string;
  missing: string[];
  /** True when the whole table is absent, not just columns. */
  tableMissing: boolean;
  migration: string;
  breaks: string;
}

export interface SchemaGuardResult {
  ok: boolean;
  checked: number;
  findings: DriftFinding[];
  /** Set when the check itself could not run — never conflated with "no drift". */
  error?: string;
}

/**
 * Compare the live schema against what the code expects.
 *
 * One query, not one per table: this runs from a diagnostics page that an
 * owner may refresh, and twenty round-trips to answer a question this small
 * would make the check itself the slow thing on the page.
 *
 * Never throws. A failure to RUN the check reports `error` and ok:false —
 * deliberately not ok:true, because "I could not look" and "I looked and it
 * was fine" must never render as the same green line.
 */
export async function checkSchemaDrift(): Promise<SchemaGuardResult> {
  if (!dbReady()) {
    return { ok: false, checked: 0, findings: [], error: 'database not configured' };
  }
  try {
    const tables = Array.from(new Set(EXPECTATIONS.map((e) => e.table)));
    // Through an RPC, not a table read: PostgREST does not expose
    // information_schema, so `.from('information_schema.columns')` fails and
    // would look identical to "every table is missing" — the most alarming
    // possible false positive. migration 052 defines the function.
    const { data, error } = await supabase.rpc('schema_columns_for', { p_tables: tables });

    if (error) {
      // Distinguish "the function is not there" from a real failure, because
      // the fix differs: one is a missing migration, the other is an outage.
      const missingFn = /schema_columns_for|does not exist|PGRST202/i.test(error.message || '');
      return {
        ok: false,
        checked: 0,
        findings: [],
        error: missingFn
          ? 'schema introspection unavailable — apply migration 052'
          : `schema introspection failed: ${error.message}`,
      };
    }

    const present = new Map<string, Set<string>>();
    for (const row of (data || []) as { table_name: string; column_name: string }[]) {
      if (!present.has(row.table_name)) present.set(row.table_name, new Set());
      present.get(row.table_name)!.add(row.column_name);
    }

    const findings: DriftFinding[] = [];
    for (const exp of EXPECTATIONS) {
      const cols = present.get(exp.table);
      if (!cols || cols.size === 0) {
        findings.push({ table: exp.table, missing: exp.columns, tableMissing: true, migration: exp.migration, breaks: exp.breaks });
        continue;
      }
      const missing = exp.columns.filter((c) => !cols.has(c));
      if (missing.length) {
        findings.push({ table: exp.table, missing, tableMissing: false, migration: exp.migration, breaks: exp.breaks });
      }
    }

    return { ok: findings.length === 0, checked: EXPECTATIONS.length, findings };
  } catch (e: any) {
    return { ok: false, checked: 0, findings: [], error: String(e?.message || e).slice(0, 300) };
  }
}

/** One-line summary for a diagnostics row. Names the migrations to apply,
 *  because "3 columns missing" sends someone hunting and "apply 043, 044"
 *  does not. */
export function summarizeDrift(result: SchemaGuardResult): string {
  if (result.error) return `could not check: ${result.error}`;
  if (result.ok) return `${result.checked} schema expectations satisfied`;
  const migrations = Array.from(new Set(result.findings.map((f) => f.migration))).sort();
  const worst = result.findings
    .slice(0, 3)
    .map((f) => (f.tableMissing ? `${f.table} (table absent)` : `${f.table}.${f.missing.join('/')}`))
    .join(', ');
  const more = result.findings.length > 3 ? ` +${result.findings.length - 3} more` : '';
  return `DRIFT — apply migration${migrations.length > 1 ? 's' : ''} ${migrations.join(', ')}. Missing: ${worst}${more}`;
}
