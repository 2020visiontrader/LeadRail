import { NextRequest, NextResponse } from 'next/server';
import { getLocations } from '@/lib/social/ghl';
import { requireSession, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { error } = await requireSession(request);
  if (error) return error;
  try {
    const locations = await getLocations();
    return NextResponse.json(locations);
  } catch (error: any) {
    return errorResponse(error);
  }
}
