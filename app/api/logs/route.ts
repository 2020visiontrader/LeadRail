import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, withApi } from '@/lib/http';
import { supabase } from '@/lib/db';

export const dynamic = 'force-dynamic';

const LEVELS = ['info', 'warn', 'error'] as const;

// Read the durable application log. Owner/admin only. Scoped to the caller's
// account; owners additionally see system rows (account_id NULL — cron and
// pre-auth errors that carry no tenant).
async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (session.role !== 'owner' && session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    const sp = request.nextUrl.searchParams;
    const level = sp.get('level');                       // info | warn | error
    const route = sp.get('route');                       // exact route match
    const search = sp.get('q');                          // message substring
    const sinceMin = parseInt(sp.get('sinceMinutes') || '', 10);
    const limit = Math.min(parseInt(sp.get('limit') || '100', 10), 500);
    const sinceIso =
      Number.isFinite(sinceMin) && sinceMin > 0
        ? new Date(Date.now() - sinceMin * 60_000).toISOString()
        : null;

    // ONE construction of the window, shared by the list query and the count
    // queries so the two cannot drift. Deliberately excludes the LEVEL filter
    // and the LIMIT: the counts describe the window the user is looking at,
    // not the page or the tab. (They used to be tallied from the returned
    // rows, which made `warn` structurally 0 whenever the Error tab was
    // selected — the panel showed "0 warns" against 61 real ones.)
    const scoped = <T,>(q: T): T => {
      let b = q as any;
      b =
        session.role === 'owner'
          ? b.or(`account_id.eq.${session.accountId},account_id.is.null`)
          : b.eq('account_id', session.accountId);
      if (route) b = b.eq('route', route);
      // The search filter DOES apply to the counts: a headline that ignored
      // the user's search would be a different wrong number.
      if (search) b = b.ilike('message', `%${search}%`);
      if (sinceIso) b = b.gte('created_at', sinceIso);
      return b as T;
    };

    let listQuery = scoped(supabase.from('app_logs').select('*'));
    if (level) listQuery = (listQuery as any).eq('level', level);
    const { data, error: dbErr } = await listQuery.order('created_at', { ascending: false }).limit(limit);
    if (dbErr) throw dbErr;

    // PostgREST has no GROUP BY, so the rollup is one head-count per level,
    // issued concurrently.
    const countResults = await Promise.all(
      LEVELS.map((l) =>
        (scoped(supabase.from('app_logs').select('id', { count: 'exact', head: true })) as any).eq('level', l),
      ),
    );

    // A count that could not be READ is not a count of zero. Same rule as
    // lib/outreach/history.ts: report it as unavailable and let the UI say so,
    // rather than rendering a confident 0 that hides an incident.
    const countsUnavailable = countResults.some((r: any) => r?.error || typeof r?.count !== 'number');
    const counts = countsUnavailable
      ? null
      : (Object.fromEntries(LEVELS.map((l, i) => [l, (countResults[i] as any).count as number])) as Record<
          string,
          number
        >);

    return NextResponse.json({
      logs: data || [],
      counts,
      ...(countsUnavailable ? { countsUnavailable: true as const } : {}),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: '/api/logs', method: 'GET' });
