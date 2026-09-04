import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { generateImage, imageConfigured } from '@/lib/ai/image-router';
import { insertCampaignAsset, dbReady } from '@/lib/db';
import { uploadGenerated } from '@/lib/storage';

export const dynamic = 'force-dynamic';

async function POST__impl(request: NextRequest) {
  const { session, error: authErr } = await requireSession(request);
  if (authErr) return authErr;
  if (!imageConfigured()) return NextResponse.json({ error: 'not_configured' }, { status: 409 });

  let body: any;
  try { body = await request.json(); } catch { return badRequest('invalid JSON body'); }
  if (!body?.prompt) return badRequest('prompt is required');

  try {
    const img = await generateImage({ prompt: body.prompt, caption: body.caption, aspect: body.aspect });
    // Routed through lib/storage.ts's private, tenant-prefixed bucket — the
    // same helper the two capability call sites use — instead of the old
    // `public/generated/` path (gitignored, unauthenticated, destroyed on
    // every deploy).
    // storagePath is the stable identifier — persist THIS (never the signed
    // `url`, which expires after GENERATED_URL_TTL and would otherwise make
    // every campaign asset 404 a day after it was generated).
    const { url, storagePath } = await uploadGenerated(session.accountId, Buffer.from(img.base64, 'base64'), img.mimeType);

    let asset = null;
    // account_id is authoritative from the session, never the client body.
    if (body.campaignId && dbReady()) {
      asset = await insertCampaignAsset({
        campaign_id: body.campaignId,
        account_id: session.accountId,
        url,
        storage_path: storagePath,
        ai_analysis: { caption: body.caption ?? null, prompt: body.prompt },
      });
    }
    return NextResponse.json({ url, mimeType: img.mimeType, asset }, { status: 201 });
  } catch (error: any) {
    if (error?.code === 'not_configured') return NextResponse.json({ error: 'not_configured' }, { status: 409 });
    if (error?.code === 'auth') return NextResponse.json({ error: 'image_generation_auth_failed' }, { status: 502 });
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const POST = withApi(POST__impl as any, { route: "/api/generate/image", method: "POST" });
