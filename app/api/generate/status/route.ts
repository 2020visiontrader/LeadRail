import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/http';
import { geminiConfigured, geminiModels } from '@/lib/ai/gemini';

export const dynamic = 'force-dynamic';

// GET /api/generate/status — which generation providers are configured.
export async function GET(request: NextRequest) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  return NextResponse.json({
    gemini: {
      configured: geminiConfigured(),
      text_model: geminiModels.text,
      image_model: geminiModels.image,
    },
    video: { enabled: false, note: 'static images only for now' },
  });
}
