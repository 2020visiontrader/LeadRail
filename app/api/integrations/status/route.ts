import { NextRequest, NextResponse } from 'next/server';
import { getIntegrationStatus } from '@/lib/integrations/env';

export async function GET(request: NextRequest) {
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