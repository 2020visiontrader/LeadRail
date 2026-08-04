import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { parseSignedRequest } from '@/lib/social/meta-oauth';
import { deleteMetaConnectionByUserId, dbReady } from '@/lib/db';
export const dynamic = 'force-dynamic';

// Meta calls this (POST, application/x-www-form-urlencoded, field `signed_request`)
// when a user removes LeadRail from their Facebook account. Identity comes from the
// signed_request — verified with META_APP_SECRET — not a session cookie, so this
// route is listed in PUBLIC_API. We disconnect the matching Meta connection(s).
async function POST__impl(req: NextRequest) {
  let signed: string | undefined;
  try {
    const form = await req.formData();
    signed = form.get('signed_request')?.toString();
  } catch {
    // some deliveries arrive as raw body — fall back to parsing that
    const body = await req.text().catch(() => '');
    signed = new URLSearchParams(body).get('signed_request') ?? undefined;
  }

  const parsed = signed ? await parseSignedRequest(signed) : null;
  if (parsed?.user_id && dbReady()) {
    try {
      await deleteMetaConnectionByUserId(parsed.user_id);
    } catch {
      // don't fail the callback on a DB hiccup — Meta only needs a 200
    }
  }

  // Meta expects a 200 acknowledgement.
  return NextResponse.json({ success: true });
}

export const POST = withApi(POST__impl as any, { route: '/api/social/meta/deauthorize', method: 'POST' });
