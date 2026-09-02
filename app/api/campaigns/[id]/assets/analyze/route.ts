// WHY THIS ROUTE NO LONGER ANALYSES ANYTHING. Do not restore the old body.
//
// It used to put the asset's image URL into a TEXT prompt (generateText from
// lib/ai/opencode), parse whatever JSON came back, and write the resulting
// `score` / `issues` / `recommendation` onto the asset row — flipping `status`
// to 'approved' or 'rejected' on the strength of it.
//
// A text model cannot see a URL. It never opened the image. Every score,
// every listed issue and every verdict was invented from the file name and the
// shape of the prompt, and those inventions were mutating real state: an asset
// nobody had looked at could be marked rejected and dropped from a campaign.
//
// There is no image-input (vision) path anywhere in this codebase to fix it
// with: ChatMessage in lib/ai/opencode.ts is `{ role, content: string }`, and
// generateChat in lib/ai/router.ts takes those messages with no image parts —
// nothing anywhere constructs one. Until a vision-capable model is configured
// and a real image-input path exists, the honest behaviour is to refuse. A
// route that says "not supported" costs a user one request; a route that
// invents verdicts costs them the asset.

import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/http';
export const dynamic = 'force-dynamic';

async function POST__impl(request: NextRequest, _ctx: { params: { id: string } }) {
  const { error } = await requireSession(request);
  if (error) return error;
  return NextResponse.json(
    {
      error: 'not_supported',
      message:
        'Image analysis needs a model that can actually look at the image, and no vision-capable model is configured. Nothing was scored and no asset was changed — the previous version of this endpoint judged images it had never seen.',
    },
    { status: 501 },
  );
}

// --- request logging (auto-wrapped) ---
export const POST = withApi(POST__impl as any, { route: "/api/campaigns/[id]/assets/analyze", method: "POST" });
