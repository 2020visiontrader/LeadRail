import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/db';
import { verifyTrack } from '@/lib/tracking';

export const dynamic = 'force-dynamic';

// Public: records a click, then 302-redirects to the original URL (?u=).
// Only http(s) targets are honoured to avoid an open-redirect to javascript:/data:.
export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  const target = req.nextUrl.searchParams.get('u') || '';
  let safe = '';
  try {
    const parsed = new URL(target);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') safe = parsed.toString();
  } catch {
    safe = '';
  }

  try {
    const ctx = await verifyTrack(params.token);
    if (ctx) {
      await supabase.from('email_events').insert([{
        account_id: ctx.a ?? null,
        contact_id: ctx.c ?? null,
        enrollment_id: ctx.e ?? null,
        step_id: ctx.s ?? null,
        type: 'click',
        url: safe || target.slice(0, 500),
        ua: req.headers.get('user-agent')?.slice(0, 300) ?? null,
      }]);
      if (ctx.s) await supabase.rpc('increment_step_counter', { p_step: ctx.s, p_col: 'click_count' });
    }
  } catch {
    // swallow — a tracking failure must not break the recipient's click-through
  }

  if (safe) return NextResponse.redirect(safe, 302);
  return NextResponse.json({ error: 'Invalid link' }, { status: 400 });
}
