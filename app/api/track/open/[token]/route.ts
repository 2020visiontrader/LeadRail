import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/db';
import { verifyTrack } from '@/lib/tracking';

export const dynamic = 'force-dynamic';

// 1x1 transparent GIF.
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function pixelResponse() {
  return new NextResponse(PIXEL, {
    status: 200,
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      'Content-Length': String(PIXEL.length),
    },
  });
}

// Public: called by the email client when the pixel loads. Records an open,
// then always returns the pixel (never leaks whether the token was valid).
export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  try {
    const ctx = await verifyTrack(params.token);
    if (ctx) {
      await supabase.from('email_events').insert([{
        account_id: ctx.a ?? null,
        contact_id: ctx.c ?? null,
        enrollment_id: ctx.e ?? null,
        step_id: ctx.s ?? null,
        type: 'open',
        ua: req.headers.get('user-agent')?.slice(0, 300) ?? null,
      }]);
      if (ctx.s) await supabase.rpc('increment_step_counter', { p_step: ctx.s, p_col: 'open_count' });
    }
  } catch {
    // swallow — tracking must never error to the recipient
  }
  return pixelResponse();
}
