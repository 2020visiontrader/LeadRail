import { NextRequest, NextResponse } from 'next/server';
import { getContacts } from '@/lib/db';

export async function GET(request: NextRequest) {
  const brandId = request.nextUrl.searchParams.get('brandId');
  const page = parseInt(request.nextUrl.searchParams.get('page') || '0');
  const limit = parseInt(request.nextUrl.searchParams.get('limit') || '30');
  
  try {
    if (!brandId) throw new Error('brandId required');
    const offset = page * limit;
    const data = await getContacts(brandId, limit, offset);
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { supabase } = await import('@/lib/db');
    const { data, error } = await supabase.from('contacts').insert([body]).select();
    if (error) throw error;
    return NextResponse.json(data[0], { status: 201 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}