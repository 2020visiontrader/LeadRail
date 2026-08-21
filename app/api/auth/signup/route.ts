import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/db';
import { hashPassword } from '@/lib/password';
import { signSession, SESSION_COOKIE, SESSION_MAX_AGE } from '@/lib/session';
import { rateLimit, clientIp } from '@/lib/rate-limit';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// POST /api/auth/signup — create an account and sign in.
//
// The landing page has promised "Start free" since launch with nothing behind
// it: there was no /signup route and no way to create an account, so every
// visitor who clicked the primary CTA hit a dead end.
//
// GATED BY DEFAULT. SIGNUPS_OPEN must be explicitly set to '1' to allow public
// registration. This is not caution for its own sake — a new account can reach
// capabilities that spend real money (ad budget, sourcing credits), so opening
// registration is a business decision with a bill attached, not a deploy-time
// default. With the flag unset the route returns 403 and the page invites the
// visitor to request access instead, which is a working front door either way.
const SIGNUPS_OPEN = process.env.SIGNUPS_OPEN === '1';

// Deliberately modest: long enough to matter, not so strict that it pushes
// people into reusing a password they already have written down.
const MIN_PASSWORD = 10;

function looksLikeEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(v);
}

async function POST__impl(request: NextRequest) {
  if (!SIGNUPS_OPEN) {
    return NextResponse.json(
      { error: 'Public signup is not open yet. Request access and we will set you up.', code: 'signups_closed' },
      { status: 403 },
    );
  }

  // Tight: account creation is the expensive side effect on this route.
  const limited = rateLimit(`signup:${clientIp(request)}`, 3, 60 * 60_000);
  if (!limited.ok) {
    return NextResponse.json(
      { error: 'Too many attempts. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const email = String(body?.email ?? '').trim().toLowerCase().slice(0, 254);
  const password = String(body?.password ?? '');
  const companyName = String(body?.company ?? '').trim().slice(0, 160);

  if (!looksLikeEmail(email)) return NextResponse.json({ error: 'Please enter a valid email address.' }, { status: 400 });
  if (password.length < MIN_PASSWORD) {
    return NextResponse.json({ error: `Password must be at least ${MIN_PASSWORD} characters.` }, { status: 400 });
  }

  // An email already in account_members belongs to someone. Reply with the SAME
  // wording the caller would get for any other failure to create — enumerating
  // which addresses exist turns this endpoint into a membership oracle.
  const { data: existing, error: lookupErr } = await supabase
    .from('account_members').select('email').eq('email', email).maybeSingle();
  if (lookupErr) {
    log.error('signup: lookup failed', lookupErr);
    return NextResponse.json({ error: 'Could not create the account. Please try again.' }, { status: 500 });
  }
  if (existing) {
    return NextResponse.json({ error: 'Could not create that account. Try signing in instead.' }, { status: 409 });
  }

  const { data: account, error: accErr } = await supabase
    .from('accounts')
    .insert({ name: companyName || email.split('@')[1] || 'New account', plan: 'free' })
    .select('id')
    .single();
  if (accErr || !account) {
    log.error('signup: account insert failed', accErr);
    return NextResponse.json({ error: 'Could not create the account. Please try again.' }, { status: 500 });
  }

  const { error: memErr } = await supabase.from('account_members').insert({
    account_id: account.id,
    email,
    role: 'owner',
    password_hash: hashPassword(password),
    last_login_at: new Date().toISOString(),
  });
  if (memErr) {
    // Roll the account back rather than leaving an orphan nobody can sign into.
    await supabase.from('accounts').delete().eq('id', account.id);
    log.error('signup: member insert failed', memErr);
    return NextResponse.json({ error: 'Could not create the account. Please try again.' }, { status: 500 });
  }

  const token = await signSession({
    email, accountId: account.id, role: 'owner', exp: Date.now() + SESSION_MAX_AGE * 1000,
  });
  const res = NextResponse.json({ ok: true, email, role: 'owner' });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: SESSION_MAX_AGE,
  });
  log.info('signup: account created', { accountId: account.id });
  return res;
}

export const POST = withApi(POST__impl as any, { route: '/api/auth/signup', method: 'POST' });
