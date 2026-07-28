import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  return NextResponse.json({ message: 'campaigns GET endpoint' });
}

export async function POST(request: NextRequest) {
  return NextResponse.json({ message: 'campaigns POST endpoint' }, { status: 201 });
}