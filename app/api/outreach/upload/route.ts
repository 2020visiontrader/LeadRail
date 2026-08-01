import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { ATTACHMENT_BUCKET, ATTACHMENT_URL_TTL, putPrivate, signUrl } from '@/lib/storage';

export const dynamic = 'force-dynamic';

const MAX_BYTES = 15 * 1024 * 1024; // 15MB — keep decks reasonable for email

// Upload a document/image (pitch deck, one-pager, hero image) to durable
// Supabase Storage and return a public URL to attach to an outreach email.
// Files live under <account_id>/ so tenants never collide.
async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const form = await request.formData();
    const file = form.get('file') as File | null;
    if (!file) return badRequest('file is required');
    if (file.size > MAX_BYTES) return badRequest('file too large (max 15MB)');

    const buf = Buffer.from(await file.arrayBuffer());
    const safeName = (file.name || 'file').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
    const path = `${session.accountId}/${Date.now()}-${safeName}`;

    // Store in the PRIVATE attachment bucket; email links use a signed URL that
    // expires (30d) rather than a permanent public link.
    const put = await putPrivate(ATTACHMENT_BUCKET, path, buf, file.type);
    if (put.error) return errorResponse(put.error, 502, 'upload failed — is Supabase Storage enabled?');
    const signed = await signUrl(ATTACHMENT_BUCKET, path, ATTACHMENT_URL_TTL);
    if (!signed) return errorResponse('sign failed', 502, 'could not sign attachment url');

    // Record it (store the durable path so we can re-sign later; best-effort).
    await supabase.from('attachments').insert([{
      account_id: session.accountId,
      filename: file.name || safeName,
      url: path,
      mime_type: file.type || null,
      size_bytes: file.size,
    }]).then(() => {}, () => {});

    return NextResponse.json({
      url: signed,
      filename: file.name || safeName,
      mime: file.type || 'application/octet-stream',
      size: file.size,
    });
  } catch (e) {
    return errorResponse(e);
  }
}

// --- request logging (auto-wrapped) ---
export const POST = withApi(POST__impl as any, { route: "/api/outreach/upload", method: "POST" });
