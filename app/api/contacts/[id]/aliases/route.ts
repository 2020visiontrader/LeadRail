import { NextRequest, NextResponse } from 'next/server';
import { getContactAliases } from '@/lib/crm';
import { errorResponse } from '@/lib/http';
export const dynamic = 'force-dynamic';
export async function GET(_r: NextRequest, { params }: { params: { id: string } }) {
  try { return NextResponse.json(await getContactAliases(params.id)); }
  catch (error) { return errorResponse(error); }
}
