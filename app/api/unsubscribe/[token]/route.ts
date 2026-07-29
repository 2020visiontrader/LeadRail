import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/db';
import { verifyTrack } from '@/lib/tracking';
import { addSuppression } from '@/lib/suppressions';

export const dynamic = 'force-dynamic';

function page(msg: string, status = 200) {
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title></head><body style="font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 24px;text-align:center;color:#111"><h1 style="font-size:20px">${msg}</h1></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
  );
}

// Public one-click unsubscribe. The token is HMAC-signed (account + contact), so
// no one can suppress an address they weren't sent a link for.
export async function GET(_req: NextRequest, { params }: { params: { token: string } }) {
  const ctx = await verifyTrack(params.token);
  if (!ctx || !ctx.a) return page('This unsubscribe link is invalid or expired.', 400);

  let email = '';
  if (ctx.c) {
    const { data } = await supabase.from('contacts').select('email').eq('id', ctx.c).maybeSingle();
    email = data?.email || '';
  }
  if (!email) return page('This unsubscribe link is invalid or expired.', 400);

  await addSuppression({ accountId: ctx.a, email, reason: 'unsubscribe', source: 'sequence' });
  // Also flip the contact status so lists reflect it immediately.
  if (ctx.c) await supabase.from('contacts').update({ status: 'unsubscribed' }).eq('id', ctx.c).eq('account_id', ctx.a);

  return page('You have been unsubscribed. You won’t receive further emails.');
}
