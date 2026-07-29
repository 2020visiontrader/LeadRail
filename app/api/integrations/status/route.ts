import { NextRequest, NextResponse } from 'next/server';
import { getIntegrationStatus } from '@/lib/integrations/env';
import { requireSession } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { error } = await requireSession(request);
  if (error) return error;
  try {
    const status = getIntegrationStatus();
    return NextResponse.json({
      timestamp: new Date(),
      integrations: status,
      ready: Object.values(status).some((v) => v === true),
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
