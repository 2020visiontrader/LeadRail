import { NextRequest, NextResponse } from 'next/server';
import { supabase, assertBrandOwned, getVentures } from '@/lib/db';
import { requireSession, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

// Aggregate dashboard stats for one venture, or for ALL ventures the account
// owns when brandId is omitted / "all". Everything is account-scoped so one
// tenant can never read another's numbers.
export async function GET(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  const accountId = session.accountId;
  const brandParam = request.nextUrl.searchParams.get('brandId');
  const allVentures = !brandParam || brandParam === 'all';

  // Validate a single-brand request belongs to the account.
  if (!allVentures && !(await assertBrandOwned(brandParam!, accountId))) {
    return NextResponse.json({ error: 'unknown brandId' }, { status: 400 });
  }

  const scope = <T,>(q: any) => (allVentures ? q.eq('account_id', accountId) : q.eq('account_id', accountId).eq('brand_id', brandParam)) as T;

  try {
    // Contacts (non-deleted) + per-segment distribution in one pass.
    const contactsQ = supabase.from('contacts').select('segment').is('deleted_at', null);
    const { data: contactRows } = await scope<any>(contactsQ);
    const contacts = contactRows?.length || 0;
    const segments: Record<string, number> = {};
    for (const r of contactRows || []) {
      const s = r.segment || 'other';
      segments[s] = (segments[s] || 0) + 1;
    }

    // Deals: open (active), won, lost + won revenue + open pipeline value.
    const dealsQ = supabase.from('deals').select('status, amount');
    const { data: dealRows } = await scope<any>(dealsQ);
    let deals = 0, won = 0, lost = 0, revenue = 0, pipelineValue = 0;
    for (const d of dealRows || []) {
      const amt = Number(d.amount) || 0;
      if (d.status === 'won') { won++; revenue += amt; }
      else if (d.status === 'lost') { lost++; }
      else { deals++; pipelineValue += amt; }
    }

    // CVR = won deals / total contacts (leads that became customers).
    const conversionRate = contacts > 0 ? Math.round((won / contacts) * 1000) / 10 : 0;

    // Emails sent, scoped through the owning contact (email_campaigns has no brand col).
    let emailsQ = supabase
      .from('email_campaigns')
      .select('id, contacts!inner(brand_id, account_id)', { count: 'exact', head: true })
      .eq('contacts.account_id', accountId);
    if (!allVentures) emailsQ = emailsQ.eq('contacts.brand_id', brandParam);
    const { count: emails } = await emailsQ;

    return NextResponse.json({
      scope: allVentures ? 'all' : brandParam,
      contacts,
      deals,
      won,
      lost,
      conversion_rate: conversionRate,
      revenue,
      pipeline_value: pipelineValue,
      emails: emails || 0,
      segments,
      // legacy alias so any older caller that read `leads` still works
      leads: contacts,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

// Kept for callers that need the venture list alongside stats (not required).
export async function POST(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    return NextResponse.json({ ventures: await getVentures(session.accountId) });
  } catch (error) {
    return errorResponse(error);
  }
}
