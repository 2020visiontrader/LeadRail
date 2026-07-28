import { NextRequest, NextResponse } from 'next/server';
import { getIntegrationStatus } from '@/lib/integrations/env';
import { dbReady } from '@/lib/db';
import { errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest) {
  try {
    const status = getIntegrationStatus();
    return NextResponse.json({
      timestamp: new Date().toISOString(),
      db_ready: dbReady(),
      integrations: status,
      ready: Object.values(status).some(Boolean),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
