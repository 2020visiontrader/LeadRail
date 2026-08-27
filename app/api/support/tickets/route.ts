import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, withApi } from '@/lib/http';
import { listTickets, TICKET_COLUMNS, type TicketStatus } from '@/lib/support/tickets';

export const dynamic = 'force-dynamic';

// GET /api/support/tickets — the board's data source.
//
// Owner/admin only, same gate as /api/logs: this is a feed of production
// failures and internal diagnosis, not something a client account should see
// about itself or (worse) about other tenants.
//
// Account-scoped via session.accountId: listTickets() requires an accountId
// and returns that tenant's tickets plus the account-less platform tickets
// (account_id IS NULL) that are most of the board — see the filter's own
// comment in lib/support/tickets.ts. `session.role === 'owner'` is per-account,
// not platform-wide, so passing session.accountId here (rather than nothing,
// or another tenant's id) is what keeps an owner of account A from seeing
// account B's tickets.
async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (session.role !== 'owner' && session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    const sp = request.nextUrl.searchParams;
    const status = sp.get('status') as TicketStatus | null;
    const limitParam = sp.get('limit');
    const limit = limitParam ? Math.min(parseInt(limitParam, 10), 500) : undefined;
    const tickets = await listTickets(session.accountId, { status: status ?? undefined, limit });
    // TICKET_COLUMNS travels with every list response rather than the client
    // importing it directly from lib/support/tickets — that module pulls in
    // lib/db (a server-only Supabase client with a service-role key) at
    // module scope, which is fine to run in a route handler but has no
    // business being bundled into client JS just to read a column list.
    // Sending it over the wire keeps the board driven by the same constant
    // (see TICKET_COLUMNS's own comment: "so the UI cannot drift from the
    // database's own CHECK constraint") without that import.
    return NextResponse.json({ tickets, columns: TICKET_COLUMNS });
  } catch (err) {
    return errorResponse(err);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: '/api/support/tickets', method: 'GET' });
