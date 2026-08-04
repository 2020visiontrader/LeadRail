import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { parseSignedRequest, publicBase } from '@/lib/social/meta-oauth';
import { deleteMetaConnectionByUserId, dbReady } from '@/lib/db';
export const dynamic = 'force-dynamic';

// Meta's Data Deletion Request callback. Posts `signed_request` (verified with
// META_APP_SECRET); we delete the user's Meta connection data and return the
// JSON shape Meta requires: { url, confirmation_code }. The url is a human-
// readable status page; the code lets the user confirm the request.
async function POST__impl(req: NextRequest) {
  let signed: string | undefined;
  try {
    const form = await req.formData();
    signed = form.get('signed_request')?.toString();
  } catch {
    const body = await req.text().catch(() => '');
    signed = new URLSearchParams(body).get('signed_request') ?? undefined;
  }

  const parsed = signed ? await parseSignedRequest(signed) : null;
  if (!parsed?.user_id) {
    return NextResponse.json({ error: 'invalid signed_request' }, { status: 400 });
  }

  if (dbReady()) {
    try {
      await deleteMetaConnectionByUserId(parsed.user_id);
    } catch {
      // deletion is best-effort here; status page reflects final state
    }
  }

  const code = `del_${parsed.user_id}_${parsed.issued_at ?? ''}`;
  return NextResponse.json({
    url: `${publicBase()}/data-deletion?code=${encodeURIComponent(code)}`,
    confirmation_code: code,
  });
}

export const POST = withApi(POST__impl as any, { route: '/api/social/meta/data-deletion', method: 'POST' });
