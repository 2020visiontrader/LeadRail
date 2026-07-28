import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  return NextResponse.json({ message: 'content GET endpoint' });
}

export async function POST(request: NextRequest) {
  return NextResponse.json({ message: 'content POST endpoint' }, { status: 201 });
}