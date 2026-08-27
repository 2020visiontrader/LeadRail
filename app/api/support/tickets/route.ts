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
// NOT account-scoped, and deliberately left that way rather than patched here:
// listTickets() reads the whole support_tickets table with no account_id
// filter, and fileFailure() accepts an accountId that most callers never pass
// (most failures are not attributable to one tenant). Filtering here on
// session.accountId would silently hide the account-less rows that are most
// of the board, and would not be the fix anyway — CONSTRAINTS forbids editing
// lib/support/*.ts, so a real per-tenant board is a follow-up for whoever owns
// that file, not this route.
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
    const tickets = await listTickets({ status: status ?? undefined, limit });
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
