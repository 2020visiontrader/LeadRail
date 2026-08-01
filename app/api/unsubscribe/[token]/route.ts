import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/db';
import { verifyTrack } from '@/lib/tracking';
import { addSuppression } from '@/lib/suppressions';

export const dynamic = 'force-dynamic';

function shell(body: string, status = 200) {
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title></head><body style="font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 24px;text-align:center;color:#111">${body}</body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
  );
}

async function resolveEmail(token: string): Promise<{ accountId: string; contactId?: string; email: string } | null> {
  const ctx = await verifyTrack(token);
  if (!ctx || !ctx.a) return null;
  let email = '';
  if (ctx.c) {
    const { data } = await supabase.from('contacts').select('email').eq('id', ctx.c).maybeSingle();
    email = data?.email || '';
  }
  if (!email) return null;
  return { accountId: ctx.a, contactId: ctx.c, email };
}

async function suppress(accountId: string, contactId: string | undefined, email: string) {
  await addSuppression({ accountId, email, reason: 'unsubscribe', source: 'sequence' });
  if (contactId) await supabase.from('contacts').update({ status: 'unsubscribed' }).eq('id', contactId).eq('account_id', accountId);
}

// GET is SAFE: it only renders a confirm page. Email clients and antivirus
// scanners prefetch links, so GET must never mutate state (was auto-unsubscribing
// people who never clicked). The actual unsubscribe happens on POST below.
async function GET__impl(_req: NextRequest, { params }: { params: { token: string } }) {
  const resolved = await resolveEmail(params.token);
  if (!resolved) return shell('<h1 style="font-size:20px">This unsubscribe link is invalid or expired.</h1>', 400);
  return shell(
    `<h1 style="font-size:20px">Unsubscribe ${resolved.email}?</h1>
     <p style="color:#555">You'll stop receiving emails from us.</p>
     <form method="POST" action="/api/unsubscribe/${encodeURIComponent(params.token)}">
       <button type="submit" style="margin-top:16px;background:#111;color:#fff;border:0;border-radius:8px;padding:12px 20px;font-size:15px;cursor:pointer">Confirm unsubscribe</button>
     </form>`,
  );
}

// POST performs the unsubscribe. Supports RFC 8058 one-click (List-Unsubscribe-Post)
// and the confirm-page form above.
async function POST__impl(_req: NextRequest, { params }: { params: { token: string } }) {
  const resolved = await resolveEmail(params.token);
  if (!resolved) return shell('<h1 style="font-size:20px">This unsubscribe link is invalid or expired.</h1>', 400);
  await suppress(resolved.accountId, resolved.contactId, resolved.email);
  return shell('<h1 style="font-size:20px">You have been unsubscribed.</h1><p style="color:#555">You won’t receive further emails.</p>');
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/unsubscribe/[token]", method: "GET" });
export const POST = withApi(POST__impl as any, { route: "/api/unsubscribe/[token]", method: "POST" });
