import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { getIntegrationStatus } from '@/lib/integrations/env';
import { requireSession } from '@/lib/http';

export const dynamic = 'force-dynamic';

async function GET__impl(request: NextRequest) {
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

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/integrations/status", method: "GET" });
