import { withApi, requireSession } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// GIT_SHA is exported by the service entrypoint at process start (`git rev-parse
// --short HEAD`), so this always reflects whatever build is actually running —
// no manual env var to remember to bump on deploy.
async function GET__impl(request: NextRequest) {
  const { error } = await requireSession(request);
  if (error) return error;
  return NextResponse.json({ sha: process.env.GIT_SHA || null });
}

export const GET = withApi(GET__impl as any, { route: '/api/version', method: 'GET' });
