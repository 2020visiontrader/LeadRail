import { NextRequest, NextResponse } from 'next/server';
import { dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { exportAccountData, logPrivacyEvent } from '@/lib/privacy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/account/export — download every row this account owns as one JSON
// bundle (GDPR/CCPA "right to access"). Account-scoped; secrets are scrubbed.
export async function GET(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not configured');
  try {
    const bundle = await exportAccountData(session.accountId);
    await logPrivacyEvent(session.accountId, session.email, 'data_exported', session.accountId);
    const stamp = new Date().toISOString().slice(0, 10);
    return new NextResponse(JSON.stringify(bundle, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="leadrail-export-${stamp}.json"`,
      },
    });
  } catch (e) { return errorResponse(e); }
}
