import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, withApi } from '@/lib/http';
import { supabase } from '@/lib/db';

export const dynamic = 'force-dynamic';

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
    const q = sp.get('q');                               // message substring
    const sinceMin = parseInt(sp.get('sinceMinutes') || '', 10);
    const limit = Math.min(parseInt(sp.get('limit') || '100', 10), 500);

    let query = supabase.from('app_logs').select('*');
    query =
      session.role === 'owner'
        ? query.or(`account_id.eq.${session.accountId},account_id.is.null`)
        : query.eq('account_id', session.accountId);
    if (level) query = query.eq('level', level);
    if (route) query = query.eq('route', route);
    if (q) query = query.ilike('message', `%${q}%`);
    if (Number.isFinite(sinceMin) && sinceMin > 0) {
      query = query.gte('created_at', new Date(Date.now() - sinceMin * 60_000).toISOString());
    }
    const { data, error: dbErr } = await query.order('created_at', { ascending: false }).limit(limit);
    if (dbErr) throw dbErr;

    // Lightweight rollup so the UI can headline error/warn counts.
    const counts = { info: 0, warn: 0, error: 0 } as Record<string, number>;
    for (const r of data || []) counts[r.level] = (counts[r.level] || 0) + 1;
    return NextResponse.json({ logs: data || [], counts });
  } catch (err) {
    return errorResponse(err);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: '/api/logs', method: 'GET' });
