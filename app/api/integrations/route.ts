import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  return NextResponse.json({ message: 'integrations GET endpoint' });
}

export async function POST(request: NextRequest) {
  return NextResponse.json({ message: 'integrations POST endpoint' }, { status: 201 });
}