import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

const BUCKET = 'outreach-attachments';
const MAX_BYTES = 15 * 1024 * 1024; // 15MB — keep decks reasonable for email

// Upload a document/image (pitch deck, one-pager, hero image) to durable
// Supabase Storage and return a public URL to attach to an outreach email.
// Files live under <account_id>/ so tenants never collide.
export async function POST(request: NextRequest) {
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

    // Ensure the bucket exists (idempotent — ignore "already exists").
    await supabase.storage.createBucket(BUCKET, { public: true }).catch(() => {});

    const up = await supabase.storage.from(BUCKET).upload(path, buf, {
      contentType: file.type || 'application/octet-stream',
      upsert: true,
    });
    if (up.error) return errorResponse(up.error, 502, 'upload failed — is Supabase Storage enabled?');

    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);

    // Record it as an attachment row (best-effort — table may vary by env).
    await supabase.from('attachments').insert([{
      account_id: session.accountId,
      filename: file.name || safeName,
      url: pub.publicUrl,
      mime_type: file.type || null,
      size_bytes: file.size,
    }]).then(() => {}, () => {});

    return NextResponse.json({
      url: pub.publicUrl,
      filename: file.name || safeName,
      mime: file.type || 'application/octet-stream',
      size: file.size,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
