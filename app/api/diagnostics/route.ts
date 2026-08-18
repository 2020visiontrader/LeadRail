import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse } from '@/lib/http';
import { supabase, dbReady } from '@/lib/db';
import { validateEnv } from '@/lib/integrations/env';

export const dynamic = 'force-dynamic';

const PROBE_TIMEOUT_MS = 5000;

interface CheckResult {
  name: string;
  status: 'ok' | 'error';
  detail: string;
}

// Bounded DB check: a fast count against `accounts`, aborted after
// PROBE_TIMEOUT_MS so a stalled connection can never hang the response.
// try/caught end to end — a failure marks this ONE row 'error', never 500s
// the whole response.
async function checkDb(): Promise<CheckResult> {
  if (!dbReady()) return { name: 'database', status: 'error', detail: 'Supabase env not configured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const { error, count } = await supabase
      .from('accounts')
      .select('id', { count: 'exact', head: true })
      .abortSignal(controller.signal);
    if (error) throw error;
    return { name: 'database', status: 'ok', detail: `reachable (${count ?? 0} account rows)` };
  } catch (e: any) {
    return { name: 'database', status: 'error', detail: String(e?.message || e).slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

// GET /api/diagnostics — bounded, read-only snapshot for the operator.
// Every probe is individually try/caught; env VALUES are never exposed, only
// presence booleans.
async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const checks: CheckResult[] = [];

  // 1) DB reachability.
  checks.push(await checkDb());

  // 2) Env presence (keys only — values never leave the server).
  let envPresence: { key: string; present: boolean }[] = [];
  try {
    const env = validateEnv();
    envPresence = Object.keys(env).map((key) => ({ key, present: Boolean((env as Record<string, any>)[key]) }));
    checks.push({ name: 'env', status: 'ok', detail: `${envPresence.filter((e) => e.present).length}/${envPresence.length} keys present` });
  } catch (e: any) {
    checks.push({ name: 'env', status: 'error', detail: String(e?.message || e).slice(0, 300) });
  }

  // 3) Cheap per-table counts, account-scoped where the table has an
  // account_id column, each independently bounded + try/caught.
  const tables = ['ai_providers', 'personas', 'account_skills', 'mcp_clients', 'scheduled_tasks'] as const;
  const counts: Record<string, number | null> = {};
  if (dbReady()) {
    await Promise.all(
      tables.map(async (table) => {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
          try {
            // Count with '*', not 'id'. Not every table in this list HAS an id
            // column — account_skills is keyed on (account_id, skill_id) — so
            // selecting 'id' errored there and the probe reported the table as
            // failing. That false alarm read as "the skills subsystem is broken"
            // when the table was fine and simply empty. head+exact means no rows
            // are transferred either way, so '*' costs nothing.
            const { error: countErr, count } = await supabase
              .from(table)
              .select('*', { count: 'exact', head: true })
              .eq('account_id', session.accountId)
              .abortSignal(controller.signal);
            if (countErr) throw countErr;
            counts[table] = count ?? 0;
          } finally {
            clearTimeout(timer);
          }
        } catch {
          counts[table] = null;
        }
      }),
    );
    const failedTables = tables.filter((t) => counts[t] === null);
    checks.push({
      name: 'table_counts',
      status: failedTables.length ? 'error' : 'ok',
      detail: failedTables.length ? `failed: ${failedTables.join(', ')}` : 'all counts ok',
    });
  } else {
    checks.push({ name: 'table_counts', status: 'error', detail: 'database not connected' });
  }

  return NextResponse.json({ checks, env: envPresence, counts });
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/diagnostics", method: "GET" });
