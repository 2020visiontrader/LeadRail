import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/http';
import { geminiConfigured, geminiModels } from '@/lib/ai/gemini';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { error } = await requireSession(request);
  if (error) return error;
  return NextResponse.json({
    gemini: {
      configured: geminiConfigured(),
      text_model: geminiModels.text,
      image_model: geminiModels.image,
    },
    video: { enabled: false, note: 'static images only for now' },
  });
}
