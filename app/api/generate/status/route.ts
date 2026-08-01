import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/http';
import { geminiConfigured, geminiModels } from '@/lib/ai/gemini';
import { opencodeConfigured, opencodeModel } from '@/lib/ai/opencode';

export const dynamic = 'force-dynamic';

async function GET__impl(request: NextRequest) {
  const { error } = await requireSession(request);
  if (error) return error;
  return NextResponse.json({
    // Text + multi-turn chat run on OpenCode Go (DeepSeek V4 Pro).
    text: {
      provider: 'opencode',
      configured: opencodeConfigured(),
      model: opencodeModel,
    },
    // Static image generation stays on Gemini (Nano Banana).
    image: {
      provider: 'gemini',
      configured: geminiConfigured(),
      model: geminiModels.image,
    },
    video: { enabled: false, note: 'static images only for now' },
  });
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/generate/status", method: "GET" });
