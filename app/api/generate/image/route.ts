import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { generateImage, imageConfigured } from '@/lib/ai/image-router';
import { insertCampaignAsset, dbReady } from '@/lib/db';

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
    const ext = img.mimeType.includes('jpeg') ? 'jpg' : 'png';
    const filename = `${randomUUID()}.${ext}`;
    const dir = join(process.cwd(), 'public', 'generated');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, filename), Buffer.from(img.base64, 'base64'));
    const url = `/generated/${filename}`;

    let asset = null;
    // account_id is authoritative from the session, never the client body.
    if (body.campaignId && dbReady()) {
      asset = await insertCampaignAsset({
        campaign_id: body.campaignId,
        account_id: session.accountId,
        url,
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
