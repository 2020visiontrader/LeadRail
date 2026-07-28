import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, errorResponse, badRequest } from '@/lib/http';
import { generateContentPost } from '@/lib/ai/generation';
import { geminiConfigured } from '@/lib/ai/gemini';
import { violatesWhiteLabel } from '@/lib/ai/marketing';

export const dynamic = 'force-dynamic';

// POST /api/generate/content  (admin/account-scoped, on-demand only)
// body: { venture: {name, niche?}, platform, topic, hook?, cta? }
// Returns a white-label post draft. Does NOT post or persist anything.
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
  if (!body?.venture?.name) return badRequest('venture.name is required');
  if (!body?.platform) return badRequest('platform is required');
  if (!body?.topic) return badRequest('topic is required');

  try {
    const post = await generateContentPost({
      venture: body.venture,
      platform: body.platform,
      topic: body.topic,
      hook: body.hook,
      cta: body.cta,
    });
    // Post-generation white-label assertion (belt-and-suspenders over the scrub).
    const leaks = violatesWhiteLabel(`${post.hook} ${post.post_body}`);
    return NextResponse.json({ post, white_label_ok: leaks.length === 0 });
  } catch (error: any) {
    if (error?.code === 'not_configured') return NextResponse.json({ error: 'not_configured' }, { status: 409 });
    if (error?.code === 'auth') return NextResponse.json({ error: 'gemini_auth_failed' }, { status: 502 });
    return errorResponse(error);
  }
}
