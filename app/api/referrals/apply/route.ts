import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { attributeSignup, REF_COOKIE } from '@/lib/referrals';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// POST { code? } — attribute the current account to a referral code (the
// "typed a code" path). Falls back to the ma_ref cookie. Guards self-referral
// and re-attribution in the library. This is the hook a real signup flow calls.
export async function POST(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  let typedCode: string | undefined;
  try { typedCode = (await request.json())?.code; } catch { /* optional */ }
  const cookieCode = request.cookies.get(REF_COOKIE)?.value || null;
  if (!typedCode && !cookieCode) return badRequest('no referral code provided');
  try {
    const result = await attributeSignup({
      referredAccountId: session.accountId,
      referredEmail: session.email,
      typedCode: typedCode || null,
      cookieCode,
    });
    return NextResponse.json(result);
  } catch (e) { return errorResponse(e); }
}
