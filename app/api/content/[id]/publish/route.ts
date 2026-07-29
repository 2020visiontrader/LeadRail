import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { schedulePostizPost } from '@/lib/integrations/postiz';
import { publishToInstagramForAccount } from '@/lib/integrations/meta';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const { id } = params;
  if (!id) return badRequest('id is required');

  // Scope the post to the caller's account so only their own posts publish.
  const { data: post, error: fetchErr } = await supabase
    .from('content_calendar')
    .select('*')
    .eq('id', id)
    .eq('account_id', session.accountId)
    .single();

  if (fetchErr || !post) {
    return NextResponse.json({ error: 'Post not found' }, { status: 404 });
  }

  const platform = String(post.platform || '').toLowerCase();
  const body = String(post.post_body || '');
  const mediaUrls: string[] = Array.isArray(post.media_urls) ? post.media_urls : [];
  const accountId = String(post.account_id || '') || undefined;

  let publishedTo = 'unknown';
  let externalId: string | undefined;

  try {
    if (['instagram', 'facebook'].includes(platform)) {
      if (!accountId) throw new Error('Post has no account_id — reconnect Meta in Settings → Integrations and re-save this post');
      const res = await publishToInstagramForAccount(accountId, {
        caption: body,
        imageUrl: mediaUrls[0],
      });
      externalId = res?.id ? String(res.id) : undefined;
      publishedTo = `Meta (${platform})`;
    } else {
      const res = await schedulePostizPost(
        {
          content: body,
          platforms: [platform as any],
          mediaUrl: mediaUrls[0],
        },
        accountId
      );
      externalId = res?.id ? String(res.id) : undefined;
      publishedTo = `Postiz (${platform})`;
    }

    await supabase
      .from('content_calendar')
      .update({ status: 'published', ...(externalId ? { postiz_id: externalId } : {}) })
      .eq('id', id)
      .eq('account_id', session.accountId);

    return NextResponse.json({ publishedTo, externalId });
  } catch (error: any) {
    const msg = String(error?.message || '');
    if (msg.includes('not set') || msg.includes('API_KEY') || msg.includes('Settings') || msg.includes('No Instagram Business')) {
      return NextResponse.json(
        { error: msg || `Connect ${platform === 'instagram' || platform === 'facebook' ? 'Meta' : 'Postiz'} in Settings → Integrations (API key missing)` },
        { status: 409 }
      );
    }
    return errorResponse(error);
  }
}
