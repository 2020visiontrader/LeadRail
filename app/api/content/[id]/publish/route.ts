import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/db';
import { requireAuth, errorResponse, badRequest } from '@/lib/http';
import { schedulePostizPost } from '@/lib/integrations/postiz';
import { publishToInstagramForAccount } from '@/lib/integrations/meta';

export const dynamic = 'force-dynamic';

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const unauthorized = requireAuth(_request);
  if (unauthorized) return unauthorized;

  const { id } = params;
  if (!id) return badRequest('id is required');

  const { data: post, error: fetchErr } = await supabase
    .from('content_calendar')
    .select('*')
    .eq('id', id)
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
      // Resolves the account-scoped token + ig_user_id from integration_connections.
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
      .eq('id', id);

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
