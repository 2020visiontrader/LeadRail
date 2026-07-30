import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { generateContentPost } from '@/lib/ai/generation';
import { opencodeConfigured } from '@/lib/ai/opencode';
import { violatesWhiteLabel } from '@/lib/ai/marketing';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const { error: authErr } = await requireSession(request);
  if (authErr) return authErr;
  if (!opencodeConfigured()) return NextResponse.json({ error: 'not_configured', provider: 'opencode' }, { status: 409 });

  let body: any;
  try { body = await request.json(); } catch { return badRequest('invalid JSON body'); }
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
    const leaks = violatesWhiteLabel(`${post.hook} ${post.post_body}`);
    return NextResponse.json({ post, white_label_ok: leaks.length === 0 });
  } catch (error: any) {
    if (error?.code === 'not_configured') return NextResponse.json({ error: 'not_configured' }, { status: 409 });
    if (error?.code === 'auth') return NextResponse.json({ error: 'opencode_auth_failed' }, { status: 502 });
    return errorResponse(error);
  }
}
