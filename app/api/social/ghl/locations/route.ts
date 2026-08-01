import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { getLocations } from '@/lib/social/ghl';
import { requireSession, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

async function GET__impl(request: NextRequest) {
  const { error } = await requireSession(request);
  if (error) return error;
  try {
    const locations = await getLocations();
    return NextResponse.json(locations);
  } catch (error: any) {
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/social/ghl/locations", method: "GET" });
