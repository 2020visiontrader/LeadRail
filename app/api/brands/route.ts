import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/db';
import { errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest) {
  try {
    const { data, error } = await supabase.from('brands').select('*').eq('active', true).order('name');
    if (error) throw error;
    return NextResponse.json(data);
  } catch (error) {
    return errorResponse(error);
  }
}
