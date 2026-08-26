import { withApi, requireSession, errorResponse, badRequest } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { supabase, dbReady } from '@/lib/db';

export const dynamic = 'force-dynamic';

const TRIGGERS = ['comment_received', 'dm_received', 'mention'];
const ACTIONS = ['reply', 'hide', 'notify', 'tag_lead'];

async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return NextResponse.json({ automations: [] });
  try {
    const { data, error: e } = await supabase
      .from('social_automations').select('*')
      .eq('account_id', session.accountId)
      .order('created_at', { ascending: false }).limit(100);
    if (e) throw e;
    return NextResponse.json({ automations: data || [] });
  } catch (e) {
    return errorResponse(e);
  }
}

// POST — create a rule. ALWAYS disabled, whatever the body says.
//
// This mirrors the capability layer deliberately: creating a rule that can act
// on your behalf and arming it are two separate decisions, and letting the
// create call arm it would collapse them into one. A UI that could pass
// enabled:true would be a way around the same gate the assistant is held to.
async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const b = await request.json();
    if (!b?.platform || !b?.externalId) return badRequest('platform and account are required');
    if (!TRIGGERS.includes(b.trigger)) return badRequest(`trigger must be one of ${TRIGGERS.join(', ')}`);
    if (!ACTIONS.includes(b.action)) return badRequest(`action must be one of ${ACTIONS.join(', ')}`);
    if (b.action === 'reply' && !String(b.template || '').trim()) {
      return badRequest('a reply rule needs a message template');
    }
    const cap = Number(b.dailyCap) || 25;
    if (cap < 1 || cap > 200) return badRequest('the daily limit must be between 1 and 200');

    const { data, error: e } = await supabase.from('social_automations').insert([{
      account_id: session.accountId,
      platform: b.platform,
      external_id: b.externalId,
      trigger: b.trigger,
      match: { keywords: Array.isArray(b.keywords) ? b.keywords : [], regex: b.regex || undefined },
      action: b.action,
      template: b.template || null,
      daily_cap: cap,
      enabled: false,
    }]).select('*').single();
    if (e) throw e;
    return NextResponse.json({ automation: data }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

export const GET = withApi(GET__impl as any, { route: '/api/social-automations', method: 'GET' });
export const POST = withApi(POST__impl as any, { route: '/api/social-automations', method: 'POST' });
