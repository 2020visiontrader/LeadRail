import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireAuth, errorResponse, badRequest } from '@/lib/http';
import { generateImage, geminiConfigured } from '@/lib/ai/gemini';
import { insertCampaignAsset, dbReady } from '@/lib/db';

export const dynamic = 'force-dynamic';

// POST /api/generate/image  (admin/account-scoped, on-demand only)
// body: { prompt, caption?, aspect?, accountId?, campaignId? }
// Generates ONE static image (Nano Banana). Saves it under /public/generated and
// returns its URL. Persists a campaign_assets row ONLY when campaignId+accountId
// are provided — otherwise it's an ad-hoc admin asset, nothing is written to DB.
export async function POST(request: NextRequest) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  if (!geminiConfigured()) return NextResponse.json({ error: 'not_configured', provider: 'gemini' }, { status: 409 });

  let body: any;
  try {
    body = await request.json();
  } catch {
    return badRequest('invalid JSON body');
  }
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
    if (body.campaignId && body.accountId && dbReady()) {
      asset = await insertCampaignAsset({
        campaign_id: body.campaignId,
        account_id: body.accountId,
        url,
        ai_analysis: { caption: body.caption ?? null, prompt: body.prompt },
      });
    }
    return NextResponse.json({ url, mimeType: img.mimeType, asset }, { status: 201 });
  } catch (error: any) {
    if (error?.code === 'not_configured') return NextResponse.json({ error: 'not_configured' }, { status: 409 });
    if (error?.code === 'auth') return NextResponse.json({ error: 'gemini_auth_failed' }, { status: 502 });
    return errorResponse(error);
  }
}
