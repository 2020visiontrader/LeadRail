import { NextRequest, NextResponse } from 'next/server';
import { getCampaignAssets, updateCampaignAsset } from '@/lib/crm';
import { generateText, opencodeConfigured } from '@/lib/ai/opencode';
import { requireSession, errorResponse } from '@/lib/http';
export const dynamic = 'force-dynamic';
// Admin-only, on-demand. Analyzes each raw static image asset for ad-quality issues.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!opencodeConfigured()) return NextResponse.json({ error: 'not_configured', message: 'Connect OpenCode to analyze assets' }, { status: 409 });
  try {
    const assets = (await getCampaignAssets(params.id, session.accountId)).filter((a: any) => a.kind === 'image' && a.status === 'raw');
    const results: any[] = [];
    for (const a of assets) {
      const prompt = `You are an ad-creative QA reviewer. For the static ad image at ${a.url}, return a JSON object {"score":0-100,"issues":[..],"recommendation":"approve|cleanup|reject"} judging composition, text legibility, brand safety, and platform ad-policy fit. Output JSON only.`;
      let analysis: any = { note: 'analysis unavailable' };
      try { analysis = JSON.parse((await generateText({ prompt })).replace(/```json|```/g, '').trim()); } catch { /* keep raw */ }
      const status = analysis.recommendation === 'reject' ? 'rejected' : analysis.recommendation === 'approve' ? 'approved' : 'raw';
      await updateCampaignAsset(a.id, { ai_analysis: analysis, status });
      results.push({ id: a.id, status, analysis });
    }
    return NextResponse.json({ analyzed: results.length, results });
  } catch (error) { return errorResponse(error); }
}
