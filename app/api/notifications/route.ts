import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { listNotifications, createNotification, unreadCount } from '@/lib/notifications/store';

export const dynamic = 'force-dynamic';

// GET /api/notifications?unread=1 — recent notifications + unread count.
async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return NextResponse.json({ items: [], unread: 0 });
  try {
    const unreadOnly = new URL(request.url).searchParams.get('unread') === '1';
    const [items, unread] = await Promise.all([
      listNotifications(session.accountId, { unreadOnly }),
      unreadCount(session.accountId),
    ]);
    return NextResponse.json({ items, unread });
  } catch (e) {
    return errorResponse(e);
  }
}

// POST /api/notifications — create a notification for this account.
async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const body = await request.json();
    const title = String(body?.title || '').trim();
    if (!title) return badRequest('title is required');
    const notification = await createNotification(session.accountId, {
      type: body?.type ? String(body.type) : undefined,
      title,
      body: body?.body ? String(body.body) : undefined,
      link: body?.link ? String(body.link) : undefined,
    });
    return NextResponse.json(notification, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

export const GET = withApi(GET__impl as any, { route: '/api/notifications', method: 'GET' });
export const POST = withApi(POST__impl as any, { route: '/api/notifications', method: 'POST' });
